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
- **工位订阅**：报价工位未订阅（`tenant_subscriptions` 无有效编码）→ 404
  `SUBSCRIPTION_REQUIRED`，与 `app/api/subs.py` 同口径；未订阅不写任何数据。
"""
from __future__ import annotations

import json
from typing import Optional

from fastapi import Depends, HTTPException, Query, Request
from pydantic import BaseModel

import main as _main

app = _main.app
_get_current_user = _main._get_current_user
_acquire = _main._acquire
DEFAULT_TENANT = _main.DEFAULT_TENANT

# 报价工位订阅编码：`full_chain` 是全工位包（docs/WORKSTATION_DESIGN.md §5.4.1）。
# 与 app/api/subs.py 的 WORKSTATION_CODES["quote"] 必须逐字一致，
# 否则会出现「本地能开、线上 404」或反之的怪病。
QUOTE_SUB_CODES = ("full_chain",)

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
    except Exception as exc:  # 引擎的校验异常类型不止一种，一律转 422 带出原文
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


async def _require_quote_subscription(conn) -> None:
    """报价工位订阅校验。未订阅 → 404（不暴露存在性，与 subs.py 同语义）。"""
    ok = await conn.fetchval(
        "SELECT 1 FROM tenant_subscriptions"
        " WHERE tenant_id=$1 AND code=ANY($2) AND active=true",
        DEFAULT_TENANT, list(QUOTE_SUB_CODES),
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
        except Exception as exc:  # uq_tenant_products_key 唯一约束
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
    """更新产品（部分更新：只写请求里显式出现的字段）。"""
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
        # 别家的产品一律 404（不泄露存在性）
        if row["tenant_id"] != tid:
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
        if row["tenant_id"] != tid:
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
    """系统级产品（全部可见）+ 本租户启用中的租户级产品。"""
    return await conn.fetch(
        "SELECT product_key, product_name, is_system FROM tenant_products"
        " WHERE is_system = true"
        "    OR (tenant_id = $1 AND is_system = false AND is_active = true)"
        " ORDER BY is_system DESC, product_key",
        tid,
    )


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
        await _require_quote_subscription(conn)
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
        await _require_quote_subscription(conn)
        product = await conn.fetchrow(
            "SELECT product_key, product_name, is_system FROM tenant_products"
            " WHERE product_key=$1 AND (tenant_id=$2 OR is_system = true)"
            " ORDER BY is_system DESC LIMIT 1",
            body.product_key, tid,
        )
        if product is None:
            raise HTTPException(status_code=404, detail={
                "error": "not_found", "code": "PRODUCT_NOT_FOUND",
            })
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
            raise HTTPException(status_code=404, detail={
                "error": "not_found", "code": "PRODUCT_NOT_FOUND",
            })
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
