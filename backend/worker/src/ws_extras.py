"""汇率 / 实际采购成本 / 外部单证上传 路由（Worker 镜像）。

与 orchestrator 的 app/api/fx_rates.py / actual_costs.py / external_docs.py 对齐，
但用 asyncpg 直连（Worker 的 Hyperdrive 连接模式）。
"""
from __future__ import annotations

from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request, UploadFile, File, Form, Query
from fastapi.responses import Response
from pydantic import BaseModel

import main as _main

app = _main.app
_get_current_user = _main._get_current_user
_acquire = _main._acquire


# ── 汇率 ───────────────────────────────────────────────────────────────────

class FxRateIn(BaseModel):
    base_currency: str = "USD"
    quote_currency: str = "CNY"
    rate: float
    rate_date: Optional[str] = None
    source: str = "manual"


class FxRateOut(BaseModel):
    base_currency: str
    quote_currency: str
    rate: float
    rate_date: str
    source: Optional[str]
    is_stale: bool


@app.get("/api/v1/fx-rates")
async def list_fx_rates(request: Request, base_currency: str = "USD", quote_currency: str = "CNY",
                        limit: int = 30, user: dict = Depends(_get_current_user)):
    async with _acquire(request) as conn:
        rows = await conn.fetch(
            "SELECT * FROM fx_rates WHERE base_currency=$1 AND quote_currency=$2"
            " ORDER BY rate_date DESC LIMIT $3",
            base_currency, quote_currency, min(max(limit, 1), 365),
        )
    return [
        {"base_currency": r["base_currency"], "quote_currency": r["quote_currency"],
         "rate": float(r["rate"]), "rate_date": r["rate_date"].isoformat(),
         "source": r["source"], "is_stale": bool(r["is_stale"])}
        for r in rows
    ]


@app.get("/api/v1/fx-rates/latest")
async def latest_fx_rate(request: Request, base_currency: str = "USD", quote_currency: str = "CNY",
                         user: dict = Depends(_get_current_user)):
    async with _acquire(request) as conn:
        r = await conn.fetchrow(
            "SELECT * FROM fx_rates WHERE base_currency=$1 AND quote_currency=$2"
            " ORDER BY rate_date DESC LIMIT 1",
            base_currency, quote_currency,
        )
    if r is None:
        raise HTTPException(status_code=404, detail={"error": "not_found", "code": "FX_RATE_NOT_FOUND"})
    return {"base_currency": r["base_currency"], "quote_currency": r["quote_currency"],
            "rate": float(r["rate"]), "rate_date": r["rate_date"].isoformat(),
            "source": r["source"], "is_stale": bool(r["is_stale"])}


@app.post("/api/v1/fx-rates", status_code=201)
async def upsert_fx_rate(request: Request, body: FxRateIn, user: dict = Depends(_get_current_user)):
    if body.rate <= 0:
        raise HTTPException(status_code=422, detail={"error": "invalid_rate", "message": "rate must be > 0"})
    rate_date = date.fromisoformat(body.rate_date) if body.rate_date else date.today()
    async with _acquire(request) as conn:
        await conn.execute(
            "INSERT INTO fx_rates (base_currency, quote_currency, rate, rate_date, source, is_stale, fetched_at)"
            " VALUES ($1, $2, $3, $4, $5, false, $6)"
            " ON CONFLICT (base_currency, quote_currency, rate_date)"
            " DO UPDATE SET rate = EXCLUDED.rate, source = EXCLUDED.source,"
            "   is_stale = false, fetched_at = EXCLUDED.fetched_at",
            body.base_currency, body.quote_currency, Decimal(str(body.rate)), rate_date,
            body.source, datetime.now(timezone.utc),
        )
    return {"base_currency": body.base_currency, "quote_currency": body.quote_currency,
            "rate": body.rate, "rate_date": rate_date.isoformat(),
            "source": body.source, "is_stale": False}


# ── 实际采购成本 ───────────────────────────────────────────────────────────

class ActualCostIn(BaseModel):
    product_key: str
    supplier_name: Optional[str] = None
    effective_from: Optional[str] = None
    effective_to: Optional[str] = None
    unit_cost_actual: Optional[float] = None
    total_cost_actual: Optional[float] = None
    qty_snapshot: Optional[float] = None
    qty_unit: Optional[str] = None
    cost_basis: str = "pretax"
    input_vat_rate_snapshot: Optional[float] = None
    currency: str = "CNY"
    notes: Optional[str] = None


class ActualCostResolveIn(BaseModel):
    unit_cost_actual: Optional[float] = None
    total_cost_actual: Optional[float] = None
    qty: Optional[float] = None
    cost_basis: str = "pretax"
    input_vat_rate: Optional[float] = None


@app.get("/api/v1/actual-costs")
async def list_actual_costs(request: Request, product_key: Optional[str] = None,
                            limit: int = Query(default=50, ge=1, le=500),
                            user: dict = Depends(_get_current_user)):
    async with _acquire(request) as conn:
        if product_key:
            rows = await conn.fetch(
                "SELECT * FROM actual_procurement_costs WHERE product_key=$1"
                " ORDER BY created_at DESC LIMIT $2", product_key, limit)
        else:
            rows = await conn.fetch(
                "SELECT * FROM actual_procurement_costs ORDER BY created_at DESC LIMIT $1", limit)
    return [
        {"id": r["id"], "product_key": r["product_key"], "supplier_name": r["supplier_name"],
         "unit_cost_actual": float(r["unit_cost_actual"]) if r["unit_cost_actual"] is not None else None,
         "total_cost_actual": float(r["total_cost_actual"]) if r["total_cost_actual"] is not None else None,
         "cost_basis": r["cost_basis"], "currency": r["currency"], "notes": r["notes"],
         "created_at": r["created_at"].isoformat() if r["created_at"] else None}
        for r in rows
    ]


@app.post("/api/v1/actual-costs", status_code=201)
async def create_actual_cost(request: Request, body: ActualCostIn, user: dict = Depends(_get_current_user)):
    if body.unit_cost_actual is None and body.total_cost_actual is None:
        raise HTTPException(status_code=422, detail={"error": "missing_cost", "message": "unit_cost_actual or total_cost_actual required"})
    if body.cost_basis not in ("pretax", "incl_tax"):
        raise HTTPException(status_code=422, detail={"error": "invalid_cost_basis"})
    async with _acquire(request) as conn:
        r = await conn.fetchrow(
            "INSERT INTO actual_procurement_costs"
            " (tenant_id, product_key, supplier_name, effective_from, effective_to,"
            "  unit_cost_actual, total_cost_actual, qty_snapshot, qty_unit, cost_basis,"
            "  input_vat_rate_snapshot, currency, notes, created_by)"
            " VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *",
            user.get("tenant_id", "default") if isinstance(user.get("tenant_id"), str) else "default",
            body.product_key, body.supplier_name,
            date.fromisoformat(body.effective_from) if body.effective_from else None,
            date.fromisoformat(body.effective_to) if body.effective_to else None,
            Decimal(str(body.unit_cost_actual)) if body.unit_cost_actual is not None else None,
            Decimal(str(body.total_cost_actual)) if body.total_cost_actual is not None else None,
            Decimal(str(body.qty_snapshot)) if body.qty_snapshot is not None else None,
            body.qty_unit, body.cost_basis,
            Decimal(str(body.input_vat_rate_snapshot)) if body.input_vat_rate_snapshot is not None else None,
            body.currency, body.notes, str(user.get("id")),
        )
    return {"id": r["id"], "product_key": r["product_key"]}


@app.post("/api/v1/actual-costs/resolve")
async def resolve_actual_cost(body: ActualCostResolveIn, user: dict = Depends(_get_current_user)):
    unit = Decimal(str(body.unit_cost_actual)) if body.unit_cost_actual is not None else None
    total = Decimal(str(body.total_cost_actual)) if body.total_cost_actual is not None else None
    qty = Decimal(str(body.qty)) if body.qty is not None else None
    if unit is None and total is not None and qty and qty > 0:
        unit = total / qty
    if total is None and unit is not None and qty and qty > 0:
        total = unit * qty
    unit_pretax = unit
    if body.cost_basis == "incl_tax" and unit is not None and body.input_vat_rate is not None:
        rate = Decimal(str(body.input_vat_rate))
        if rate < 1:
            unit_pretax = unit * (Decimal(1) - rate)
    return {"unit_cost_actual": float(unit) if unit is not None else None,
            "total_cost_actual": float(total) if total is not None else None,
            "unit_cost_pretax": float(unit_pretax) if unit_pretax is not None else None}


# ── 外部单证上传 ───────────────────────────────────────────────────────────

MAX_FILE_SIZE = 20 * 1024 * 1024


@app.post("/api/v1/external-docs", status_code=201)
async def upload_external_doc(request: Request, file: UploadFile = File(...),
                              doc_type: Optional[str] = Form(None),
                              order_id: Optional[int] = Form(None),
                              quote_order_id: Optional[int] = Form(None),
                              inquiry_id: Optional[int] = Form(None),
                              customer_id: Optional[str] = Form(None),
                              notes: Optional[str] = Form(None),
                              user: dict = Depends(_get_current_user)):
    content = await file.read()
    if len(content) > MAX_FILE_SIZE:
        raise HTTPException(status_code=413, detail={"error": "file_too_large"})
    if not content:
        raise HTTPException(status_code=422, detail={"error": "empty_file"})
    async with _acquire(request) as conn:
        r = await conn.fetchrow(
            "INSERT INTO external_doc_uploads"
            " (tenant_id, order_id, quote_order_id, inquiry_id, customer_id, doc_type,"
            "  file_name, content_type, file_size, content, notes, uploaded_by)"
            " VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id, file_name",
            "default", order_id, quote_order_id, inquiry_id, customer_id, doc_type,
            file.filename or "untitled", file.content_type, len(content), content, notes,
            str(user.get("id")),
        )
    return {"id": r["id"], "file_name": r["file_name"]}


@app.get("/api/v1/external-docs")
async def list_external_docs(request: Request, order_id: Optional[int] = None,
                             doc_type: Optional[str] = None,
                             limit: int = Query(default=50, ge=1, le=500),
                             user: dict = Depends(_get_current_user)):
    cond = ""
    params: list = []
    if order_id is not None:
        cond += " AND order_id=$1"
        params.append(order_id)
    if doc_type:
        cond += f" AND doc_type=${len(params)+1}"
        params.append(doc_type)
    async with _acquire(request) as conn:
        rows = await conn.fetch(
            f"SELECT id, doc_type, file_name, content_type, file_size, order_id,"
            f" quote_order_id, inquiry_id, customer_id, status, notes, uploaded_by, created_at"
            f" FROM external_doc_uploads WHERE 1=1{cond} ORDER BY created_at DESC LIMIT ${len(params)+1}",
            *params, limit)
    return [
        {"id": r["id"], "doc_type": r["doc_type"], "file_name": r["file_name"],
         "content_type": r["content_type"], "file_size": float(r["file_size"]) if r["file_size"] is not None else None,
         "order_id": r["order_id"], "quote_order_id": r["quote_order_id"],
         "inquiry_id": r["inquiry_id"], "customer_id": r["customer_id"],
         "status": r["status"], "notes": r["notes"], "uploaded_by": r["uploaded_by"],
         "created_at": r["created_at"].isoformat() if r["created_at"] else None}
        for r in rows
    ]


@app.get("/api/v1/external-docs/{doc_id}/download")
async def download_external_doc(request: Request, doc_id: int, user: dict = Depends(_get_current_user)):
    async with _acquire(request) as conn:
        r = await conn.fetchrow("SELECT * FROM external_doc_uploads WHERE id=$1", doc_id)
    if r is None:
        raise HTTPException(status_code=404, detail={"error": "not_found"})
    return Response(
        content=bytes(r["content"]),
        media_type=r["content_type"] or "application/octet-stream",
        headers={"Content-Disposition": f'attachment; filename="{r["file_name"]}"'},
    )


@app.patch("/api/v1/external-docs/{doc_id}")
async def update_external_doc(request: Request, doc_id: int, status: str,
                              notes: Optional[str] = None,
                              user: dict = Depends(_get_current_user)):
    if status not in ("draft", "issued", "void"):
        raise HTTPException(status_code=422, detail={"error": "invalid_status"})
    async with _acquire(request) as conn:
        r = await conn.fetchrow(
            "UPDATE external_doc_uploads SET status=$2, notes=COALESCE($3, notes)"
            " WHERE id=$1 RETURNING id, status", doc_id, status, notes)
    if r is None:
        raise HTTPException(status_code=404, detail={"error": "not_found"})
    return {"id": r["id"], "status": r["status"]}


@app.delete("/api/v1/external-docs/{doc_id}", status_code=204)
async def delete_external_doc(request: Request, doc_id: int, user: dict = Depends(_get_current_user)):
    async with _acquire(request) as conn:
        await conn.execute("DELETE FROM external_doc_uploads WHERE id=$1", doc_id)
    return None
