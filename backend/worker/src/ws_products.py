"""租户级产品定义 + 报价工位权限矩阵（Worker 镜像 · 生产对齐）。

与 orchestrator 的 `app/api/tenant_products.py` / `app/api/workstation_products.py`
对齐，但用 asyncpg 直连（Worker 的 Hyperdrive 连接模式）。

为什么需要这个文件
------------------
产品定义配置化（`tenant_products` / `tenant_workstation_products`）此前只在
orchestrator 落地，线上 Worker 没有对应路由 —— 前端 `/settings/tenant-products`
一上生产就是 404，与 fx-rates / actual-costs / external-docs 是同一类漂移。

对齐口径（与 orchestrator 逐条一致）
------------------------------------
- **租户隔离**：租户级产品按调用者租户过滤；系统级产品（`is_system=true`）
  对所有租户可见（见 docs/PRODUCT_CONFIG_TENANT_UNFINISHED.md 权限矩阵）。
- **系统级只读**：改/删系统级产品 → 403（平台管理员在 orchestrator 侧维护）。
- **spec 深度校验**：复用报价引擎 `spec_from_dict`（`scripts/sync-shared.ps1`
  已把引擎打包进 `kaas_common.export_quote`）；引擎未随包时降级为不校验、
  不阻断写库 —— 与 `quote_api.py` 的降级口径一致。
- **工位订阅**：`/workstation-products`（产品启停矩阵）属**工位功能** —— 报价工位未订阅
  → 404 `SUBSCRIPTION_REQUIRED`，且不写任何数据。判据与 B3「工位开通」**同源**
  （团队级 `team_subscriptions`），并 union 历史租户级 `tenant_subscriptions` 作兼容
  （2026-10-21 修：原先只读租户表，而全仓没有写该表的 HTTP 路由 ⇒ 团队开通了也恒 404）。
- **产品定义 CRUD 不受工位订阅约束**：`/tenant-products` 在共享内核
  `workstation/subscriptions.py` 的 `ALWAYS_ALLOWED_PREFIXES`（"产品定义属'我的'配置，
  不按工位收费"）⇒ 未订阅也能读写本团队的产品定义。旧注释写的"未订阅不写任何数据"
  只对 `/workstation-products` 成立（2026-10-21 验收实测：未订阅成员 GET 200 / POST 201）。
- **写/删的团队边界**：与列表同一把尺 `is_same_team` ⇒ 非本团队一律 404（P0 修复，
  见 `_writable_by`；此前只校验 `tenant_id` ⇒ 同租户可跨团队改/删）。
"""
from __future__ import annotations

import json
from typing import Optional

from fastapi import Depends, HTTPException, Query, Request
from pydantic import BaseModel

from kaas_common.workstation.product_scope import is_same_team

import main as _main

app = _main.app
_get_current_user = _main._get_current_user
_acquire = _main._acquire
DEFAULT_TENANT = _main.DEFAULT_TENANT

# 报价工位订阅编码：`full_chain` 是全工位包（docs/WORKSTATION_DESIGN.md §5.4.1）。
# `quotes` 是 B3「工位开通」里可单独勾选的工位 key（`kaas_common/workstation/
# subscriptions.py` 的 `WORKSTATION_PATHS`）—— 团队只开单工位时也必须能进矩阵，
# 否则会出现「B3 显示已开通、产品矩阵却 404」的自相矛盾。
QUOTE_SUB_CODES = ("full_chain", "quotes")

# 有效订阅的 SQL 片段（与 `ws_workstations.py:46` 的 `_LIVE` 逐字同义）：
# active 且未过期（expires_at 为空 = 永久）。
_LIVE_SUB = "active = true AND (expires_at IS NULL OR expires_at > now())"

# PUT 允许更新的列（白名单：列名直接拼进 SQL，不接受任何外部输入）
_UPDATABLE_COLUMNS = (
    "product_key", "product_name", "product_name_en", "category_code",
    "cost_field", "cost_basis", "cost_unit",
    "profit_mode", "profit_value", "misc_fee_rate",
    "spec", "override", "is_active",
)


# ── Helpers ─────────────────────────────────────────────────────────────────

def _tenant_of(user: dict) -> str:
    """调用者租户。Worker 的 user dict 目前不带 tenant_id（单租户部署），
    此时回落到 DEFAULT_TENANT，与 main.py 其余路由同一口径。"""
    tid = user.get("tenant_id")
    return tid if isinstance(tid, str) and tid else DEFAULT_TENANT


def _writable_by(user: dict, row) -> bool:
    """写/删权限：**与列表同一把尺**（共享内核 `is_same_team`）。

    P0（2026-10-21 B 组验收真机复现）：此前 PUT/DELETE 只校验 `tenant_id`，
    而单租户下有多个团队 ⇒ team2 的普通账号拿 id 就能改/删 team1 的产品
    （列表/报价发现里根本看不到它，写路径却放行，且删除会连带清
    product_profiles / tenant_workstation_products / 图片当前标记）。

    判据与列表 `:205` 那段**完全一致**，不新造第二套口径：
    - 管理员（`_can_see_all`）不受限；
    - 有团队的行：`is_same_team`（同团队才可写；管理员分支已在上面返回）；
    - 历史 `team_id IS NULL` 行：只有**没有团队**的调用者能写 —— 他们自己创建的
      产品本来就落成 NULL（`create` 用 `user.get("team_id")`），写读对称。
    """
    if _main._can_see_all(user):
        return True
    row_team = row.get("team_id")
    if row_team is None:
        return user.get("team_id") is None
    return is_same_team(
        role=user.get("role"),
        viewer_team_id=user.get("team_id"),
        row_team_id=row_team,
    )


def _validate_spec(spec: dict) -> None:
    """spec 必须能转成 ProductSpec，否则 422。

    引擎未随包（`kaas_common.export_quote` 导入失败）时降级为不校验 ——
    与 quote_api.py 的降级保护一致：宁可放行写库，也不要因为打包缺失
    把整个产品配置页打死。
    """
    try:
        from kaas_common.export_quote.tenant_products import (  # noqa: PLC0415
            spec_from_dict,
        )
    except ImportError:
        return
    try:
        spec_from_dict(spec)
    except Exception as exc:  # 有意兜底：引擎校验异常类型不止一种，一律转 422 带出原文
        raise HTTPException(status_code=422, detail={
            "error": "invalid_spec", "message": str(exc),
        })


def _spec_fingerprint(spec: dict):
    from kaas_common.export_quote.spec_delta import spec_fingerprint  # noqa: PLC0415
    return spec_fingerprint(spec)


def _validate_override(spec: dict, override: Optional[dict]) -> None:
    """差异形状闸门（与 dev tenant_products._validate_override 同口径）：
    基线 + 差异能合并出 ProductSpec 才允许落库，否则 422。"""
    if not override:
        return
    try:
        from kaas_common.export_quote.effective_spec import (  # noqa: PLC0415
            resolve_effective_product,
        )
        from kaas_common.export_quote.spec_delta import SpecDeltaError  # noqa: PLC0415
    except ImportError:
        return
    try:
        resolve_effective_product(spec, override)
    except SpecDeltaError as exc:
        raise HTTPException(status_code=422, detail={
            "error": "invalid_override", "message": str(exc),
        })


async def _require_quote_subscription(conn, user: dict) -> None:
    """报价工位订阅校验。未订阅 → 404（不暴露存在性，与 subs.py 同语义）。

    判据与 B3「工位开通」**同源**（2026-10-21 修）：
      · 团队级 `team_subscriptions`（B3 的 `PUT /teams/{id}/subscriptions/{code}` 写它；
        中间件 `/me/workstations` 也读它 —— 同一套 `has_workstation` 语义）；
      · union 历史租户级 `tenant_subscriptions`（迁移 20260921 的
        `('default','full_chain')` 种子；旧部署靠它，切团队级后仍需兼容）。

    为什么必须 union 而不是直接换表：全仓**没有任何 HTTP 路由写** `tenant_subscriptions`，
    旧实现只读它 ⇒ 团队开通了 full_chain 也恒 404（本机空库实测）；
    而生产库由迁移建出、有该种子行 ⇒ 直接换表会让生产行为突变。
    union 同时满足"B3 开通即生效"与"旧数据不回归"。
    """
    ok = await conn.fetchval(
        "SELECT 1 FROM ("
        "  SELECT 1 FROM team_subscriptions"
        f"   WHERE team_id=$1 AND code=ANY($2) AND {_LIVE_SUB}"
        "  UNION ALL"
        "  SELECT 1 FROM tenant_subscriptions"
        "   WHERE tenant_id=$3 AND code=ANY($2) AND active=true"
        ") AS live LIMIT 1",
        user.get("team_id"), list(QUOTE_SUB_CODES), DEFAULT_TENANT,
    )
    if not ok:
        raise HTTPException(status_code=404, detail={
            "error": "not_found", "code": "SUBSCRIPTION_REQUIRED",
            "workstation": "quote", "required_any": list(QUOTE_SUB_CODES),
            "detail": "未订阅该工位，请先开通对应订阅编码",
        })


def _product_out(r) -> dict:
    """行 → 输出（与 orchestrator 的 _row_to_out 字段/默认值逐条对齐）。"""
    return {
        "id": r["id"],
        "product_key": r["product_key"],
        "product_name": r["product_name"],
        "product_name_en": r["product_name_en"],
        "category_code": r["category_code"],
        "cost_field": r["cost_field"] or "raw_price",
        "cost_basis": r["cost_basis"] or "pretax",
        "cost_unit": r["cost_unit"],
        "profit_mode": r["profit_mode"] or "margin_on_price",
        "profit_value": float(r["profit_value"]) if r["profit_value"] is not None else 0.06,
        "misc_fee_rate": float(r["misc_fee_rate"]) if r["misc_fee_rate"] is not None else 0.03,
        # 完整 spec 快照（编辑器数据源）—— Workers 里 jsonb 返回成 str，需解码；
        # 漏掉会让编辑器「打开即丢数据」。用 .get 容忍最小 row（测试 fixture）。
        "spec": (
            json.loads(r["spec"])
            if isinstance(r.get("spec"), str)
            else (r.get("spec") or {})
        ),
        "is_system": bool(r["is_system"]),
        "is_active": bool(r["is_active"]),
        "created_at": r["created_at"].isoformat() if r["created_at"] else None,
    }


# ── Schemas ─────────────────────────────────────────────────────────────────

class TenantProductIn(BaseModel):
    product_key: str
    product_name: str
    product_name_en: Optional[str] = None
    category_code: Optional[str] = None
    cost_field: str = "raw_price"
    cost_basis: str = "pretax"
    cost_unit: Optional[str] = None
    profit_mode: str = "margin_on_price"
    profit_value: float = 0.06
    misc_fee_rate: float = 0.03
    spec: dict
    # P13（202610170002）：团队差异（spec_delta 形态）；null = 直接用基线
    override: Optional[dict] = None
    is_active: bool = True


class WorkstationProductIn(BaseModel):
    product_key: str
    is_enabled: bool = True


# ── 产品定义 CRUD ───────────────────────────────────────────────────────────

@app.get("/api/v1/tenant-products")
async def list_tenant_products(
    request: Request,
    tenant_id: Optional[str] = None,
    is_active: Optional[bool] = None,
    limit: int = Query(default=50, ge=1, le=500),
    user: dict = Depends(_get_current_user),
):
    """产品列表：本租户的产品 + 系统级产品（所有租户可见）。

    `tenant_id` 显式传入时以它为准（平台侧排查用），否则默认只回本租户 ——
    避免跨租户读到别家产品定义。
    """
    tid = tenant_id or _tenant_of(user)
    conds = ["(tenant_id = $1 OR is_system = true)"]
    params: list = [tid]
    if not _main._can_see_all(user):
        team = user.get("team_id")
        if team is None:
            conds.append("(is_system = true OR team_id IS NULL)")
        else:
            params.append(team)
            conds.append(f"(is_system = true OR team_id = ${len(params)})")
    if is_active is not None:
        params.append(is_active)
        conds.append(f"is_active = ${len(params)}")
    params.append(limit)
    async with _acquire(request) as conn:
        rows = await conn.fetch(
            f"SELECT * FROM tenant_products WHERE {' AND '.join(conds)}"
            f" ORDER BY created_at DESC LIMIT ${len(params)}",
            *params,
        )
    return [_product_out(r) for r in rows]


@app.post("/api/v1/tenant-products", status_code=201)
async def create_tenant_product(
    request: Request,
    body: TenantProductIn,
    user: dict = Depends(_get_current_user),
):
    _validate_spec(body.spec)
    _validate_override(body.spec, body.override)
    tid = _tenant_of(user)
    async with _acquire(request) as conn:
        try:
            r = await conn.fetchrow(
                "INSERT INTO tenant_products"
                " (tenant_id, team_id, product_key, product_name, product_name_en, category_code,"
                "  cost_field, cost_basis, cost_unit, profit_mode, profit_value,"
                "  misc_fee_rate, spec, override, base_spec_hash, is_system, is_active)"
                " VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15,false,$16)"
                " RETURNING *",
                tid, user.get("team_id"), body.product_key, body.product_name,
                body.product_name_en,
                body.category_code, body.cost_field, body.cost_basis, body.cost_unit,
                body.profit_mode, body.profit_value, body.misc_fee_rate,
                json.dumps(body.spec),
                json.dumps(body.override) if body.override is not None else None,
                _spec_fingerprint(body.spec) if body.override else None,
                body.is_active,
            )
        except Exception as exc:  # 有意兜底：仅 uq_tenant_products_key 撞码转 409，其余原样重抛
            if "uq_tenant_products_key" in str(exc) or "duplicate key" in str(exc):
                raise HTTPException(status_code=409, detail={
                    "error": "conflict", "code": "PRODUCT_KEY_TAKEN",
                    "detail": f"本租户已存在产品标识「{body.product_key}」",
                })
            raise
    return _product_out(r)


@app.put("/api/v1/tenant-products/{product_id}")
async def update_tenant_product(
    request: Request,
    product_id: int,
    body: TenantProductIn,
    user: dict = Depends(_get_current_user),
):
    """更新产品。

    **不是**任意字段的"部分更新"：`TenantProductIn` 里 `product_key` /
    `product_name` / `spec` 三项必填（实测只带 `product_name` → 422 三个 missing），
    其余字段由 `exclude_unset` 决定「只写请求里显式出现的」（不传 `product_name_en`
    就保持原值）。2026-10-21 验收据此修正了旧 docstring 的说法。
    """
    tid = _tenant_of(user)
    async with _acquire(request) as conn:
        row = await conn.fetchrow("SELECT * FROM tenant_products WHERE id=$1", product_id)
        if row is None:
            raise HTTPException(status_code=404, detail={
                "error": "not_found", "code": "PRODUCT_NOT_FOUND",
            })
        if row["is_system"]:
            raise HTTPException(status_code=403, detail={
                "error": "forbidden", "message": "系统级产品仅平台管理员可编辑",
            })
        # 别家的产品一律 404（不泄露存在性）。两把尺：租户 + **团队**
        # （P0：缺了团队这把，同租户内可跨团队改别家产品）
        if row["tenant_id"] != tid or not _writable_by(user, row):
            raise HTTPException(status_code=404, detail={
                "error": "not_found", "code": "PRODUCT_NOT_FOUND",
            })

        fields = {
            k: v for k, v in body.model_dump(exclude_unset=True).items()
            if k in _UPDATABLE_COLUMNS
        }
        if "spec" in fields:
            _validate_spec(fields["spec"])
        if fields.get("override"):
            _validate_override(fields["spec"], fields["override"])

        if not fields:
            return _product_out(row)

        params: list = []
        sets: list[str] = []
        jsonb_cols = {"spec", "override"}
        for col, val in fields.items():
            if col in jsonb_cols:
                params.append(json.dumps(val) if val is not None else None)
                sets.append(f"{col} = ${len(params)}::jsonb")
            else:
                params.append(val)
                sets.append(f"{col} = ${len(params)}")
        # 基线或差异变化时刷新留档指纹（只读字段，不接受请求体直写）
        new_spec = fields.get("spec", json.loads(row["spec"]) if isinstance(row["spec"], str) else row["spec"])
        new_override = fields.get("override", row["override"])
        params.append(_spec_fingerprint(new_spec) if new_override else None)
        sets.append(f"base_spec_hash = ${len(params)}")
        params.append(product_id)
        updated = await conn.fetchrow(
            f"UPDATE tenant_products SET {', '.join(sets)}, updated_at = now()"
            f" WHERE id = ${len(params)} RETURNING *",
            *params,
        )
    return _product_out(updated)


@app.delete("/api/v1/tenant-products/{product_id}", status_code=204)
async def delete_tenant_product(
    request: Request,
    product_id: int,
    user: dict = Depends(_get_current_user),
):
    tid = _tenant_of(user)
    async with _acquire(request) as conn:
        row = await conn.fetchrow("SELECT * FROM tenant_products WHERE id=$1", product_id)
        if row is None:
            raise HTTPException(status_code=404, detail={
                "error": "not_found", "code": "PRODUCT_NOT_FOUND",
            })
        if row["is_system"]:
            raise HTTPException(status_code=403, detail={
                "error": "forbidden", "message": "系统级产品不可删除",
            })
        # 同 PUT：租户 + **团队** 两把尺（P0 —— 否则同租户可跨团队删除别家产品，
        # 且会连带清掉 product_profiles / 工位绑定 / 图片当前标记）
        if row["tenant_id"] != tid or not _writable_by(user, row):
            raise HTTPException(status_code=404, detail={
                "error": "not_found", "code": "PRODUCT_NOT_FOUND",
            })
        # 需求 16（用户决策）：删除产品时一并清理基础信息、图片与工位绑定。
        # 历史报价/单证存的是 spec_snapshot 快照，不受影响。
        await conn.execute(
            "UPDATE file_objects SET is_current=false, is_primary=false, updated_at=now()"
            " WHERE tenant_id=$1 AND owner_type='product' AND owner_id=$2",
            tid, row["product_key"])
        await conn.execute(
            "DELETE FROM product_profiles WHERE tenant_id=$1 AND product_key=$2",
            tid, row["product_key"])
        await conn.execute(
            "DELETE FROM tenant_workstation_products WHERE tenant_id=$1 AND product_key=$2",
            tid, row["product_key"])
        await conn.execute("DELETE FROM tenant_products WHERE id=$1", product_id)
    return None


# ── 报价工位权限矩阵（启用/停用产品）─────────────────────────────────────────

async def _matrix_rows(conn, tid: str, workstation: str):
    """报价工位产品矩阵 = **代码注册表产品** ∪ 本租户启用中的租户级产品。

    为什么不能只读 `tenant_products`（2026-10-24 生产实测）：
    系统产品（鹿网 / 牛栏网 / 勾花网）的真源是 Python 代码注册表
    `kaas_common/export_quote/products/`，生产 `tenant_products` **没有**
    `is_system=true` 行 ⇒ 只读 DB 的旧实现让空表团队 GET 回 `[]`、
    对注册表产品 POST 回 404 PRODUCT_NOT_FOUND。

    合并口径（保持既有语义）：
    - 注册表产品视为 `is_system=true`，`product_name` 取注册表（对外英文名/中文名同源）；
    - 同 key 时**租户行覆盖注册表**（租户自定义产品优先，`is_system` 也取行值）；
    - 排序与旧 SQL 一致：系统产品在前、按 product_key 升序，租户行在后。

    `workstation` 参数保留（矩阵按工位隔离；当前唯一工位是 quote）。
    """
    rows = await conn.fetch(
        "SELECT product_key, product_name, is_system FROM tenant_products"
        " WHERE is_system = true"
        "    OR (tenant_id = $1 AND is_system = false AND is_active = true)"
        " ORDER BY is_system DESC, product_key",
        tid,
    )
    merged: dict[str, dict] = {}
    # ① 代码注册表（系统产品真源）；引擎未随包时降级为只读 DB 行（同 _validate_spec）。
    try:
        from kaas_common.export_quote.products import (  # noqa: PLC0415
            get as _registered_get,
            keys as _registered_keys,
        )
    except ImportError:
        _registered_get = None
        _registered_keys = None
    if _registered_keys is not None and _registered_get is not None:
        for key in _registered_keys():
            try:
                spec = _registered_get(key)
            except Exception:  # noqa: BLE001 - 单个坏产品不拖垮整个矩阵
                continue
            merged[key] = {
                "product_key": key,
                "product_name": spec.name,
                "is_system": True,
            }
    # ② 租户行覆盖（同 key 优先：租户自定义名称/停用状态）
    for row in rows:
        key = row["product_key"]
        merged[key] = {
            "product_key": key,
            "product_name": row["product_name"],
            "is_system": bool(row["is_system"]),
        }
    return sorted(
        merged.values(), key=lambda r: (not r["is_system"], r["product_key"]))


@app.get("/api/v1/workstation-products")
async def list_workstation_products(
    request: Request,
    workstation: str = "quote",
    user: dict = Depends(_get_current_user),
):
    """列出该租户在指定工位启用的产品（含系统级产品）。

    未显式登记过的产品默认「启用」—— 与 orchestrator 的
    `enabled_map.get(p.product_key, True)` 一致。
    """
    tid = _tenant_of(user)
    async with _acquire(request) as conn:
        await _require_quote_subscription(conn, user)
        products = await _matrix_rows(conn, tid, workstation)
        enabled_rows = await conn.fetch(
            "SELECT product_key, is_enabled FROM tenant_workstation_products"
            " WHERE tenant_id=$1 AND workstation=$2",
            tid, workstation,
        )
    enabled_map = {r["product_key"]: bool(r["is_enabled"]) for r in enabled_rows}
    return [
        {
            "product_key": p["product_key"],
            "product_name": p["product_name"],
            "is_system": bool(p["is_system"]),
            "is_enabled": enabled_map.get(p["product_key"], True),
        }
        for p in products
    ]


@app.post("/api/v1/workstation-products", status_code=201)
async def set_workstation_product(
    request: Request,
    body: WorkstationProductIn,
    workstation: str = "quote",
    user: dict = Depends(_get_current_user),
):
    """启用/停用产品（幂等 upsert）。未订阅报价工位时 404，不写任何数据。"""
    tid = _tenant_of(user)
    async with _acquire(request) as conn:
        await _require_quote_subscription(conn, user)
        product = await conn.fetchrow(
            "SELECT product_key, product_name, is_system FROM tenant_products"
            " WHERE product_key=$1 AND (tenant_id=$2 OR is_system = true)"
            " ORDER BY is_system DESC LIMIT 1",
            body.product_key, tid,
        )
        if product is None:
            # 2026-10-24（D 项）：系统产品真源是代码注册表 —— 生产 tenant_products
            # 没有 is_system=true 行，不能据此判"产品不存在"（旧行为：对空表团队
            # 开关鹿网/牛栏网恒 404）。真正未知的 key 仍 404，不写任何数据。
            registered = _registered_product_or_none(body.product_key)
            if registered is None:
                raise HTTPException(status_code=404, detail={
                    "error": "not_found", "code": "PRODUCT_NOT_FOUND",
                })
            product = {"product_name": registered.name, "is_system": True}
        r = await conn.fetchrow(
            "INSERT INTO tenant_workstation_products"
            " (tenant_id, team_id, workstation, product_key, is_enabled)"
            " VALUES ($1,$2,$3,$4,$5)"
            " ON CONFLICT (tenant_id, (COALESCE(team_id, 0)), workstation, product_key)"
            " DO UPDATE SET is_enabled = EXCLUDED.is_enabled, updated_at = now()"
            " RETURNING product_key, is_enabled",
            tid, user.get("team_id"), workstation, body.product_key, body.is_enabled,
        )
    return {
        "product_key": r["product_key"],
        "product_name": product["product_name"],
        "is_system": bool(product["is_system"]),
        "is_enabled": bool(r["is_enabled"]),
    }


def _registered_product_or_none(product_key: str):
    """代码注册表里的产品（系统产品真源）；引擎未打包时返回 None（降级同 _validate_spec）。"""
    try:
        from kaas_common.export_quote.products import (  # noqa: PLC0415
            get as _get_registered,
            has as _has_registered,
        )
    except ImportError:
        return None
    if not _has_registered(product_key):
        return None
    return _get_registered(product_key)


# ── 系统级产品的租户停用（需求 16，与 orchestrator `/tenant-product-status` 同路径）──
class _TenantProductStatusIn(BaseModel):
    product_key: str
    is_enabled: bool = True


@app.get("/api/v1/tenant-product-status")
async def list_tenant_product_status(
    request: Request,
    workstation: str = "quote",
    user: dict = Depends(_get_current_user),
):
    tid = _tenant_of(user)
    team = user.get("team_id")
    team_sql = "team_id IS NULL" if team is None else "(team_id IS NULL OR team_id=$3)"
    args = [tid, workstation]
    if team is not None:
        args.append(team)
    async with _acquire(request) as conn:
        rows = await conn.fetch(
            "SELECT product_key, is_enabled FROM tenant_workstation_products"
            " WHERE tenant_id=$1 AND workstation=$2"
            f" AND {team_sql}",
            *args,
        )
    return {"items": [{"product_key": r["product_key"],
                        "is_enabled": bool(r["is_enabled"])} for r in rows]}


@app.post("/api/v1/tenant-product-status")
async def set_tenant_product_status(
    request: Request,
    body: _TenantProductStatusIn,
    workstation: str = "quote",
    user: dict = Depends(_get_current_user),
):
    tid = _tenant_of(user)
    async with _acquire(request) as conn:
        product = await conn.fetchrow(
            "SELECT product_key, product_name, is_system FROM tenant_products"
            " WHERE product_key=$1 AND (tenant_id=$2 OR is_system = true)"
            " ORDER BY is_system DESC LIMIT 1",
            body.product_key, tid,
        )
        if product is None:
            # 2026-10-24 修复（生产实测：鹿网/牛栏网「在报价中显示」恒 404）：
            # 系统产品的真源是**代码注册表**（`kaas_common.export_quote.products`），
            # 生产 `tenant_products` 里没有 `is_system=true` 的种子行 —— 原实现把
            # 「DB 查不到」误判成「产品不存在」，注册表产品的启停因此永远 404。
            # 口径：注册表里有该 key ⇒ 视作系统产品，允许写团队启停记录；
            # 真正未知的 key 仍 404（保留既有错误契约）。
            registered = _registered_product_or_none(body.product_key)
            if registered is None:
                raise HTTPException(status_code=404, detail={
                    "error": "not_found", "code": "PRODUCT_NOT_FOUND",
                })
            product = {"product_name": registered.name, "is_system": True}
        r = await conn.fetchrow(
            "INSERT INTO tenant_workstation_products"
            " (tenant_id, team_id, workstation, product_key, is_enabled)"
            " VALUES ($1,$2,$3,$4,$5)"
            " ON CONFLICT (tenant_id, (COALESCE(team_id, 0)), workstation, product_key)"
            " DO UPDATE SET is_enabled = EXCLUDED.is_enabled, updated_at = now()"
            " RETURNING product_key, is_enabled",
            tid, user.get("team_id"), workstation, body.product_key, body.is_enabled,
        )
    return {"product_key": r["product_key"],
            "is_system": bool(product["is_system"]),
            "is_enabled": bool(r["is_enabled"])}
