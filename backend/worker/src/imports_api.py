"""历史订单批量导入（C29）—— Worker 内核卫星模块。

设计 = docs/IMPORT_ORDERS_PLAN_2026-10-23.md 第 2/3/4 节。

为什么单独一个卫星模块
----------------------
导入是「一次录多张历史订单」的批量入口，与单张订单 CRUD 的粒度 / 错误模型都不同：
- 单张订单是「一条请求 = 一个对象」，错误直接 422 抛字段；
- 批量导入是「一行 = 一个对象」，错误必须**逐行收集**（前端要标红并说明哪一行为什么
  不行），且预览必须**零写入**、提交必须**全有全无**。
放进 main.py 会把这套行级错误模型混进单对象路由，故按 ws_products.py 的卫星方式挂载。

口径（设计第 1 节裁决，逐条可复核）
------------------------------------
- 文件：CSV（UTF-8，含表头；兼容 Excel 导出的 UTF-8-BOM），stdlib csv。
- 客户：表单必选；归属闸门复用 main.py:_doc_customer（存在 / 未软删 / 可见 / 同团队 → 404）。
- source_type='direct'、inquiry_id=NULL、quote_id=NULL（历史补录没有询盘父对象）。
- **保留 CSV 的 order_no**（不走 _next_customer_doc_no）：历史单号是业务事实。
- 状态缺省 pending、币种缺省 USD、金额缺省 **NULL（不伪造 0）**（设计 D-5/D-6/D-7）。
- 原子性：预览不写库；提交单事务，任一错误行 → 422（零写入），撞库 → 409（整批回滚）。
- 权限：登录用户即可（与 POST /orders 一致）；API token 未声明 scope ⇒ 门面 403
  （有意，设计第 1 节第 9 条：/api/v1/imports 不登记 token scope）。

错误信封沿用仓库既有口径：FastAPI HTTPException(detail={...}) ⇒ HTTP body 恒为
{"detail": {"error": ..., "code": ..., ...}}。
"""
from __future__ import annotations

import csv
import io
from decimal import Decimal, InvalidOperation
from typing import Any, Optional

from fastapi import Depends, File, Form, HTTPException, Request, UploadFile

from kaas_common.domain.enums import CURRENCY, ORDER_STATUS
from pricing_rules import parse_date

import main as _main

app = _main.app
_get_current_user = _main._get_current_user
_acquire = _main._acquire
_doc_customer = _main._doc_customer
DEFAULT_TENANT = _main.DEFAULT_TENANT

# CSV 列（表头归一：去首尾空格 + 大小写不敏感 ⇒ 这里是小写规范名）
COLUMNS = ("order_no", "order_date", "status", "currency", "total_amount", "notes")
REQUIRED_COLUMNS = ("order_no", "order_date")
ORDER_NO_MAX = 64
NOTES_MAX = 2000
# 上限只为防「一次上传把 Worker 内存打爆」；与业务校验无关（错误码仍走 422）。
_MAX_UPLOAD_MB = 10

# 列名单唯一真源 = main.py:4308-4316 的 INSERT 列（逐字同序），仅把逐行可变的列换成
# 占位符：status / currency / total_amount / order_date / notes 按行；
# source_type='direct'、inquiry_id / quote_id / delivery_date / amount_breakdown 为 NULL；
# created_by = owner_id = user.id、owner_scope='private'、team_id = customer.team_id。
_ORDERS_INSERT = """INSERT INTO orders
       (tenant_id, order_no, customer_id, customer_name, status, currency,
        total_amount, order_date, delivery_date, notes, quote_id,
        created_by, owner_id, owner_scope, team_id,
        incoterm, payment_terms, port_of_loading, port_of_destination,
        shipping_marks, country_of_origin, amount_breakdown,
        source_type, source_channel, inquiry_id)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULL,$9,NULL,$10,$11,'private',$12,
        NULL,NULL,NULL,NULL,NULL,NULL,NULL,'direct',NULL,NULL)
RETURNING id"""

# 库内撞号预查（tenant 口径；order_no 在 DB 上是全局 UNIQUE，跨租户竞态由
# _is_unique_violation 兜底转 409，见 create_import_orders 的注释）。
_SELECT_EXISTING = (
    "SELECT order_no FROM orders WHERE tenant_id=$1 AND order_no = ANY($2::text[])"
)


# ── 错误构造（统一信封）────────────────────────────────────────────────────────

def _err(status: int, code: str, message: str, **extra: Any) -> HTTPException:
    """HTTPException(detail={error,code,detail,...}) —— 与仓库既有内核同信封。"""
    detail: dict[str, Any] = {
        "error": "conflict" if status == 409 else "validation",
        "code": code,
        "detail": message,
    }
    detail.update(extra)
    return HTTPException(status_code=status, detail=detail)


# ── 上传 / 解析 ───────────────────────────────────────────────────────────────

async def _read_upload(file: UploadFile) -> bytes:
    """读上传字节 + 空文件/大小上限。"""
    data = await file.read()
    if not data:
        raise _err(422, "IMPORT_EMPTY_FILE", "上传的文件是空的")
    if len(data) > _MAX_UPLOAD_MB * 1024 * 1024:
        raise _err(422, "IMPORT_FILE_TOO_LARGE",
                   "文件过大（上限 %d MB）" % _MAX_UPLOAD_MB)
    return data


def _decode_csv(data: bytes) -> str:
    """UTF-8（含 BOM）。Excel 另存的 GBK 文件在这里明确报错，不猜编码。"""
    try:
        return data.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise _err(422, "IMPORT_BAD_ENCODING",
                   "CSV 必须是 UTF-8 编码（Excel 请另存为「CSV UTF-8」）")


def _parse_csv(text: str) -> tuple[list[str], list[str], list[dict[str, str]]]:
    """CSV 文本 → (文件里的规范列, warnings, 原始行值)。

    表头归一：去首尾空格 + 大小写不敏感；未知列忽略 + warning；
    空行跳过（Excel 常见尾部空行）；缺表头 / 缺必填列 → 422。
    """
    reader = csv.reader(io.StringIO(text))
    header: Optional[list[str]] = None
    body: list[list[str]] = []
    for cells in reader:
        if not any((c or "").strip() for c in cells):
            continue
        if header is None:
            header = [str(c) for c in cells]
        else:
            body.append([str(c) for c in cells])

    if header is None:
        raise _err(422, "IMPORT_NO_HEADER", "CSV 缺少表头行（第一行必须是列名）")

    index_by_column: dict[int, str] = {}
    warnings: list[str] = []
    for i, cell in enumerate(header):
        name = (cell or "").strip().lower()
        if not name:
            continue
        if name in COLUMNS:
            if name in index_by_column.values():
                warnings.append("表头列重复，按第一次出现取值：" + name)
                continue
            index_by_column[i] = name
        else:
            warnings.append("未知列已忽略：" + name)

    columns = [name for _, name in sorted(index_by_column.items())]
    missing = [c for c in REQUIRED_COLUMNS if c not in columns]
    if missing:
        raise _err(422, "IMPORT_MISSING_COLUMNS",
                   "缺少必填列：" + "、".join(missing), columns=missing)

    raw_rows: list[dict[str, str]] = []
    for cells in body:
        raw_rows.append({
            name: (cells[i].strip() if i < len(cells) else "")
            for i, name in index_by_column.items()
        })
    return columns, warnings, raw_rows


# ── 逐行校验 ─────────────────────────────────────────────────────────────────

def _validate_row(values: dict[str, str]) -> tuple[dict[str, Any], dict[str, Any], list[str]]:
    """一行 → (内部值, 对外 data, errors)。

    内部值保留 datetime / Decimal（写库用）；对外 data 是 JSON 形状
    （日期 'YYYY-MM-DD'、金额 number）。错误不抛异常 —— 批量导入必须一次说清所有行。
    """
    errors: list[str] = []

    order_no = (values.get("order_no") or "").strip()
    if not order_no:
        errors.append("order_no 必填")
    elif len(order_no) > ORDER_NO_MAX:
        errors.append("order_no 超过 %d 字符" % ORDER_NO_MAX)

    raw_date = (values.get("order_date") or "").strip()
    order_date = None
    if not raw_date:
        errors.append("order_date 必填")
    else:
        order_date = parse_date(raw_date)
        if order_date is None:
            errors.append("order_date 不是合法日期（YYYY-MM-DD）")

    # 枚举：值与表头同一宽容度（状态转小写、币种转大写），非法值逐行报错
    raw_status = (values.get("status") or "").strip().lower()
    status = raw_status or "pending"
    if raw_status and raw_status not in ORDER_STATUS:
        errors.append("status 非法：允许 " + "/".join(ORDER_STATUS))

    raw_currency = (values.get("currency") or "").strip().upper()
    currency = raw_currency or "USD"
    if raw_currency and raw_currency not in CURRENCY:
        errors.append("currency 非法：允许 " + "/".join(CURRENCY))

    raw_amount = (values.get("total_amount") or "").strip()
    total_amount: Optional[Decimal] = None
    if raw_amount:
        try:
            total_amount = Decimal(raw_amount)
        except (InvalidOperation, ValueError):
            errors.append("total_amount 必须是数字")
            total_amount = None
        else:
            if total_amount.is_nan() or total_amount.is_infinite():
                errors.append("total_amount 必须是有限数字")
                total_amount = None
            elif total_amount < 0:
                errors.append("total_amount 必须 ≥ 0")
                total_amount = None

    raw_notes = (values.get("notes") or "").strip()
    notes = raw_notes or None
    if notes is not None and len(notes) > NOTES_MAX:
        errors.append("notes 超过 %d 字符" % NOTES_MAX)

    internal = {
        "order_no": order_no,
        "order_date": order_date,
        "status": status,
        "currency": currency,
        "total_amount": total_amount,
        "notes": notes,
    }
    public = {
        "order_no": order_no or None,
        "order_date": order_date.date().isoformat() if order_date else None,
        "status": status,
        "currency": currency,
        "total_amount": float(total_amount) if total_amount is not None else None,
        "notes": notes,
    }
    return internal, public, errors


def _analyze(raw_rows: list[dict[str, str]]) -> list[dict[str, Any]]:
    """全部数据行 → 逐行结果（含文件内重号判定）。index 从 1 开始（不含表头）。"""
    items: list[dict[str, Any]] = []
    first_seen: dict[str, int] = {}
    for index, values in enumerate(raw_rows, start=1):
        internal, public, errors = _validate_row(values)
        order_no = internal["order_no"]
        if order_no:
            if order_no in first_seen:
                errors.append("order_no 在文件内重复（第 %d 行）" % first_seen[order_no])
            else:
                first_seen[order_no] = index
        items.append({
            "index": index,
            "ok": not errors,
            "data": public,
            "errors": errors,
            "internal": internal,
        })
    return items


def _file_order_nos(items: list[dict[str, Any]]) -> list[str]:
    """文件里的 order_no（去重、保留出现顺序）。"""
    seen: set[str] = set()
    out: list[str] = []
    for item in items:
        order_no = item["internal"]["order_no"]
        if order_no and order_no not in seen:
            seen.add(order_no)
            out.append(order_no)
    return out


def _public_row(item: dict[str, Any]) -> dict[str, Any]:
    """对外行视图：坏行不下发半成品 data（与设计示例一致）。"""
    return {
        "index": item["index"],
        "ok": item["ok"],
        "data": item["data"] if item["ok"] else None,
        "errors": list(item["errors"]),
    }


def _summary(items: list[dict[str, Any]], existing_order_nos: list[str]) -> dict[str, Any]:
    ok = sum(1 for item in items if item["ok"])
    return {
        "total": len(items),
        "ok": ok,
        "error": len(items) - ok,
        "existing_order_nos": existing_order_nos,
    }


async def _existing_order_nos(conn, order_nos: list[str]) -> set[str]:
    """库内（tenant 口径）已存在的 order_no 集合。"""
    if not order_nos:
        return set()
    rows = await conn.fetch(_SELECT_EXISTING, DEFAULT_TENANT, order_nos)
    found: set[str] = set()
    for row in rows:
        # asyncpg Record 与 dict 都支持 in / []；列缺失时忽略（预留查询形态）
        value = row["order_no"] if "order_no" in row else None
        if value:
            found.add(value)
    return found


def _mark_db_duplicates(items: list[dict[str, Any]], existing: set[str]) -> list[str]:
    """把「库内已存在」追加到逐行错误上（预览用），返回撞号清单（文件顺序）。"""
    conflicts: list[str] = []
    for item in items:
        order_no = item["internal"]["order_no"]
        if order_no and order_no in existing:
            item["errors"].append("order_no 已存在于本租户")
            item["ok"] = False
            if order_no not in conflicts:
                conflicts.append(order_no)
    return conflicts


# ── 撞库判定（竞态兜底）────────────────────────────────────────────────────────

def _is_unique_violation(exc: BaseException) -> bool:
    """asyncpg 唯一键冲突（sqlstate 23505）。不 import asyncpg：Worker 运行时里
    asyncpg 是运行时注入模块，按异常属性判定更稳，也便于测试桩模拟。"""
    if getattr(exc, "sqlstate", None) == "23505":
        return True
    return "UniqueViolationError" in {cls.__name__ for cls in type(exc).__mro__}


def _duplicate_conflict(conflict: list[str]) -> HTTPException:
    return _err(
        409, "IMPORT_DUPLICATE_ORDER_NO",
        "订单号在本租户已存在，整批未写入：" + "、".join(conflict),
        order_nos=conflict,
    )


# ── 端点：预览（零写入）──────────────────────────────────────────────────────

@app.post("/api/v1/imports/orders/preview")
async def preview_import_orders(
    request: Request,
    file: UploadFile = File(..., description="CSV 文件（UTF-8，含表头）"),
    customer_id: str = Form(..., description="归属客户 id"),
    user: dict = Depends(_get_current_user),
):
    """逐行校验并回预览（**不写任何库**）。"""
    async with _acquire(request) as conn:
        # 客户闸门先于文件解析：单据必须归属已有业务客户（设计第 1 节第 3 条）
        customer = await _doc_customer(conn, customer_id, user, required=True)
        data = await _read_upload(file)
        columns, warnings, raw_rows = _parse_csv(_decode_csv(data))
        if not raw_rows:
            raise _err(422, "IMPORT_NO_ROWS", "CSV 只有表头，没有数据行")
        items = _analyze(raw_rows)
        existing = await _existing_order_nos(conn, _file_order_nos(items))
        existing_order_nos = _mark_db_duplicates(items, existing)

    return {
        "customer": {"id": customer.get("id"), "name": customer.get("name")},
        "columns": columns,
        "rows": [_public_row(item) for item in items],
        "summary": _summary(items, existing_order_nos),
        "warnings": warnings,
    }


# ── 端点：提交（单事务，全有全无）────────────────────────────────────────────

@app.post("/api/v1/imports/orders", status_code=201)
async def create_import_orders(
    request: Request,
    file: UploadFile = File(..., description="CSV 文件（UTF-8，含表头）"),
    customer_id: str = Form(..., description="归属客户 id"),
    user: dict = Depends(_get_current_user),
):
    """校验全绿后单事务写入，保留 CSV 的 order_no。"""
    async with _acquire(request) as conn:
        customer = await _doc_customer(conn, customer_id, user, required=True)
        data = await _read_upload(file)
        _columns, _warnings, raw_rows = _parse_csv(_decode_csv(data))
        if not raw_rows:
            raise _err(422, "IMPORT_NO_ROWS", "CSV 只有表头，没有数据行")

        items = _analyze(raw_rows)
        bad_rows = [
            {"index": item["index"], "errors": item["errors"]}
            for item in items if not item["ok"]
        ]
        if bad_rows:
            # 有错行 = 整批零写入（设计第 1 节第 8 条）
            raise _err(
                422, "IMPORT_HAS_ERRORS",
                "有 %d 行校验未通过，未写入任何数据" % len(bad_rows),
                rows=bad_rows,
            )

        order_nos = _file_order_nos(items)
        existing = await _existing_order_nos(conn, order_nos)
        if existing:
            raise _duplicate_conflict([no for no in order_nos if no in existing])

        ids: list[int] = []
        created_nos: list[str] = []
        try:
            async with conn.transaction():
                for item in items:
                    value = item["internal"]
                    row = await conn.fetchrow(
                        _ORDERS_INSERT,
                        DEFAULT_TENANT,
                        value["order_no"],
                        customer.get("id"),
                        # 客户名快照 = 客户档案当前名（历史导入没有更早的冻结名）
                        customer.get("name"),
                        value["status"],
                        value["currency"],
                        value["total_amount"],
                        value["order_date"],
                        value["notes"],
                        str(user["id"]),
                        str(user["id"]),
                        customer.get("team_id"),
                    )
                    ids.append(row["id"])
                    created_nos.append(value["order_no"])
        except Exception as exc:
            if not _is_unique_violation(exc):
                raise
            # 竞态：预查与插入之间别人写了同号（order_no 是全局 UNIQUE）。
            # 事务已随异常回滚；回查真实冲突集合（回查失败也不掩盖 409 结论）。
            conflict = order_nos
            try:
                now_existing = await _existing_order_nos(conn, order_nos)
            except Exception:
                now_existing = set()
            if now_existing:
                conflict = [no for no in order_nos if no in now_existing]
            raise _duplicate_conflict(conflict) from exc

    return {"created": len(ids), "ids": ids, "order_nos": created_nos}
