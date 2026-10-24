"""单证加固 HTTP 层（A7-2）—— 事实 / 一致性 / lint / 收款 / 单证清单 / 导出自检。

本文件把 A7 内核（`kaas_common.trade_doc.facts` / `consistency` / `equivalents`，
2026-10-20 已完成）接到 Worker 的真实 HTTP 面。**所有业务判定都在内核里**，
本文件只做三件事：取数（payload + 表）、调内核、按 API 契约出结构 ——
不另写一份"事实规则"（G1 的老毛病：两份实现必然漂移，见
`docs/archive/2026-10-20-closeout/WORKER_ORCHESTRATOR_DRIFT.md`）。

端点（路径前缀 `/api/v1`，tenant 恒 `DEFAULT_TENANT`，鉴权 `_get_current_user`）
--------------------------------------------------------------------------
    GET    /trade-docs/{id}/facts                        事实清单 + 信任级汇总
    POST   /trade-docs/{id}/facts/confirm                确认事实（空 keys = 全部未确认）
    PATCH  /trade-docs/{id}/facts/{fact_key}             改信任级/双语/证据（**不能改值**）
    GET    /trade-docs/{id}/consistency                  跨单证事实矩阵（diff + 承继核对）
    POST   /trade-docs/{id}/lint                         组合检查（blocking / warnings）
    GET    /trade-docs/{id}/receipts                     收款登记列表
    POST   /trade-docs/{id}/receipts                     登记一笔收款（容差核销口径）
    GET    /trade-docs/{id}/doc-set                      单证清单
    PUT    /trade-docs/{id}/doc-set                      单证清单全量替换（保留已登记回执）
    POST   /trade-docs/{id}/doc-set/{doc_type}/receipt   对方出单回执（pending→received/waived）
    POST   /trade-docs/{id}/verify-export                导出后自检（默认阻断，可越过+审计）

另外 `ws_docs_ext.confirm_trade_doc` 的校验段接入了 `confirm_blocking()`：
签发前跑 trust / immutable / 引用完整性 / 单证清单四项 blocking。

口径（与内核一致，这里不重复实现）
--------------------------------
- 事实 = payload 的**推导结果**：`value` 永远由 payload 决定，`trade_doc_facts` 表只存
  **人对事实的处置**（信任级、不可改写、双语文本、证据引用、确认人/时间）。
  所以 PATCH 改 `value` 一律 422 `FACT_VALUE_IMMUTABLE_STORAGE` —— 否则表里的值与
  payload 会分叉，"同一条事实两个真相"。
- 金额容差、等价措辞、不可改写判定全部调用内核；本文件不做四舍五入、不做同义判断。
- 未确认事实的导出占位（TBC/待确认）由内核 `render_tbc` 负责，本文件不碰渲染。
- `trigger_expr`（A12）：求值在共享内核 `kaas_common.trade_doc.trigger`（受限解析，
  **无 eval/exec**）。本文件只负责三处接线：GET doc-set 追加 `applicable` /
  `skipped_by_trigger` / `trigger_error`；PUT 先 `validate_trigger` 语法校验（坏表达式
  422 `TRIGGER_EXPR_INVALID`，不落库）；`/lint` 对 required 条件不满足/无法求值给
  **warning**（不阻断签发）。

写库纪律
--------
全部 SQL 参数化（`$1/$2`），`trade_docs` 的 jsonb 列按 `table="trade_docs"` 约定解码
（`dbjson.py` 的注册表）；多语句要原子的地方（单证清单替换）走 `main._acquire` 的事务。
"""
from __future__ import annotations

import re
from dataclasses import replace
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Any, Optional

from fastapi import Depends, HTTPException, Request
from pydantic import BaseModel

from kaas_common.domain.enums import CURRENCY, DOC_TYPE, SCHEDULE_TYPE
from kaas_common.trade_doc import (
    FACT_CONFLICT,
    FACT_IMMUTABLE,
    FACT_MISSING,
    FACT_UNVERIFIED,
    TRUST_CONFIRMED,
    TRUST_INFERRED,
    TRUST_LEVELS,
    TRUST_UNVERIFIED,
    Fact,
    TriggerError,
    check_derived_amount,
    check_immutable,
    decimal_text,
    derive_amount,
    diff_facts,
    extract_facts,
    fact_kind,
    gate_trust,
    lint_pair,
    normalize_text,
    resolve_doc_set,
    validate_trigger,
)
from kaas_common.workstation.receipt_rules import classify_receipt_diff

import doc_payload as _dp
import main as _main

app = _main.app
_get_current_user = _main._get_current_user
DEFAULT_TENANT = _main.DEFAULT_TENANT


def _db():
    """当前生效的 db 封装。

    为什么**不**在模块顶层 `db = _main.db` 固化：路由模块是在 main 导入期加载的，
    固化后一旦 `main.db` 被替换（测试的假 db / 热重载后的新封装），本模块仍指向旧对象 ——
    既有 API 测试正是用 `worker_main.db = fake` 桩掉数据库的，固化会让查询打到真实连接上
    （表现为 `KeyError: 'env'` → 500，实测踩过）。每次调用现取，永远与 main 一致。
    """
    return _main.db

# ── 错误码（与 API 层 detail.code 对应；内核码直接复用）──────────────────
DOC_REF_BROKEN = "DOC_REF_BROKEN"
DOC_SET_NOT_ALLOWED = "DOC_SET_NOT_ALLOWED"
DOC_SET_INVALID = "DOC_SET_INVALID"
DOC_SET_DUPLICATE = "DOC_SET_DUPLICATE"
DOC_SET_ITEM_NOT_FOUND = "DOC_SET_ITEM_NOT_FOUND"
ILLEGAL_DOC_SET_TRANSITION = "ILLEGAL_DOC_SET_TRANSITION"
# A12：清单触发条件（`trigger_expr`）—— 写入语法错 422；读取无法求值 / 条件不满足只 warning
TRIGGER_EXPR_INVALID = "TRIGGER_EXPR_INVALID"
DOC_SET_TRIGGER_SKIPPED = "DOC_SET_TRIGGER_SKIPPED"
DOC_SET_TRIGGER_ERROR = "DOC_SET_TRIGGER_ERROR"
FACT_NOT_FOUND = "FACT_NOT_FOUND"
FACT_KEY_UNKNOWN = "FACT_KEY_UNKNOWN"
FACT_VALUE_IMMUTABLE_STORAGE = "FACT_VALUE_IMMUTABLE_STORAGE"
EXPORT_SELF_CHECK_FAILED = "EXPORT_SELF_CHECK_FAILED"
INVALID_RECEIPT = "INVALID_RECEIPT"
INVALID_ENUM = "INVALID_ENUM"
DOC_NOT_EDITABLE = "DOC_NOT_EDITABLE"

# 单证清单的角色 / 出单方（`UNCERTAIN #17 ④` 裁决：not_by_us 要回执登记）
DOC_SET_ROLES = ("required", "optional", "not_by_us")
DOC_SET_ISSUERS = ("ours", "buyer", "third_party:ccpit", "carrier", "insurer")
# 回执状态机在 SQL 里用 `AND status='pending'` 保证（pending → received | waived），
# 非法转移拿不到行 ⇒ 再去查当前状态区分 404 / 409，不静默覆盖已登记的回执。

# 导出后自检的默认期望图片数：一份单证的**公章恰好 1 张**（§8-7「公章跨页 → 计数≠1」）
DEFAULT_EXPECTED_IMAGES = {"stamp": 1}


# ── SQL（全部参数化；表见 `backend/orchestrator/app/db/workstation_links.py`）──

_SQL_FACT_ROWS = (
    "SELECT fact_key, trust, immutable, confirmed_by, confirmed_at, text_zh, text_en,"
    " source, evidence_ref FROM trade_doc_facts"
    " WHERE tenant_id=$1 AND trade_doc_id=$2 ORDER BY fact_key"
)

_SQL_FACT_UPSERT = (
    "INSERT INTO trade_doc_facts"
    " (tenant_id, trade_doc_id, doc_type, doc_no, fact_key, value_text, value_num,"
    "  currency, text_zh, text_en, source, trust, immutable, confirmed_by,"
    "  confirmed_at, evidence_ref, updated_at)"
    " VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, now())"
    " ON CONFLICT (tenant_id, trade_doc_id, fact_key) DO UPDATE SET"
    "  doc_type=EXCLUDED.doc_type, doc_no=EXCLUDED.doc_no,"
    "  value_text=EXCLUDED.value_text, value_num=EXCLUDED.value_num,"
    "  currency=EXCLUDED.currency, text_zh=EXCLUDED.text_zh, text_en=EXCLUDED.text_en,"
    "  source=EXCLUDED.source, trust=EXCLUDED.trust, immutable=EXCLUDED.immutable,"
    "  confirmed_by=EXCLUDED.confirmed_by, confirmed_at=EXCLUDED.confirmed_at,"
    "  evidence_ref=EXCLUDED.evidence_ref, updated_at=now()"
)

# 引用完整性：本单证**指向**的单证必须存在且已签发（§4-D）。
# 边表 `entity_links` 是关系的唯一真源（旧 `trade_doc_doc_refs` 已随迁移
# 202610110014 退场为 `*_legacy`，见 main.py `_doc_upstream_links`）。
_SQL_OUTGOING_REFS = (
    "SELECT l.dst_id AS target_id, d.id AS target_doc_id, d.doc_no, d.doc_type, d.status"
    " FROM entity_links l"
    " LEFT JOIN trade_docs d ON d.tenant_id = l.tenant_id AND d.id = l.dst_id"
    " WHERE l.tenant_id=$1 AND l.src_type='trade_doc' AND l.src_id=$2"
    "   AND l.dst_type='trade_doc' AND l.deleted_at IS NULL"
    " ORDER BY l.id"
)

_SQL_DOC_SET_ROWS = (
    "SELECT doc_type, role, issuer, trigger_expr, evidence_required, status,"
    " waived_reason, received_doc_id, received_at FROM trade_doc_doc_set_items"
    " WHERE tenant_id=$1 AND trade_doc_id=$2 ORDER BY doc_type"
)

# 「清单说这单不该由我方出，却真的开了一张」——按同一交易域（order，退化为客户）查
_SQL_DOCS_OF_TYPES = (
    "SELECT id, doc_no, doc_type, status FROM trade_docs"
    " WHERE tenant_id=$1 AND doc_type = ANY($2::text[]) AND status <> 'void'"
    "   AND (($3::bigint IS NOT NULL AND order_id = $3)"
    "        OR ($3::bigint IS NULL AND customer_id = $4))"
    " ORDER BY id"
)

_SQL_DOCS_BY_ORDER = (
    "SELECT * FROM trade_docs WHERE tenant_id=$1 AND order_id=$2"
    " AND status <> 'void' ORDER BY id"
)
_SQL_DOCS_BY_QUOTE = (
    "SELECT * FROM trade_docs WHERE tenant_id=$1 AND quote_id=$2"
    " AND status <> 'void' ORDER BY id"
)
_SQL_LINKED_ORDER = (
    "SELECT dst_id FROM entity_links WHERE tenant_id=$1 AND src_type='trade_doc'"
    " AND src_id=$2 AND dst_type='order' AND deleted_at IS NULL ORDER BY id LIMIT 1"
)
_SQL_LINKED_QUOTE = (
    "SELECT dst_id FROM entity_links WHERE tenant_id=$1 AND src_type='trade_doc'"
    " AND src_id=$2 AND dst_type='quote' AND deleted_at IS NULL ORDER BY id LIMIT 1"
)

_SQL_RECEIPTS = (
    "SELECT * FROM trade_doc_receipts WHERE tenant_id=$1 AND trade_doc_id=$2"
    " ORDER BY received_at DESC, id DESC"
)
_SQL_RECEIPT_INSERT = (
    "INSERT INTO trade_doc_receipts"
    " (tenant_id, trade_doc_id, schedule_type, schedule_amount, received_amount, currency,"
    "  received_at, bank_ref, diff, diff_reason, fx_rate_used, status, notes, created_by)"
    " VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *"
)

_SQL_DOC_SET_DELETE_UNLISTED = (
    "DELETE FROM trade_doc_doc_set_items"
    " WHERE tenant_id=$1 AND trade_doc_id=$2 AND doc_type <> ALL($3::text[])"
)
_SQL_DOC_SET_UPSERT = (
    "INSERT INTO trade_doc_doc_set_items"
    " (tenant_id, trade_doc_id, doc_type, role, issuer, trigger_expr, evidence_required,"
    "  updated_at)"
    " SELECT $1, $2, unnest($3::text[]), unnest($4::text[]), unnest($5::text[]),"
    "        unnest($6::text[]), unnest($7::boolean[]), now()"
    " ON CONFLICT (tenant_id, trade_doc_id, doc_type) DO UPDATE SET"
    "  role=EXCLUDED.role, issuer=EXCLUDED.issuer,"
    "  trigger_expr=EXCLUDED.trigger_expr,"
    "  evidence_required=EXCLUDED.evidence_required, updated_at=now()"
)
_SQL_DOC_SET_RECEIPT = (
    "UPDATE trade_doc_doc_set_items SET status=$4, waived_reason=$5, received_doc_id=$6,"
    " received_at=CASE WHEN $4='received' THEN now() ELSE NULL END, updated_at=now()"
    " WHERE tenant_id=$1 AND trade_doc_id=$2 AND doc_type=$3"
    "   AND status='pending' RETURNING *"
)
_SQL_DOC_SET_ITEM = (
    "SELECT * FROM trade_doc_doc_set_items"
    " WHERE tenant_id=$1 AND trade_doc_id=$2 AND doc_type=$3"
)
_SQL_DOC_EXISTS = "SELECT 1 FROM trade_docs WHERE tenant_id=$1 AND id=$2"


# ── 请求/响应模型 ─────────────────────────────────────────────────────────

class FactsConfirmIn(BaseModel):
    """确认事实。`keys` 为空 = 确认全部未确认事实（界面上"全部确认"）。"""

    keys: list[str] = []


class FactPatchIn(BaseModel):
    """改事实的**处置**（不是改值）。`value` 显式声明只为给出明确错误码。"""

    trust: Optional[str] = None
    immutable: Optional[bool] = None
    text_zh: Optional[str] = None
    text_en: Optional[str] = None
    evidence_ref: Optional[str] = None
    value: Optional[Any] = None


class ReceiptIn(BaseModel):
    """登记一笔收款（§4-E）。金额用 Any 接收再宽容转 Decimal，非法值 422。"""

    schedule_type: Optional[str] = None
    schedule_amount: Optional[Any] = None
    received_amount: Any
    currency: str = "USD"
    received_at: Optional[str] = None
    bank_ref: Optional[str] = None
    notes: Optional[str] = None
    fx_rate_used: Optional[Any] = None


class DocSetItemIn(BaseModel):
    doc_type: str
    role: str = "required"
    issuer: str = "ours"
    trigger_expr: Optional[str] = None
    evidence_required: bool = False


class DocSetIn(BaseModel):
    items: list[DocSetItemIn] = []


class DocSetReceiptIn(BaseModel):
    action: str
    received_doc_id: Optional[int] = None
    waived_reason: Optional[str] = None


class VerifyExportIn(BaseModel):
    """导出后自检入参（前端从 PDF 提取文本与图片计数）。"""

    texts: list[str] = []
    pdf_text: str = ""
    image_counts: dict[str, int] = {}
    expected_image_counts: Optional[dict[str, int]] = None
    allow_override: bool = False


# ── 小工具 ────────────────────────────────────────────────────────────────

def _iso(value: Any) -> Optional[str]:
    """datetime/date → ISO 字符串；其它原样转字符串（JSON 友好）。"""
    if value is None:
        return None
    return value.isoformat() if hasattr(value, "isoformat") else str(value)


def _as_decimal(value: Any) -> Optional[Decimal]:
    if value is None or value == "":
        return None
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None


def _error(status_code: int, code: str, detail: str, **extra) -> HTTPException:
    """统一错误体（与 worker 既有 404/409/422 的 `{error, code, detail}` 形状一致）。"""
    kind = {404: "not_found", 409: "conflict"}.get(status_code, "validation")
    payload: dict = {"error": kind, "code": code, "detail": detail}
    payload.update(extra)
    return HTTPException(status_code=status_code, detail=payload)


async def _doc_404(request: Request, doc_id: int, user: Optional[dict] = None) -> dict:
    """取单证（404 由 doc_payload 的统一实现给出），转成 dict。

    C27：传 `user` 即按团队/owner 可见性过滤（跨团队/无团队 404，与 /facts、
    /lint、/doc-set 的读口径一致）。
    """
    row = await _dp.get_doc_or_404(_db(), request, doc_id, user)
    return _dp.doc_dict(dict(row))


def _require_not_void(d: dict) -> None:
    if (d.get("status") or "") == "void":
        raise _error(409, DOC_NOT_EDITABLE, "作废单据的事实处置不可再修改（历史证据已封存）")


# ─── 事实：抽取 + 表内处置叠加 ────────────────────────────────────────────

def _fact_source_payload(d: dict) -> dict:
    """`extract_facts` 的入参：raw_payload + 行级身份字段（单号/状态/时间）。

    只补**身份**字段：币种/合计/条款仍从 payload 快照取（那是开单时冻结的口径），
    否则"行字段"会把快照的 `source`/`evidence_ref` 冲掉（事实要能说清值从哪来）。
    """
    payload = dict(_dp.payload_of(d) or {})
    payload["doc_no"] = d.get("doc_no")
    payload["status"] = d.get("status")
    for key in ("issued_at", "created_at"):
        if d.get(key):
            payload[key] = d[key]
    return payload


# ─── A14：本单包装解析（复用产品 spec.packaging，不新增字段）───────────────

# 这些 origin 常量与内核 `kaas_common.trade_doc.facts` 同名常量一一对应
_PACKING_ORIGIN_ROW = "row"
_PACKING_ORIGIN_PRODUCT_DEFAULT = "inferred:product_default"
_PACKING_ORIGIN_SNAPSHOT = "inferred:snapshot"
_PACKING_ORIGIN_NONE = "inferred:none"


def _packing_snapshot_of(d: dict) -> Optional[dict]:
    """本单行项里第一个带包装信息的 spec_snapshot（**纯函数**；旧 handler 与供数 RPC 共用）。

    数据路径（按优先级）：raw_payload.sources.{order|quote|pi|contract}.items[].spec_snapshot。
    """
    payload = _fact_source_payload(d)
    raw_sources = payload.get("sources")
    sources = raw_sources if isinstance(raw_sources, dict) else {}
    for kind in ("order", "quote", "pi", "contract"):
        snap = sources.get(kind)
        if not isinstance(snap, dict):
            continue
        items = snap.get("items")
        if not isinstance(items, list):
            continue
        for item in items:
            if not isinstance(item, dict):
                continue
            spec_snapshot = item.get("spec_snapshot")
            if not isinstance(spec_snapshot, dict):
                continue
            if (str(spec_snapshot.get("packaging_id") or "").strip()
                    or str(spec_snapshot.get("product_key") or "").strip()
                    or str(spec_snapshot.get("packaging_name") or "").strip()):
                return spec_snapshot
    return None


def _packing_from_product(snapshot: Optional[dict], product) -> dict:
    """snapshot + 产品定义 → extract_facts 的 packing 契约（**纯函数**）。

    返回 {method, origin, packaging_id, packaging_name}；origin 是来源标注：
    本单行命中 = row；回退产品默认 = inferred:product_default；快照名/无配置 =
    inferred:snapshot / inferred:none。解析失败一律降级（facts 是加固增强）。
    """
    if snapshot is None:
        return {
            "method": "none", "origin": _PACKING_ORIGIN_NONE,
            "packaging_id": None, "packaging_name": None,
        }

    packaging_id = str(snapshot.get("packaging_id") or "").strip()
    snapshot_name = str(snapshot.get("packaging_name") or "").strip()

    raw_packaging = None
    if product is not None:
        raw_packaging = (
            product.get("packaging") if isinstance(product, dict)
            else getattr(product, "packaging", None)
        )
    candidates = [p for p in (raw_packaging or []) if isinstance(p, dict)]

    picked: Optional[dict] = None
    if packaging_id:
        picked = next(
            (p for p in candidates if str(p.get("id") or "") == packaging_id), None)
    if picked is None and candidates:
        picked = next((p for p in candidates if p.get("is_default")), None)
        if picked is None:
            with_created = [p for p in candidates if p.get("created_at")]
            picked = (
                min(with_created, key=lambda p: str(p.get("created_at")))
                if with_created else candidates[0]
            )

    if picked is None:
        if snapshot_name:
            return {
                "method": snapshot_name, "origin": _PACKING_ORIGIN_SNAPSHOT,
                "packaging_id": packaging_id or None, "packaging_name": snapshot_name,
            }
        return {
            "method": "none", "origin": _PACKING_ORIGIN_NONE,
            "packaging_id": packaging_id or None, "packaging_name": None,
        }

    method = str(picked.get("method") or "").strip()
    if not method:  # method 是主口径；缺省时退回名称（可读，且归类仍能命中关键词）
        method = str(picked.get("name") or "").strip() or "none"
    matched_row = bool(packaging_id) and str(picked.get("id") or "") == packaging_id
    return {
        "method": method,
        "origin": _PACKING_ORIGIN_ROW if matched_row else _PACKING_ORIGIN_PRODUCT_DEFAULT,
        "packaging_id": str(picked.get("id") or "") or None,
        "packaging_name": str(picked.get("name") or "") or None,
    }


async def _packing_of_doc(
    request: Request,
    d: dict,
    user: Optional[dict] = None,
) -> dict:
    """解析**本单**包装方式（A14）—— 不新增 DB 字段，只复用既有设计。

    快照识别与包装选择是纯函数（_packing_snapshot_of / _packing_from_product）；本函数
    只负责「产品定义」这一处取数：tenant_products 优先、回退注册表，与 /formulas、算价
    同一解析器 quote_api._effective_product_raw。失败一律降级（facts 不能把 /facts 打 500）。
    """
    snapshot = _packing_snapshot_of(d)
    if snapshot is None:
        return _packing_from_product(None, None)

    product = None
    product_key = str(snapshot.get("product_key") or "").strip()
    if product_key:
        try:
            # 按名字取「当前」模块（全量跑时路由模块可能来自更早的代际；
            # test_trade_doc_packing_api 的补丁口径就是 patch 当前 sys.modules 里的 quote_api）
            from quote_api import _effective_product_raw  # noqa: PLC0415

            product = await _effective_product_raw(request, user or {}, product_key)
        except Exception:  # noqa: BLE001 - 有意兜底：产品解析失败按"无配置"降级
            product = None
    return _packing_from_product(snapshot, product)


def _baseline_facts(d: dict) -> list[Fact]:
    """**上游基线**事实：同一 payload 去掉手工层后抽取。

    为什么这样就等于基线：`sources.*` 是派生建单时冻结的上游快照（`freeze_snapshot`），
    而 `custom` 是派生单自己的手工覆盖层。去掉 custom 剩下的就是"当初继承来的原值"，
    这正是"不可改写事实被改了没有"要对比的那一份 —— 不需要再读上游单证的行。
    """
    payload = _fact_source_payload(d)
    payload["custom"] = {}
    return extract_facts(payload, d.get("doc_type") or "other")


async def _fact_rows(request: Request, doc_id: int) -> dict[str, dict]:
    """表内处置：`{fact_key: row}`（没有行 = 全部按内核默认）。"""
    rows = await _db().fetch(request, _SQL_FACT_ROWS, DEFAULT_TENANT, doc_id)
    return {str(dict(row)["fact_key"]): dict(row) for row in rows or []}


def _apply_overlay(facts: list[Fact], rows: dict[str, dict]) -> list[Fact]:
    """把表内的信任级/不可改写/双语/证据/确认人叠加到内核事实之上。"""
    merged: list[Fact] = []
    for fact in facts:
        row = rows.get(fact.key)
        if row is None:
            merged.append(fact)
            continue
        immutable = row.get("immutable")
        merged.append(replace(
            fact,
            trust=row.get("trust") or fact.trust,
            immutable=fact.immutable if immutable is None else bool(immutable),
            text_zh=row.get("text_zh") or fact.text_zh,
            text_en=row.get("text_en") or fact.text_en,
            evidence_ref=row.get("evidence_ref") or fact.evidence_ref,
            source=row.get("source") or fact.source,
            confirmed_by=row.get("confirmed_by") if row.get("confirmed_by") is not None
            else fact.confirmed_by,
            confirmed_at=_iso(row.get("confirmed_at")) or fact.confirmed_at,
        ))
    return merged


def _facts_from_parts(d: dict, packing: dict, fact_rows) -> list[Fact]:
    """内核抽取 + 表内处置（**纯函数**；旧 handler 与供数 RPC 共用同一份）。

    A14：packing 由调用方解析好并作为 packing= 传给内核（packing_method /
    packing_type 两条事实）；产品解析失败按"无配置"降级，不影响其余事实。
    """
    facts = extract_facts(
        _fact_source_payload(d),
        d.get("doc_type") or "other",
        packing=packing,
    )
    if isinstance(fact_rows, dict):
        overlay = fact_rows
    else:
        overlay = {str(dict(row)["fact_key"]): dict(row) for row in fact_rows or []}
    return _apply_overlay(facts, overlay)


async def _facts_of(
    request: Request,
    d: dict,
    user: Optional[dict] = None,
) -> list[Fact]:
    """单证事实 = 内核抽取 + 表内处置（其它端点都走这一个入口）。"""
    packing = await _packing_of_doc(request, d, user)
    return _facts_from_parts(d, packing, await _fact_rows(request, d["id"]))


def _facts_payload(d: dict, doc_id: int, facts: list[Fact]) -> dict:
    """事实清单响应（**纯投影**；旧 handler 与供数 RPC 共用同一份）。"""
    return {
        "doc_id": doc_id,
        "doc_type": d.get("doc_type"),
        "doc_no": d.get("doc_no"),
        "status": d.get("status"),
        "items": [_fact_dict(fact) for fact in facts],
        "summary": _summary(facts),
    }


def _summary(facts: list[Fact]) -> dict:
    return {
        "total": len(facts),
        "confirmed": sum(1 for f in facts if f.trust == TRUST_CONFIRMED),
        "unverified": sum(1 for f in facts if f.trust == TRUST_UNVERIFIED),
        "inferred": sum(1 for f in facts if f.trust == TRUST_INFERRED),
    }


def _fact_dict(fact: Fact) -> dict:
    return {
        "key": fact.key,
        "value": fact.value,
        "trust": fact.trust,
        "source": fact.source,
        "immutable": fact.immutable,
        "text_zh": fact.text_zh,
        "text_en": fact.text_en,
        "confirmed_by": fact.confirmed_by,
        "confirmed_at": fact.confirmed_at,
        "evidence_ref": fact.evidence_ref,
        # 金额类事实的币种（界面按币种显示容差口径，不用再反查 currency 事实）
        "currency": fact.currency,
    }


async def _upsert_fact(
    request: Request,
    doc_id: int,
    d: dict,
    fact: Fact,
    *,
    trust: Optional[str] = None,
    immutable: Optional[bool] = None,
    text_zh: Optional[str] = None,
    text_en: Optional[str] = None,
    evidence_ref: Optional[str] = None,
    confirmed_by: Optional[Any] = None,
    confirmed_at: Optional[datetime] = None,
) -> None:
    """把**人对这条事实的处置**落库（值仍由 payload 决定，这里只存 value 的快照副本）。"""
    resolved_trust = trust or fact.trust
    if resolved_trust not in TRUST_LEVELS:
        raise _error(422, INVALID_ENUM, f"未知信任级：{resolved_trust}（可选 {list(TRUST_LEVELS)}）")
    value_num = None
    if fact_kind(fact.key) in ("money", "qty", "ratio", "fx_rate"):
        value_num = _as_decimal(fact.value)
    await _db().execute(
        request, _SQL_FACT_UPSERT,
        DEFAULT_TENANT, doc_id, d.get("doc_type"), d.get("doc_no"), fact.key,
        fact.value, value_num, fact.currency or None,
        fact.text_zh if text_zh is None else text_zh,
        fact.text_en if text_en is None else text_en,
        fact.source, resolved_trust,
        fact.immutable if immutable is None else bool(immutable),
        fact.confirmed_by if confirmed_by is None else confirmed_by,
        fact.confirmed_at if confirmed_at is None else confirmed_at,
        fact.evidence_ref if evidence_ref is None else evidence_ref,
    )


# ─── 1) 事实清单 ─────────────────────────────────────────────────────────

@app.get("/api/v1/trade-docs/{doc_id}/facts")
async def list_trade_doc_facts(
    doc_id: int,
    request: Request,
    user: dict = Depends(_get_current_user),
):
    """单证事实清单（payload 推导 + 表内处置叠加）。

    返回的 `summary` 就是界面上"✓ 已确认 N 项 / ⚠ 待确认 M 项"的来源；
    未确认事实的导出占位由内核 `render_tbc` 在渲染侧处理（TBC/待确认，不猜值）。
    """
    d = await _doc_404(request, doc_id, user)
    return _facts_payload(d, doc_id, await _facts_of(request, d, user))


# ─── 2) 确认事实（gate_trust 的回写路径）──────────────────────────────────

@app.post("/api/v1/trade-docs/{doc_id}/facts/confirm")
async def confirm_trade_doc_facts(
    doc_id: int,
    request: Request,
    body: FactsConfirmIn,
    user: dict = Depends(_get_current_user),
):
    """确认事实 → `trust=confirmed`（谁在什么时候确认的落库）。

    为什么必须有这个端点：内核把"付款条件解析出的比例/时点"判为 `unverified`
    （推断值不得直接进 issued，§4-A 规则 1）；签发闸门因此会拦。业务员在界面上
    逐项核对后点确认，走的就是这里 —— **没有这条回写路径，带付款条款的单证永远签不出去**。

    `keys` 为空 = 确认全部未确认事实；给了具体 key 则只确认这些（未知 key ⇒ 422）。
    """
    d = await _doc_404(request, doc_id, user)
    # C27b（用户 2026-10-21 拍板）：加固写端点限**团队管理员/internal**；
    # 可见性 404 已先判（`_doc_404`），此处 403 `TEAM_ADMIN_REQUIRED`。
    await _main._require_doc_issuer(request, user, d)
    _require_not_void(d)
    facts = await _facts_of(request, d, user)
    by_key = {fact.key: fact for fact in facts}

    if body.keys:
        unknown = [key for key in body.keys if key not in by_key]
        if unknown:
            raise _error(422, FACT_KEY_UNKNOWN,
                         f"以下事实键不存在于本单证：{', '.join(unknown)}",
                         keys=unknown)
        targets = [by_key[key] for key in dict.fromkeys(body.keys)]
    else:
        targets = [fact for fact in facts if fact.trust != TRUST_CONFIRMED]

    now = datetime.now(timezone.utc)
    for fact in targets:
        await _upsert_fact(request, doc_id, d, fact,
                           trust=TRUST_CONFIRMED,
                           confirmed_by=str(user.get("id")),
                           confirmed_at=now)

    if targets:
        await _main._record_business_event(
            request, "trade_doc.facts_confirmed",
            {"doc_id": doc_id, "doc_no": d.get("doc_no"), "actor_id": str(user.get("id")),
             "keys": [fact.key for fact in targets]},
            from_ws="trade_doc",
        )

    refreshed = await _facts_of(request, d, user)
    return {
        "doc_id": doc_id,
        "confirmed": [fact.key for fact in targets],
        "summary": _summary(refreshed),
    }


# ─── 3) 改事实处置（不能改值）────────────────────────────────────────────

@app.patch("/api/v1/trade-docs/{doc_id}/facts/{fact_key}")
async def patch_trade_doc_fact(
    doc_id: int,
    fact_key: str,
    request: Request,
    body: FactPatchIn,
    user: dict = Depends(_get_current_user),
):
    """改一条事实的**处置**：信任级 / 不可改写 / 双语文本 / 证据引用。

    `value` **不允许改**：值的唯一真源是 payload（`extract_facts` 的推导结果）。
    表里再存一份可改的值，就会出现"同一条事实两个真相"——那正是这套加固要消灭的东西。
    改值请求返回 422 `FACT_VALUE_IMMUTABLE_STORAGE`，而不是静默忽略。
    """
    d = await _doc_404(request, doc_id, user)
    _require_not_void(d)

    if "value" in getattr(body, "model_fields_set", set()):
        raise _error(
            422, FACT_VALUE_IMMUTABLE_STORAGE,
            "事实的值由单证 payload 决定，不接受直接修改；"
            "要改值请改单证内容（draft 期）或作废重开",
        )

    fact = next((item for item in await _facts_of(request, d, user) if item.key == fact_key), None)
    if fact is None:
        raise _error(404, FACT_NOT_FOUND,
                     f"单证 {doc_id} 上没有事实「{fact_key}」（值由 payload 推导，未推导出的键不能凭空创建）")

    if body.trust is not None and body.trust not in TRUST_LEVELS:
        raise _error(422, INVALID_ENUM,
                     f"未知信任级：{body.trust}（可选 {list(TRUST_LEVELS)}）")

    await _upsert_fact(
        request, doc_id, d, fact,
        trust=body.trust,
        immutable=body.immutable,
        text_zh=body.text_zh,
        text_en=body.text_en,
        evidence_ref=body.evidence_ref,
    )
    updated = next(item for item in await _facts_of(request, d, user) if item.key == fact_key)
    return {"doc_id": doc_id, "item": _fact_dict(updated)}


# ─── 4) 跨单证一致性 ──────────────────────────────────────────────────────

async def _linked_id(request: Request, doc_id: int, dst_type: str) -> Optional[int]:
    """边表兜底：历史行 `order_id`/`quote_id` 列为空时，关系只在 `entity_links` 里。"""
    sql = _SQL_LINKED_ORDER if dst_type == "order" else _SQL_LINKED_QUOTE
    rows = await _db().fetch(request, sql, DEFAULT_TENANT, doc_id)
    return int(dict(rows[0])["dst_id"]) if rows else None


def _domain_docs_from_parts(d: dict, linked_order_rows, order_rows,
                            linked_quote_rows, quote_rows) -> tuple[str, list[dict]]:
    """交易域判定（**纯函数**；旧 handler 与供数 RPC 共用同一份）。

    退化顺序：order 列 → 边表 order 边 → quote 链 → 仅自身。行由供数方按旧 SQL
    （tenant + order_id/quote_id + status<>'void' ORDER BY id）查好；本函数只做判定。
    """
    doc_id = d["id"]
    order_id = d.get("order_id")
    if not order_id:
        order_id = (int(dict(linked_order_rows[0])["dst_id"])
                    if linked_order_rows else None)
    if order_id:
        rows = [_dp.doc_dict(_main._trade_doc_row_from_dataset(dict(row)))
                for row in order_rows or []]
        if rows:
            return f"order:{order_id}", rows
    quote_id = d.get("quote_id")
    if not quote_id:
        quote_id = (int(dict(linked_quote_rows[0])["dst_id"])
                    if linked_quote_rows else None)
    if quote_id:
        rows = [_dp.doc_dict(_main._trade_doc_row_from_dataset(dict(row)))
                for row in quote_rows or []]
        if rows:
            return f"quote:{quote_id}", rows
    return f"doc:{doc_id}", [d]


async def _domain_docs(request: Request, d: dict) -> tuple[str, list[dict]]:
    """交易域取数（旧 handler 用）：列/边表/quote 链三处查询后交给纯判定。"""
    doc_id = d["id"]
    order_id = d.get("order_id")
    linked_order_rows = []
    order_rows = []
    if not order_id:
        linked_order_rows = await _db().fetch(request, _SQL_LINKED_ORDER,
                                              DEFAULT_TENANT, doc_id)
        order_id = (int(dict(linked_order_rows[0])["dst_id"])
                    if linked_order_rows else None)
    if order_id:
        order_rows = await _db().fetch(request, _SQL_DOCS_BY_ORDER,
                                       DEFAULT_TENANT, order_id, table="trade_docs")
    quote_id = None
    linked_quote_rows = []
    quote_rows = []
    if not order_id or not order_rows:
        quote_id = d.get("quote_id")
        if not quote_id:
            linked_quote_rows = await _db().fetch(request, _SQL_LINKED_QUOTE,
                                                  DEFAULT_TENANT, doc_id)
            quote_id = (int(dict(linked_quote_rows[0])["dst_id"])
                        if linked_quote_rows else None)
        if quote_id:
            quote_rows = await _db().fetch(request, _SQL_DOCS_BY_QUOTE,
                                           DEFAULT_TENANT, quote_id, table="trade_docs")
    return _domain_docs_from_parts(d, linked_order_rows, order_rows,
                                   linked_quote_rows, quote_rows)


def _baseline_key(docs: list[dict], facts_by_doc: dict[str, list[Fact]]) -> Optional[str]:
    """基线 = 交易域里最早那一份（id 最小的、且有事实的）—— 通常就是 PI/合同。"""
    for row in docs:
        key = str(row["id"])
        if facts_by_doc.get(key):
            return key
    return None


def _consistency_payload(d: dict, doc_id: int, root: str, docs: list[dict]) -> dict:
    """跨单证事实矩阵（**纯投影**；旧 handler 与供数 RPC 共用同一份）。"""
    facts_by_doc: dict[str, list[Fact]] = {}
    for row in docs:
        key = str(row["id"])
        payload = _fact_source_payload(row)
        facts_by_doc[key] = extract_facts(payload, row.get("doc_type") or "other")

    baseline = _baseline_key(docs, facts_by_doc)
    if baseline is None:
        return {"ok": True, "domain": {"root": root, "doc_ids": [str(r["id"]) for r in docs]},
                "items": []}

    items: list[dict] = []
    diffs = diff_facts(facts_by_doc, root=baseline)
    for diff in diffs:
        items.append({
            "severity": "error" if diff.status == "conflict" else "warning",
            "code": diff.code,
            "key": diff.key,
            "status": diff.status,
            "baseline_doc": diff.baseline_doc,
            "values": diff.values,
            "detail": diff.detail_zh,
        })

    current = str(doc_id)
    if current != baseline and facts_by_doc.get(current) and facts_by_doc.get(baseline):
        error_keys = {item["key"] for item in items if item["severity"] == "error"}
        for check in lint_pair(facts_by_doc[baseline], facts_by_doc[current]):
            if check.ok or check.key in error_keys:
                continue
            items.append({
                "severity": "error",
                "code": _CHECK_CODE.get(check.status, FACT_CONFLICT),
                "key": check.key,
                "status": check.status,
                "baseline_doc": baseline,
                "values": {baseline: check.original, current: check.provided},
                "detail": "；".join(check.issues),
            })

    ok = not any(item["severity"] == "error" for item in items)
    return {"ok": ok,
            "domain": {"root": root, "doc_ids": [str(row["id"]) for row in docs]},
            "items": items}


@app.get("/api/v1/trade-docs/{doc_id}/consistency")
async def get_trade_doc_consistency(
    doc_id: int,
    request: Request,
    user: dict = Depends(_get_current_user),
):
    """跨单证事实矩阵（§4-B）：`diff_facts` + 对基线的 `lint_pair`。

    返回的 `items` 里 `severity` 三档对应产品形态：
    - `error`（✗ 冲突）→ 阻断导出/签发；
    - `warning`（⚠ 等价措辞 / 缺失）→ 可见但不阻断（"绝不静默吞差异"）；
    - `info`（✓ 一致）不逐条返回（只有差异才回来，否则一屏都是 ✓）。
    """
    d = await _doc_404(request, doc_id, user)
    root, docs = await _domain_docs(request, d)
    return _consistency_payload(d, doc_id, root, docs)


# ════════════════════════════════════════════════════════════════════════════
# P2 引擎 RPC：facts / consistency 的供数版（门面供数 → 内核纯算 → 原样回放）
# ════════════════════════════════════════════════════════════════════════════
# 纪律（与前面各批一致）：
# - 旧 handler 与 RPC 调用**同一份**纯函数（_facts_from_parts/_facts_payload、
#   _domain_docs_from_parts/_consistency_payload）；
# - RPC 不碰 DB（「零 DB 调用」由 tests 锁死）；
# - 读闸门复用 main 的 _require_doc_visible（404 DOC_NOT_FOUND，不泄露存在性）；
# - 产品解析降级路径与旧 _packing_of_doc 同一份（异常 ⇒ 按"无配置"降级）。


def _hardening_dataset_rows(datasets: dict, name: str) -> list:
    """payload.datasets[name] → 行数组（形状错误 = 实现 bug ⇒ 400；缺省 = 空）。"""
    rows = datasets.get(name)
    if rows is None:
        return []
    if not isinstance(rows, list):
        raise HTTPException(status_code=400, detail={
            "error": "engine_rpc_payload_invalid",
            "message": "datasets.%s 必须是数组" % name,
        })
    return rows


def _packing_from_datasets(snapshot: Optional[dict], datasets: dict, user: dict) -> dict:
    """供数版产品解析：tenant_products 行 → 有效定义 → 包装选择。

    与 _packing_of_doc 的降级口径完全相同：解析失败（引擎不可用 / 409 上游已变 /
    未知产品）一律按"无配置"降级，不影响其余事实。
    """
    if snapshot is None:
        return _packing_from_product(None, None)
    product = None
    product_key = str(snapshot.get("product_key") or "").strip()
    if product_key:
        try:
            from quote_api import _resolve_effective_raw  # noqa: PLC0415

            product = _resolve_effective_raw(
                _hardening_dataset_rows(datasets, "tenant_products"), user, product_key)
        except Exception:  # noqa: BLE001 - 有意兜底：与旧路径同一口径
            product = None
    return _packing_from_product(snapshot, product)


def facts_from_datasets(doc_id: int, datasets: dict, user: dict) -> dict:
    """P2 引擎 RPC：GET /trade-docs/{doc_id}/facts 的供数版（**同一份**判定与投影）。

    datasets：trade_docs（1 行）+ trade_doc_facts（处置行）+ tenant_products（全量 active，
    供包装解析用；旧路径按数据形状才查，多下发一份只读数据、语义等价）。
    """
    rows = _hardening_dataset_rows(datasets, "trade_docs")
    row = rows[0] if rows and isinstance(rows[0], dict) else None
    if row is None:
        _main._doc_not_found()
    d = _dp.doc_dict(_main._trade_doc_row_from_dataset(row))
    _main._require_doc_visible(user, d)
    if d.get("id") is not None and int(d["id"]) != int(doc_id):
        raise HTTPException(status_code=400, detail={
            "error": "engine_rpc_payload_invalid",
            "message": "datasets.trade_docs 与 request.doc_id 不一致",
        })
    snapshot = _packing_snapshot_of(d)
    packing = _packing_from_datasets(snapshot, datasets, user)
    fact_rows = [r for r in _hardening_dataset_rows(datasets, "trade_doc_facts")
                 if isinstance(r, dict)]
    return _facts_payload(d, doc_id, _facts_from_parts(d, packing, fact_rows))


def consistency_from_datasets(doc_id: int, datasets: dict, user: dict) -> dict:
    """P2 引擎 RPC：GET /trade-docs/{doc_id}/consistency 的供数版（**同一份**判定）。

    datasets：trade_docs（1 行）+ linked_order_links/linked_quote_links（边表兜底行）
    + trade_docs_by_order/trade_docs_by_quote（域内单证行，按旧 SQL 语义）。
    域判定由 _domain_docs_from_parts 重判一次（门面只是把三处查询按同一条件发出来）。
    """
    rows = _hardening_dataset_rows(datasets, "trade_docs")
    row = rows[0] if rows and isinstance(rows[0], dict) else None
    if row is None:
        _main._doc_not_found()
    d = _dp.doc_dict(_main._trade_doc_row_from_dataset(row))
    _main._require_doc_visible(user, d)
    if d.get("id") is not None and int(d["id"]) != int(doc_id):
        raise HTTPException(status_code=400, detail={
            "error": "engine_rpc_payload_invalid",
            "message": "datasets.trade_docs 与 request.doc_id 不一致",
        })
    root, docs = _domain_docs_from_parts(
        d,
        _hardening_dataset_rows(datasets, "linked_order_links"),
        _hardening_dataset_rows(datasets, "trade_docs_by_order"),
        _hardening_dataset_rows(datasets, "linked_quote_links"),
        _hardening_dataset_rows(datasets, "trade_docs_by_quote"),
    )
    return _consistency_payload(d, doc_id, root, docs)


_CHECK_CODE = {
    "conflict": FACT_CONFLICT,
    "immutable": FACT_IMMUTABLE,
    "missing": FACT_MISSING,
}


# ─── 5) 组合 lint（blocking / warnings）──────────────────────────────────

async def _broken_refs(request: Request, d: dict) -> list[dict]:
    """指向的单证必须**存在且已签发**（§4-D 引用完整性）。"""
    rows = await _db().fetch(request, _SQL_OUTGOING_REFS, DEFAULT_TENANT, d["id"])
    broken = []
    for row in rows or []:
        item = dict(row)
        if item.get("target_doc_id") is None or item.get("status") != "issued":
            broken.append({
                "code": DOC_REF_BROKEN,
                "target_doc_id": item.get("target_id"),
                "doc_no": item.get("doc_no"),
                "doc_type": item.get("doc_type"),
                "status": item.get("status"),
                "detail": (
                    f"引用的单证 {item.get('doc_no') or item.get('target_id')} "
                    f"不存在或未签发（status={item.get('status')}）——"
                    "派生单只能引用已确认（issued）的单证"
                ),
            })
    return broken


async def _doc_set_conflicts(request: Request, d: dict) -> list[dict]:
    """清单说"不该我方出"，却真的开了这类单据 ⇒ `DOC_SET_NOT_ALLOWED`（§4-C）。"""
    rows = await _db().fetch(request, _SQL_DOC_SET_ROWS, DEFAULT_TENANT, d["id"])
    not_by_us = [dict(row)["doc_type"] for row in rows or []
                 if dict(row).get("role") == "not_by_us"]
    if not not_by_us:
        return []
    found = await _db().fetch(request, _SQL_DOCS_OF_TYPES, DEFAULT_TENANT,
                           not_by_us, d.get("order_id"), d.get("customer_id"))
    conflicts = []
    for row in found or []:
        item = dict(row)
        conflicts.append({
            "code": DOC_SET_NOT_ALLOWED,
            "doc_type": item["doc_type"],
            "doc_id": item["id"],
            "doc_no": item.get("doc_no"),
            "detail": (
                f"清单把「{item['doc_type']}」标为 not_by_us（对方出单），"
                f"但同交易域已存在该类型单据 {item.get('doc_no') or item['id']}；"
                "我方越权出单，请删除/作废该单据或改清单责任方"
            ),
        })
    return conflicts


def _amount_conflicts(d: dict, items: list[dict]) -> list[dict]:
    """单证合计 = 行项目推导合计（内核单源推导规则 3 的事后核对）。

    与 `confirm` 里的 `check_amount_reconciliation` 不同：这里**不阻断**
    （那是签发前的硬校验），只作为 lint 的 warning 提前暴露，让业务员在编辑期就看到。
    """
    if not items:
        return []
    total = Decimal("0")
    for index, item in enumerate(items, 1):
        amount = _as_decimal(item.get("line_amount"))
        if amount is None:
            try:
                amount = derive_amount(item.get("qty"), item.get("unit_price"))
            except Exception:  # noqa: BLE001 - 有意兜底：缺数量/单价交给确认必填校验报，不在此重复
                return []
        total += amount
    violations = check_derived_amount(decimal_text(total), d.get("total_amount"),
                                      key="total_amount")
    return [{
        "code": FACT_CONFLICT,
        "key": "total_amount",
        "detail": violation.detail,
        "expected": violation.original,
        "provided": violation.provided,
    } for violation in violations]


async def collect_lint(
    request: Request,
    d: dict,
    *,
    items: Optional[list[dict]] = None,
    facts: Optional[list[Fact]] = None,
) -> tuple[list[dict], list[dict]]:
    """组合检查 → (blocking, warnings)。

    blocking（阻断签发/导出）：`FACT_UNVERIFIED` / `FACT_IMMUTABLE` /
    `DOC_REF_BROKEN` / `DOC_SET_NOT_ALLOWED`（计划 §8-1/2/3/5/4）。
    warning（可见不阻断）：`FACT_CONFLICT`（金额推导对不上，签发前另有硬校验）。

    `items`/`facts` 可由调用方传入（confirm 已经取过，避免重复查询）。
    注意：本函数**只用 `db.fetch`**，不用 `fetchrow/fetchval` —— confirm 的既有测试
    用队列式假 db，多出来的单行查询会把后续装配的行错位（实测会 500）。
    """
    if facts is None:
        facts = await _facts_of(request, d)
    if items is None:
        rows = await _db().fetch(
            request,
            "SELECT product_name, qty, unit_price, line_amount FROM trade_doc_items"
            " WHERE tenant_id=$1 AND trade_doc_id=$2 ORDER BY sort_order, id",
            DEFAULT_TENANT, d["id"], table="trade_doc_items",
        )
        items = [dict(row) for row in rows or []]

    blocking: list[dict] = []
    warnings: list[dict] = []

    # a) 信任级闸门（§8-2）
    currency = str(d.get("currency") or "")
    for violation in gate_trust(facts, "issued"):
        blocking.append({
            "code": violation.code,
            "keys": list(violation.keys),
            "detail": violation.detail,
            "evidence_ref": violation.evidence_ref,
        })

    # b) 不可改写（§8-3）：派生单对"当初继承来的基线值"
    for violation in check_immutable(_baseline_facts(d), facts, currency=currency):
        blocking.append({
            "code": violation.code,
            "keys": list(violation.keys),
            "original": violation.original,
            "provided": violation.provided,
            "detail": violation.detail,
        })

    # c) 引用完整性（§8-5）
    blocking.extend(await _broken_refs(request, d))

    # d) 单证清单责任方（§8-4）
    blocking.extend(await _doc_set_conflicts(request, d))

    # e) 金额推导（warning；签发前另有 AMOUNT_MISMATCH 硬校验）
    warnings.extend(_amount_conflicts(d, items))

    return blocking, warnings


@app.post("/api/v1/trade-docs/{doc_id}/lint")
async def lint_trade_doc(
    doc_id: int,
    request: Request,
    user: dict = Depends(_get_current_user),
):
    """签发前预检：`ok=false` ⇒ blocking 非空（与 confirm 闸门同一份判定）。

    A12：额外把「单证清单触发条件」作为 **warning** 挂出来（不阻断）——
    `required` 项条件不满足时提示"本次不出该单证"，条件无法求值时提示原因。
    这两个 warning 只在 `/lint` 出现，**不进 confirm 闸门**（避免历史单据误伤）。
    """
    d = await _doc_404(request, doc_id, user)
    facts = await _facts_of(request, d, user)
    blocking, warnings = await collect_lint(request, d, facts=facts)
    warnings.extend(await _trigger_warnings(request, d, facts))
    return {
        "doc_id": doc_id,
        "ok": not blocking,
        "blocking": blocking,
        "warnings": warnings,
        "summary": {
            "blocking": len(blocking),
            "warnings": len(warnings),
            "facts": _summary(facts),
        },
    }


async def confirm_blocking(
    request: Request,
    d: dict,
    items: list[dict],
    facts: Optional[list[Fact]] = None,
) -> list[dict]:
    """签发闸门（供 `ws_docs_ext.confirm_trade_doc` 调用）—— 只返回 blocking。"""
    blocking, _warnings = await collect_lint(request, d, items=items, facts=facts)
    return blocking


async def record_confirm_override(
    request: Request,
    d: dict,
    user: dict,
    blocking: list[dict],
) -> None:
    """签发闸门被**越过**时留痕（`allow_lint_override=true`）。

    越过必须有凭据：谁、越过的是哪几项 blocking。默认不开放给前端
    （任务书口径），只在明确的运维/紧急场景由内部账号使用；
    审计写 `business_events`，与其它跨工位事件同一张表同一形状。
    """
    await _main._record_business_event(
        request, "trade_doc.confirm_override",
        {
            "doc_id": d.get("id"), "doc_no": d.get("doc_no"),
            "actor_id": str(user.get("id")),
            "blocking": blocking,
        },
        from_ws="trade_doc",
    )


# ─── 6) 收款登记（§4-E，容差口径见 receipt_rules）─────────────────────────

@app.get("/api/v1/trade-docs/{doc_id}/receipts")
async def list_trade_doc_receipts(
    doc_id: int,
    request: Request,
    user: dict = Depends(_get_current_user),
):
    """收款登记列表（按到账时间倒序）。"""
    await _doc_404(request, doc_id, user)
    rows = await _db().fetch(request, _SQL_RECEIPTS, DEFAULT_TENANT, doc_id)
    items = []
    for row in rows or []:
        item = dict(row)
        for key in ("schedule_amount", "received_amount", "diff", "fx_rate_used"):
            if item.get(key) is not None:
                item[key] = decimal_text(item[key])
        item["received_at"] = _iso(item.get("received_at"))
        item["created_at"] = _iso(item.get("created_at"))
        items.append(item)
    return {"doc_id": doc_id, "items": items, "total": len(items)}


@app.post("/api/v1/trade-docs/{doc_id}/receipts", status_code=201)
async def create_trade_doc_receipt(
    doc_id: int,
    request: Request,
    body: ReceiptIn,
    user: dict = Depends(_get_current_user),
):
    """登记一笔收款并当场判定核销（`UNCERTAIN #17 ③` 每币种 max(5 美分等值, 0.1%)）。

    - 差额在容差内 ⇒ `status=reconciled` + `diff_reason=fx_rounding`（银行手续费/汇率尾差）；
    - 超容差 ⇒ `status=short_paid`（挂账告警，等业务决定催收还是让利）；
    - 没给账期金额（手工登记）⇒ `status=manual`（无从核销，不冒充"已核销"）。

    判定完全交给内核 `receipt_rules.classify_receipt_diff`（与收款台账同一把尺子），
    本文件不做第二套阈值。
    """
    d = await _doc_404(request, doc_id, user)
    # C27b：登记收款属加固写操作 ⇒ 仅团队管理员/internal（可见性 404 先判）。
    await _main._require_doc_issuer(request, user, d)
    _require_not_void(d)
    currency = (body.currency or d.get("currency") or "USD").upper()
    if currency not in CURRENCY:
        raise _error(422, INVALID_ENUM, f"未知币种：{currency}（可选 {list(CURRENCY)}）")
    if body.schedule_type is not None and body.schedule_type not in SCHEDULE_TYPE:
        raise _error(422, INVALID_ENUM,
                     f"未知账期类型：{body.schedule_type}（可选 {list(SCHEDULE_TYPE)}）")

    received_amount = _as_decimal(body.received_amount)
    if received_amount is None:
        raise _error(422, INVALID_RECEIPT, f"实收金额非法：{body.received_amount!r}")
    schedule_amount = _as_decimal(body.schedule_amount)
    if body.schedule_amount is not None and schedule_amount is None:
        raise _error(422, INVALID_RECEIPT, f"账期金额非法：{body.schedule_amount!r}")

    received_at = datetime.now(timezone.utc)
    if body.received_at:
        try:
            received_at = datetime.fromisoformat(str(body.received_at).replace("Z", "+00:00"))
        except ValueError:
            raise _error(422, INVALID_RECEIPT,
                         f"到账时间不是 ISO 时间：{body.received_at!r}")
        if received_at.tzinfo is None:
            # timestamptz 列不收 naive 时间：无时区按 UTC 处理（与库的 now() 同基准）
            received_at = received_at.replace(tzinfo=timezone.utc)

    verdict = classify_receipt_diff(schedule_amount, received_amount, currency)
    if verdict.diff_reason == "manual":
        # 没有账期金额（手工登记）⇒ 无从核销，如实记 manual，不冒充"已核销"
        status = "manual"
    elif verdict.auto_cleared:
        status = "reconciled"
    else:
        status = "short_paid"
    row = await _db().fetchrow(
        request, _SQL_RECEIPT_INSERT,
        DEFAULT_TENANT, doc_id, body.schedule_type, schedule_amount, received_amount,
        currency, received_at, body.bank_ref, verdict.diff, verdict.diff_reason,
        _as_decimal(body.fx_rate_used), status, body.notes, str(user.get("id")),
    )
    item = dict(row) if row is not None else {}
    for key in ("schedule_amount", "received_amount", "diff", "fx_rate_used"):
        if item.get(key) is not None:
            item[key] = decimal_text(item[key])
    item["received_at"] = _iso(item.get("received_at"))
    return {
        "doc_id": doc_id,
        "item": item,
        # 前端提示口径：容差与判定理由一并回传，避免"为什么自动核销了"的追问
        "verdict": {
            "diff": decimal_text(verdict.diff),
            "tolerance": decimal_text(verdict.tolerance),
            "auto_cleared": verdict.auto_cleared,
            "diff_reason": verdict.diff_reason,
        },
    }


# ─── 7) 单证清单（§4-C）──────────────────────────────────────────────────

def _doc_set_dict(row: dict) -> dict:
    return {
        "doc_type": row["doc_type"],
        "role": row.get("role"),
        "issuer": row.get("issuer"),
        "trigger_expr": row.get("trigger_expr"),
        "evidence_required": bool(row.get("evidence_required")),
        "status": row.get("status"),
        "waived_reason": row.get("waived_reason"),
        "received_doc_id": row.get("received_doc_id"),
        "received_at": _iso(row.get("received_at")),
    }


async def _doc_set_items(request: Request, doc_id: int) -> list[dict]:
    rows = await _db().fetch(request, _SQL_DOC_SET_ROWS, DEFAULT_TENANT, doc_id)
    return [_doc_set_dict(dict(row)) for row in rows or []]


def _facts_map(facts: list[Fact]) -> dict:
    """事实列表 → 求值器入参（`Fact.value` 恒为归一字符串，与 facts 端点同源）。"""
    return {fact.key: fact.value for fact in facts}


async def _trigger_warnings(
    request: Request,
    d: dict,
    facts: list[Fact],
) -> list[dict]:
    """A12：`/lint` 的触发条件 warning（**不阻断**）。

    - `DOC_SET_TRIGGER_SKIPPED`：`role=required` 但条件不满足 ⇒ 本次不出该单证；
    - `DOC_SET_TRIGGER_ERROR`：条件无法求值（未知键/类型错/历史坏表达式）⇒ 提示修正。
      不把"无法求值"当 blocking：条件写错不应拦住签发（那是清单维护问题），
      但也不能静默 —— 以 warning 让业务员在编辑期看到。
    """
    items = resolve_doc_set(await _doc_set_items(request, d["id"]), _facts_map(facts))
    warnings: list[dict] = []
    for item in items:
        if item.get("role") != "required":
            continue
        doc_type = item.get("doc_type")
        expr = item.get("trigger_expr")
        error = item.get("trigger_error")
        if error:
            warnings.append({
                "code": DOC_SET_TRIGGER_ERROR,
                "doc_type": doc_type,
                "trigger_expr": expr,
                "trigger_error": error,
                "detail": (
                    f"单证清单项「{doc_type}」的触发条件无法求值"
                    f"（{error.get('code')}: {error.get('message')}）——"
                    "无法判断是否需要该单证，先按适用处理；请修正 trigger_expr"
                ),
            })
        elif item.get("applicable") is False:
            warnings.append({
                "code": DOC_SET_TRIGGER_SKIPPED,
                "doc_type": doc_type,
                "trigger_expr": expr,
                "detail": (
                    f"单证清单项「{doc_type}」的触发条件不满足（{expr}）—— "
                    "本次不出该单证（required；仅提示，不阻断签发）"
                ),
            })
    return warnings


@app.get("/api/v1/trade-docs/{doc_id}/doc-set")
async def get_trade_doc_doc_set(
    doc_id: int,
    request: Request,
    user: dict = Depends(_get_current_user),
):
    """单证清单（这一次交易该出哪些单证、谁出、要不要回执）。

    A12：每项追加 `applicable`（条件是否成立）/ `skipped_by_trigger`（required
    且条件为假）/ `trigger_reason`，无法求值时再给 `trigger_error`。事实来源与
    `/facts` 同一入口（`extract_facts` + 表内处置叠加），不另算一份。
    """
    d = await _doc_404(request, doc_id, user)
    items = await _doc_set_items(request, doc_id)
    facts = await _facts_of(request, d, user)
    return {
        "doc_id": doc_id,
        "items": resolve_doc_set(items, _facts_map(facts)),
        "total": len(items),
    }


@app.put("/api/v1/trade-docs/{doc_id}/doc-set")
async def put_trade_doc_doc_set(
    doc_id: int,
    request: Request,
    body: DocSetIn,
    user: dict = Depends(_get_current_user),
):
    """全量替换单证清单（事务内 delete + upsert）。

    为什么是 upsert 而不是"删光重建"：清单项上挂着**回执登记**（`status` /
    `received_doc_id` / `waived_reason`）。收全对方单据之后业务员再调一次清单
    （只是补一项），若删光重建会把已登记的回执抹掉 —— 那是数据丢失，不是"替换清单"。
    所以：**不在新清单里的行删除，仍在的保留回执状态**（doc_type 为天然主键）。
    """
    d = await _doc_404(request, doc_id, user)
    # C27b：单证清单全量替换属加固写操作 ⇒ 仅团队管理员/internal。
    await _main._require_doc_issuer(request, user, d)
    _require_not_void(d)

    seen: set[str] = set()
    for item in body.items:
        if item.doc_type not in DOC_TYPE:
            raise _error(422, DOC_SET_INVALID,
                         f"未知单证类型：{item.doc_type}（可选 {list(DOC_TYPE)}）")
        if item.role not in DOC_SET_ROLES:
            raise _error(422, DOC_SET_INVALID,
                         f"未知清单角色：{item.role}（可选 {list(DOC_SET_ROLES)}）")
        if item.issuer not in DOC_SET_ISSUERS:
            raise _error(422, DOC_SET_INVALID,
                         f"未知出单方：{item.issuer}（可选 {list(DOC_SET_ISSUERS)}）")
        if item.doc_type in seen:
            raise _error(409, DOC_SET_DUPLICATE,
                         f"清单里同一单证类型重复：{item.doc_type}")
        seen.add(item.doc_type)
        # A12：新表达式先做**语法/复杂度**校验（只解析不求值 —— 事实键允许随
        # payload 演进，未知键在读取时以 trigger_error 暴露，不在这里拦）。
        # 坏表达式一律 422 且**不落库**，避免把"永远求值失败"的清单写进历史。
        if item.trigger_expr is not None and str(item.trigger_expr).strip():
            try:
                validate_trigger(str(item.trigger_expr))
            except TriggerError as exc:
                raise _error(
                    422, TRIGGER_EXPR_INVALID,
                    f"单证清单项「{item.doc_type}」的触发条件无效：{exc.message}",
                    trigger_error=exc.as_dict(),
                ) from exc

    doc_types = [item.doc_type for item in body.items]
    async with _main._acquire(request) as conn:
        async with conn.transaction():
            # 先删"新清单里没有的"，再 upsert 其余 —— 已登记的回执不因改清单而丢
            await conn.execute(_SQL_DOC_SET_DELETE_UNLISTED,
                               DEFAULT_TENANT, doc_id, doc_types)
            if body.items:
                await conn.execute(
                    _SQL_DOC_SET_UPSERT,
                    DEFAULT_TENANT, doc_id,
                    doc_types,
                    [item.role for item in body.items],
                    [item.issuer for item in body.items],
                    [item.trigger_expr for item in body.items],
                    [bool(item.evidence_required) for item in body.items],
                )
    return {"doc_id": doc_id, "items": await _doc_set_items(request, doc_id)}


@app.post("/api/v1/trade-docs/{doc_id}/doc-set/{doc_type}/receipt")
async def record_doc_set_receipt(
    doc_id: int,
    doc_type: str,
    request: Request,
    body: DocSetReceiptIn,
    user: dict = Depends(_get_current_user),
):
    """`not_by_us` 单证的**回执登记**（`UNCERTAIN #17 ④`）：pending → received | waived。

    - `receive`：对方已提供 ⇒ 状态 received（可登记对方单证 id，须存在）；
    - `waive`  ：确实不需要 ⇒ 状态 waived（**必须**写原因，否则无法审计"为什么没要"）。

    非法转移（已 received 又 waive、已 waived 又 receive）⇒ 409，不静默覆盖。
    """
    d = await _doc_404(request, doc_id, user)
    # C27b：回执登记（receive/waive）属加固写操作 ⇒ 仅团队管理员/internal。
    await _main._require_doc_issuer(request, user, d)
    action = (body.action or "").strip().lower()
    if action not in ("receive", "waive"):
        raise _error(422, INVALID_ENUM,
                     f"未知回执动作：{body.action!r}（可选 receive | waive）")
    if action == "waive" and not (body.waived_reason or "").strip():
        raise _error(422, DOC_SET_INVALID, "豁免（waive）必须填写原因")

    target_status = "received" if action == "receive" else "waived"
    waived_reason = (body.waived_reason or "").strip() or None

    if body.received_doc_id is not None:
        exists = await _db().fetch(request, _SQL_DOC_EXISTS, DEFAULT_TENANT,
                                body.received_doc_id)
        if not exists:
            raise _error(404, "DOC_NOT_FOUND",
                         f"回执登记的单证不存在：{body.received_doc_id}")

    row = await _db().fetchrow(
        request, _SQL_DOC_SET_RECEIPT,
        DEFAULT_TENANT, doc_id, doc_type, target_status, waived_reason,
        body.received_doc_id if action == "receive" else None,
    )
    if row is None:
        current = await _db().fetch(request, _SQL_DOC_SET_ITEM, DEFAULT_TENANT, doc_id, doc_type)
        if not current:
            raise _error(404, DOC_SET_ITEM_NOT_FOUND,
                         f"单证清单里没有「{doc_type}」这一项")
        status = dict(current[0]).get("status")
        raise _error(409, ILLEGAL_DOC_SET_TRANSITION,
                     f"清单项「{doc_type}」当前状态 {status}，不能转为 {target_status}",
                     current=status)
    return {"doc_id": doc_id, "item": _doc_set_dict(dict(row))}


# ─── 8) 导出后自检（§4-F / §8-7）─────────────────────────────────────────

def _squash(text: Any) -> str:
    """自检用的文本归一：先按内核排版归一，再**去掉全部空白**。

    为什么连换行也去掉：PDF 抽取出的文本会在词中间断行/插空格
    （`two thou-\nsand`），按行比对会把"没截断"误报成"文本缺失"——
    原型脚本 `verify_tim_post_pi.py` 用的就是去空白比对。
    """
    return re.sub(r"\s+", "", normalize_text(text))


@app.post("/api/v1/trade-docs/{doc_id}/verify-export")
async def verify_trade_doc_export(
    doc_id: int,
    request: Request,
    body: VerifyExportIn,
    user: dict = Depends(_get_current_user),
):
    """导出后自检：源文本是否都出现在 PDF 里 + 图片计数是否相符。

    判定（§8-7 的两条真实翻车）：
    - **文本缺失**：某个单元格文本在 PDF 文本里找不到 ⇒ 大概率被行高截断/遮挡；
    - **图片计数不符**：期望 1 张公章却抽出 2 张（劈页）或 0 张（没盖）。

    失败策略（`UNCERTAIN #17 ⑤` 裁决）：**默认阻断**（422 `EXPORT_SELF_CHECK_FAILED`）；
    `allow_override=true` 时放行（200 + `overridden=true`）并写审计事件 ——
    越过必须是**留痕动作**，而不是把校验关掉。
    PDF 的文本抽取与图片计数由前端做（后端零图像库，见方案 §F 的实现对照）。
    """
    d = await _doc_404(request, doc_id, user)
    # C27b：导出后自检（含 allow_override 放行）属加固写操作 ⇒ 仅团队管理员/internal。
    await _main._require_doc_issuer(request, user, d)

    pdf_text = _squash(body.pdf_text)
    missing_texts = [
        text for text in body.texts
        if text and text.strip() and _squash(text) not in pdf_text
    ]

    expected = dict(DEFAULT_EXPECTED_IMAGES)
    if body.expected_image_counts is not None:
        expected.update(body.expected_image_counts)
    image_mismatches = []
    for key, want in expected.items():
        got = int(body.image_counts.get(key, 0) or 0)
        if got != int(want):
            image_mismatches.append({"key": key, "expected": int(want), "actual": got})

    checked = {
        "texts": len([text for text in body.texts if text and text.strip()]),
        "missing_texts": missing_texts,
        "image_mismatches": image_mismatches,
    }
    ok = not missing_texts and not image_mismatches

    if ok:
        return {"doc_id": doc_id, "ok": True, "overridden": False, **checked}

    if not body.allow_override:
        raise _error(
            422, EXPORT_SELF_CHECK_FAILED,
            "导出后自检未通过：文本缺失或图片计数不符，请先修正版式（默认阻断导出）",
            missing_texts=missing_texts,
            image_mismatches=image_mismatches,
            checked=checked,
        )

    # 越过：留痕（谁、什么时候、缺了什么/计数怎么不对）—— 审计是越过的唯一凭据
    await _main._record_business_event(
        request, "trade_doc.export_override",
        {
            "doc_id": doc_id, "doc_no": d.get("doc_no"),
            "actor_id": str(user.get("id")),
            "missing_texts": missing_texts,
            "image_mismatches": image_mismatches,
        },
        from_ws="trade_doc",
    )
    return {"doc_id": doc_id, "ok": True, "overridden": True, **checked}



