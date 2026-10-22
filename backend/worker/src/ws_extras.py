"""汇率 / 实际采购成本 / 外部单证上传 路由（Worker 镜像）。

与 orchestrator 的 app/api/fx_rates.py / actual_costs.py / external_docs.py 对齐，
但用 asyncpg 直连（Worker 的 Hyperdrive 连接模式）。
"""
from __future__ import annotations

from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Optional
from urllib.parse import quote as _url_quote

from fastapi import APIRouter, Depends, HTTPException, Request, UploadFile, File, Form, Query
from fastapi.responses import Response
from pydantic import BaseModel

import main as _main

app = _main.app
_get_current_user = _main._get_current_user
_acquire = _main._acquire


# ── 汇率：实时拉取 + 缓存（2026-10-17）─────────────────────────────────────
# 背景：fx_rates 一直没数据（仓库里没有 fetch 脚本），/fx-rates/latest 恒 404。
# 现在改为「读时按需刷新」：数据超过 6 小时就向免费公开源拉一次并入库，
# 外部源失败则降级到缓存（is_stale=true），完全没数据才 503。
FX_PROVIDER_URL = "https://open.er-api.com/v6/latest/{base}"
FX_MAX_AGE_HOURS = 6
FX_SOURCE = "open.er-api.com"


async def _http_get_json(url: str, timeout: int = 20):
    """出站 GET JSON：Workers 用 js.fetch，本地 CPython 回退 urllib。

    Pyodide 下把 JS 异常统一转成 Python RuntimeError（否则可能表现为裸 500）。
    """
    try:
        from js import fetch  # type: ignore  (Pyodide / Python Workers)
    except ImportError:
        import json as _json
        import urllib.request

        req = urllib.request.Request(
            url, headers={"User-Agent": "kaas-fx/1.0", "Accept": "application/json"}
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return _json.loads(resp.read().decode("utf-8"))

    import json as _json

    try:
        resp = await fetch(url)  # 最小参数：部分 runtime 对 options 里的 headers 处理不一致
        status = int(resp.status)
        text = await resp.text()
    except Exception as exc:  # noqa: BLE001 - 有意兜底：Pyodide JsException 包成可读 RuntimeError 重抛
        raise RuntimeError(f"fetch failed: {type(exc).__name__}: {exc}") from exc
    if status != 200:
        raise RuntimeError(f"fx provider HTTP {status}: {str(text)[:200]}")
    return _json.loads(str(text))


def parse_fx_payload(payload: dict, quote_currency: str):
    """从 open.er-api.com 响应里取 (rate, rate_date)。纯函数，便于单测。"""
    rates = payload.get("rates") or {}
    value = rates.get(quote_currency.upper())
    if value is None:
        raise ValueError(f"fx provider 未返回 {quote_currency}")
    ts = payload.get("time_last_update_unix")
    if ts:
        rate_date = datetime.fromtimestamp(int(ts), tz=timezone.utc).date()
    else:
        rate_date = date.today()
    return Decimal(str(value)), rate_date


def fx_is_fresh(fetched_at, now, max_age_hours: float = FX_MAX_AGE_HOURS) -> bool:
    if fetched_at is None:
        return False
    return (now - fetched_at).total_seconds() < float(max_age_hours) * 3600


def _fx_out(row, stale: bool = False) -> dict:
    return {
        "base_currency": row["base_currency"],
        "quote_currency": row["quote_currency"],
        "rate": float(row["rate"]),
        "rate_date": row["rate_date"].isoformat(),
        "source": row["source"],
        "is_stale": bool(row["is_stale"]) or stale,
    }


async def _ensure_fresh_fx(conn, base_currency: str, quote_currency: str) -> dict:
    base = (base_currency or "USD").upper()
    quote = (quote_currency or "CNY").upper()
    if base == quote:
        return {
            "base_currency": base,
            "quote_currency": quote,
            "rate": 1.0,
            "rate_date": date.today().isoformat(),
            "source": "same-currency",
            "is_stale": False,
        }

    sql = (
        "SELECT * FROM fx_rates WHERE base_currency=$1 AND quote_currency=$2"
        " ORDER BY rate_date DESC, fetched_at DESC NULLS LAST LIMIT 1"
    )
    row = await conn.fetchrow(sql, base, quote)
    now = datetime.now(timezone.utc)
    if row is not None and fx_is_fresh(row["fetched_at"], now):
        return _fx_out(row)

    try:
        payload = await _http_get_json(FX_PROVIDER_URL.format(base=base))
        rate, rate_date = parse_fx_payload(payload, quote)
    except Exception as exc:  # noqa: BLE001 - 有意兜底：外部源失败降级到缓存，而不是把报价打挂
        if row is not None:
            return _fx_out(row, stale=True)
        raise HTTPException(status_code=503, detail={
            "error": "fx_unavailable",
            "code": "FX_RATE_UNAVAILABLE",
            "detail": f"{type(exc).__name__}: {exc}",
        }) from exc

    await conn.execute(
        "INSERT INTO fx_rates"
        " (base_currency, quote_currency, rate, rate_date, source, is_stale, fetched_at)"
        " VALUES ($1,$2,$3,$4,$5,false,NOW())"
        " ON CONFLICT (base_currency, quote_currency, rate_date)"
        " DO UPDATE SET rate=EXCLUDED.rate, source=EXCLUDED.source,"
        "   is_stale=false, fetched_at=NOW()",
        base, quote, rate, rate_date, FX_SOURCE,
    )
    row = await conn.fetchrow(sql, base, quote)
    return _fx_out(row if row is not None else {
        "base_currency": base, "quote_currency": quote, "rate": rate,
        "rate_date": rate_date, "source": FX_SOURCE, "is_stale": False,
    })


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
    """最新汇率：超过 6 小时自动向公开源刷新并入库；外部源不可用时降级到缓存。"""
    try:
        async with _acquire(request) as conn:
            return await _ensure_fresh_fx(conn, base_currency, quote_currency)
    except HTTPException:
        raise
    except BaseException as exc:  # noqa: BLE001 - 连 JS/JsException 一起转成可读 503
        raise HTTPException(status_code=503, detail={
            "error": "fx_refresh_failed",
            "code": "FX_REFRESH_FAILED",
            "detail": f"{type(exc).__name__}: {exc}",
        }) from exc


@app.get("/api/v1/fx-rates/_debug")
async def fx_provider_debug(base_currency: str = "USD", quote_currency: str = "CNY",
                            user: dict = Depends(_get_current_user)):
    """线上自检：直接打一次汇率源，返回状态/片段/异常（不写库）。排查完可删。

    B0-6 收敛：诊断端点仅平台管理员可用（普通登录用户 403），不对外开放。
    """
    from kaas_common.workstation.scope import is_admin_role
    if not is_admin_role(user.get("role")):
        raise HTTPException(status_code=403, detail={
            "error": "forbidden", "code": "ADMIN_ONLY",
            "message": "诊断端点仅平台管理员可用"})
    url = FX_PROVIDER_URL.format(base=(base_currency or "USD").upper())
    try:
        payload = await _http_get_json(url)
        rate, rate_date = parse_fx_payload(payload, quote_currency)
        return {"ok": True, "url": url, "rate": float(rate), "rate_date": rate_date.isoformat()}
    except BaseException as exc:  # noqa: BLE001
        return {"ok": False, "url": url, "error": f"{type(exc).__name__}: {exc}"}


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
    # 中文文件名不能直接塞进 HTTP 头（header 只能是 latin-1，Starlette 会在
    # 编码期抛 UnicodeEncodeError → 500）：按 RFC 6266/5987 给 ASCII 兜底名 +
    # filename*=UTF-8'' 百分号编码，浏览器优先用后者。
    file_name = r["file_name"] or "download"
    ascii_name = "".join(
        ch if 32 <= ord(ch) < 127 and ch not in '"\\' else "_"
        for ch in file_name
    ) or "download"
    disposition = (
        f'attachment; filename="{ascii_name}"; '
        f"filename*=UTF-8''{_url_quote(file_name, safe='')}"
    )
    return Response(
        content=bytes(r["content"]),
        media_type=r["content_type"] or "application/octet-stream",
        headers={"Content-Disposition": disposition},
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
