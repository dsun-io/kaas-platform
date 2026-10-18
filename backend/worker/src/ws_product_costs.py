"""产品成本历史 API（Worker 镜像 · 需求 11）

与 orchestrator `app/api/product_costs.py` 同语义：
- GET  /api/v1/product-costs     列表 + 参考成本
- POST /api/v1/product-costs     手工补录

报价保存时的自动写入在 `quote_api` 里（同一事务），与 dev 端 `record_cost_history` 对齐。
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import Depends, HTTPException, Query, Request
from pydantic import BaseModel

import main as _main

app = _main.app
db = _main.db
_get_current_user = _main._get_current_user
DEFAULT_TENANT = _main.DEFAULT_TENANT

from kaas_common.workstation.cost_rules import cost_spec_hash, reference_cost  # noqa: E402


class _ProductCostIn(BaseModel):
    product_key: str
    spec_snapshot: Optional[dict] = None
    cost_pretax: float
    cost_incl: Optional[float] = None
    currency: str = "CNY"
    note: Optional[str] = None
    source: str = "manual"


def _tenant_of(user: dict) -> str:
    tid = user.get("tenant_id")
    return tid if isinstance(tid, str) and tid else DEFAULT_TENANT


def _row_out(row: dict) -> dict:
    cost = row.get("cost_pretax")
    return {
        "id": row.get("id"),
        "product_key": row.get("product_key"),
        "spec_snapshot": row.get("spec_snapshot"),
        "spec_hash": row.get("spec_hash"),
        "cost_pretax": float(cost) if cost is not None else None,
        "cost_incl": float(row["cost_incl"]) if row.get("cost_incl") is not None else None,
        "currency": row.get("currency"),
        "source": row.get("source"),
        "quote_order_id": row.get("quote_order_id"),
        "note": row.get("note"),
        "created_by": row.get("created_by"),
        "created_at": row["created_at"].isoformat() if row.get("created_at") else None,
    }


def _scope(request: Request, user: dict) -> tuple[str, list]:
    """返回 (where_sql, params)；团队隔离与其它工位同口径。"""
    tenant = _tenant_of(user)
    sql = "tenant_id=$1"
    params: list = [tenant]
    if not _main._can_see_all(user):
        team = user.get("team_id")
        if team is None:
            sql += " AND team_id IS NULL"
        else:
            params.append(team)
            sql += f" AND (team_id IS NULL OR team_id=${len(params)})"
    return sql, params


@app.get("/api/v1/product-costs")
async def list_product_costs(
    request: Request,
    product_key: Optional[str] = None,
    spec_hash: Optional[str] = None,
    spec: Optional[str] = None,
    limit: int = Query(50, ge=1, le=200),
    user: dict = Depends(_get_current_user),
):
    where, params = _scope(request, user)
    if product_key:
        params.append(product_key)
        where += f" AND product_key=${len(params)}"
    rows = await db.fetch(
        request,
        "SELECT * FROM product_cost_history"
        f" WHERE {where} ORDER BY created_at DESC LIMIT 200",
        *params, table="product_cost_history",
    )
    items = [_row_out(r) for r in rows]
    wanted_hash = spec_hash
    if wanted_hash is None and spec:
        import json

        try:
            wanted_hash = cost_spec_hash(json.loads(spec))
        except (ValueError, TypeError) as exc:
            raise HTTPException(status_code=422, detail={
                "error": "validation", "code": "INVALID_SPEC",
                "detail": f"规格不是合法 JSON: {exc}",
            })
    ref = reference_cost(items, spec_hash=wanted_hash)
    return {"items": items[:limit], "total": len(items), "reference": ref,
            "spec_hash": wanted_hash}


@app.post("/api/v1/product-costs", status_code=201)
async def create_product_cost(
    request: Request,
    body: _ProductCostIn,
    user: dict = Depends(_get_current_user),
):
    if body.cost_pretax is None or body.cost_pretax < 0:
        raise HTTPException(status_code=422, detail={
            "error": "validation", "code": "INVALID_COST",
            "detail": "税前成本必须 ≥ 0",
        })
    product_key = (body.product_key or "").strip()
    if not product_key:
        raise HTTPException(status_code=422, detail={
            "error": "validation", "code": "PRODUCT_REQUIRED",
            "detail": "必须指定产品",
        })
    spec_snapshot = body.spec_snapshot or {}
    row = await db.fetchrow(
        request,
        """INSERT INTO product_cost_history
               (tenant_id, team_id, product_key, spec_snapshot, spec_hash,
                cost_pretax, cost_incl, currency, source, note, created_by)
           VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11)
           RETURNING *""",
        _tenant_of(user), user.get("team_id"), product_key,
        _main._json.dumps(spec_snapshot), cost_spec_hash(spec_snapshot),
        body.cost_pretax, body.cost_incl, body.currency or "CNY",
        body.source or "manual", body.note, str(user.get("id")),
        table="product_cost_history",
    )
    return _row_out(row)


async def record_cost_history(conn, tenant: str, team_id, items, quote_order_id: int,
                              created_by: str) -> int:
    """报价保存时把**手改过成本**的行写进成本历史（与 dev 同口径，1h 去重）。"""
    written = 0
    cutoff = datetime.now(timezone.utc) - timedelta(hours=1)
    for item in items or []:
        cost = item.get("cost_override") if isinstance(item, dict) else None
        if cost is None:
            continue
        snapshot = (item.get("spec_snapshot") if isinstance(item, dict) else None) or {}
        if not isinstance(snapshot, dict):
            continue
        product_key = snapshot.get("product_key")
        if not product_key:
            continue
        specs = snapshot.get("specs") or {}
        spec_hash = cost_spec_hash(specs)
        exists = await conn.fetchval(
            "SELECT 1 FROM product_cost_history"
            " WHERE tenant_id=$1 AND product_key=$2 AND spec_hash=$3"
            " AND cost_pretax=$4 AND created_at >= $5 LIMIT 1",
            tenant, product_key, spec_hash, cost, cutoff,
        )
        if exists:
            continue
        await conn.execute(
            """INSERT INTO product_cost_history
                   (tenant_id, team_id, product_key, spec_snapshot, spec_hash,
                    cost_pretax, currency, source, quote_order_id, created_by)
               VALUES ($1,$2,$3,$4::jsonb,$5,$6,'CNY','quote',$7,$8)""",
            tenant, team_id, product_key, _main._json.dumps(specs), spec_hash,
            cost, quote_order_id, created_by,
        )
        written += 1
    return written
