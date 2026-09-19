"""KaaS Intel Workstation API — Cloudflare Python Worker.

纯 asyncpg + FastAPI 实现，避开 SQLAlchemy async（Workers 缺 greenlet 支持）。
数据链: 谁(shipper) → 什么时间(ship_date) → 通过谁(carrier) → 向什么地区(dest_country) → 谁(consignee) → 发了什么货(product_desc)
"""
import os
import csv
import io
import hmac
from contextlib import asynccontextmanager
from datetime import datetime, timezone, timedelta
from typing import Optional, List
from urllib.parse import urlparse

import asyncpg
import bcrypt
import jwt
from fastapi import FastAPI, Request, HTTPException, Query, UploadFile, File, Depends
from pydantic import BaseModel
from workers import WorkerEntrypoint, asgi

DEFAULT_TENANT = "default"

import json as _json

_JSONB_COLS = {"suitable_cargo", "suitable_shipping_modes", "connected_corridors", "major_carriers"}


def _row_to_dict(row: asyncpg.Record) -> dict:
    """asyncpg returns jsonb as str in some Workers contexts; parse known jsonb columns."""
    d = dict(row)
    for k in _JSONB_COLS & d.keys():
        v = d[k]
        if isinstance(v, str):
            try:
                d[k] = _json.loads(v)
            except Exception:
                pass
    return d


# ── Config ──
def _cfg(key: str, default: str = "") -> str:
    v = os.environ.get(key)
    return v if v else default


JWT_SECRET = _cfg("JWT_SECRET", "kaas-dev-jwt-secret-change-in-prod")
JWT_ALGORITHM = "HS256"
ADMIN_SETUP_TOKEN = _cfg("ADMIN_SETUP_TOKEN")


# ── Auth helpers ──
def _hash_password(password: str) -> str:
    """与原后端 (bcrypt) 格式一致。"""
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def _verify_password(password: str, hashed: str) -> bool:
    return bcrypt.checkpw(password.encode("utf-8"), hashed.encode("utf-8"))


def _create_token(user_id: int) -> str:
    payload = {
        "sub": str(user_id),
        "exp": datetime.now(timezone.utc) + timedelta(minutes=1440),
        "iat": datetime.now(timezone.utc),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def _decode_token(token: str) -> dict:
    try:
        return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")


async def _get_current_user(request: Request) -> dict:
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer token")
    payload = _decode_token(auth[7:])
    async with _acquire(request) as conn:
        row = await conn.fetchrow(
            "SELECT id, email, display_name, account_type, role, status FROM users WHERE id=$1",
            int(payload["sub"]),
        )
    if not row or row["status"] != "active":
        raise HTTPException(status_code=401, detail="User not found or inactive")
    return dict(row)


# ── Schemas ──
class BootstrapRequest(BaseModel):
    email: str
    password: str
    display_name: str


class LoginRequest(BaseModel):
    email: str
    password: str


class ShipmentCreate(BaseModel):
    shipper: str
    consignee: str
    product_desc: str
    ship_date: Optional[datetime] = None
    carrier: Optional[str] = None
    notify_party: Optional[str] = None
    origin_port: Optional[str] = None
    origin_country: Optional[str] = None
    dest_port: Optional[str] = None
    dest_country: Optional[str] = None
    product_desc_norm: Optional[str] = None
    hs_code: Optional[str] = None
    qty: Optional[float] = None
    qty_unit: Optional[str] = None
    gross_weight_kg: Optional[float] = None
    net_weight_kg: Optional[float] = None
    volume_cbm: Optional[float] = None
    container_no: Optional[str] = None
    container_type: Optional[str] = None
    bl_no: Optional[str] = None
    voyage_no: Optional[str] = None
    declared_value: Optional[float] = None
    currency: Optional[str] = None
    marks: Optional[str] = None
    remarks: Optional[str] = None
    shipment_type: Optional[str] = None
    incoterm: Optional[str] = None
    freight_prepaid: Optional[bool] = None
    source_channel: str = "manual_api"
    source_ref: Optional[str] = None
    is_verified: bool = False


# ── App ──
app = FastAPI(title="KaaS Intel API", version="1.0.0")

# 允许的生产前端来源（本地开发端口放行 localhost）
ALLOWED_ORIGINS = {
    "https://kaas.powervoy.com",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
}


@app.middleware("http")
async def cors_middleware(request: Request, call_next):
    origin = request.headers.get("Origin", "")
    allowed = origin if origin in ALLOWED_ORIGINS else "https://kaas.powervoy.com"
    if request.method == "OPTIONS":
        from fastapi import Response
        return Response(
            status_code=204,
            headers={
                "Access-Control-Allow-Origin": allowed,
                "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
                "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Tenant-Id, X-Use-V2",
                "Access-Control-Max-Age": "86400",
            },
        )
    response = await call_next(request)
    response.headers["Access-Control-Allow-Origin"] = allowed
    response.headers["Vary"] = "Origin"
    return response


@asynccontextmanager
async def _acquire(request: Request):
    """每请求建立一个 Hyperdrive 连接（官方推荐的 Python Workers 模式）。

    asgi.fetch 会把 Worker env 注入 request.scope['env']。
    """
    hd = request.scope["env"].HYPERDRIVE
    conn = await asyncpg.connect(
        host=hd.host,
        port=int(hd.port),
        user=hd.user,
        password=hd.password,
        database=hd.database,
        ssl=False,
    )
    try:
        yield conn
    finally:
        await conn.close()


# ── Auth Endpoints ──
@app.post("/api/v1/auth/bootstrap-admin")
async def bootstrap_admin(request: Request, body: BootstrapRequest):
    if not ADMIN_SETUP_TOKEN:
        raise HTTPException(status_code=503, detail="ADMIN_SETUP_TOKEN not configured")
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer ") or not hmac.compare_digest(auth[7:], ADMIN_SETUP_TOKEN):
        raise HTTPException(status_code=403, detail="Invalid setup token")

    async with _acquire(request) as conn:
        existing = await conn.fetchrow(
            "SELECT id FROM users WHERE account_type='internal' AND role='system_admin' LIMIT 1"
        )
        if existing:
            raise HTTPException(status_code=403, detail="System already initialized")
        row = await conn.fetchrow(
            """INSERT INTO users (email, password_hash, display_name,
               account_type, role, plan, status, created_at, updated_at)
               VALUES ($1,$2,$3,'internal','system_admin','internal','active',NOW(),NOW())
               RETURNING id, email, display_name, account_type, role""",
            body.email.lower(), _hash_password(body.password), body.display_name,
        )
    token = _create_token(row["id"])
    return {"access_token": token, "token_type": "bearer", "user": dict(row)}


@app.post("/api/v1/auth/login")
async def login(request: Request, body: LoginRequest):
    async with _acquire(request) as conn:
        row = await conn.fetchrow(
            "SELECT id, email, password_hash, display_name, account_type, role, status FROM users WHERE email=$1",
            body.email.lower(),
        )
    if not row or row["status"] != "active":
        raise HTTPException(status_code=401, detail="Invalid credentials")
    if not _verify_password(body.password, row["password_hash"]):
        raise HTTPException(status_code=401, detail="Invalid credentials")

    token = _create_token(row["id"])
    user = {k: v for k, v in dict(row).items() if k != "password_hash"}
    return {"access_token": token, "token_type": "bearer", "user": user}


@app.get("/api/v1/auth/me")
async def get_me(user: dict = Depends(_get_current_user)):
    return user


# ── Intel Endpoints ──
@app.get("/api/v1/intel/shipments")
async def list_shipments(
    request: Request,
    user: dict = Depends(_get_current_user),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    shipper: Optional[str] = None,
    consignee: Optional[str] = None,
    dest_country: Optional[str] = None,
    hs_code: Optional[str] = None,
):
    where = ["tenant_id = $1"]
    params: list = [DEFAULT_TENANT]
    idx = 2
    if shipper:
        where.append(f"shipper ILIKE ${idx}"); params.append(f"%{shipper}%"); idx += 1
    if consignee:
        where.append(f"consignee ILIKE ${idx}"); params.append(f"%{consignee}%"); idx += 1
    if dest_country:
        where.append(f"dest_country ILIKE ${idx}"); params.append(f"%{dest_country}%"); idx += 1
    if hs_code:
        where.append(f"hs_code = ${idx}"); params.append(hs_code); idx += 1

    where_sql = " AND ".join(where)
    async with _acquire(request) as conn:
        total = await conn.fetchval(f"SELECT COUNT(*) FROM intel_shipments WHERE {where_sql}", *params)
        rows = await conn.fetch(
            f"""SELECT * FROM intel_shipments WHERE {where_sql}
                ORDER BY created_at DESC LIMIT ${idx} OFFSET ${idx + 1}""",
            *params, page_size, (page - 1) * page_size,
        )
    return {"items": [_row_to_dict(r) for r in rows], "total": total, "page": page, "page_size": page_size}


@app.get("/api/v1/intel/shipments/{shipment_id}")
async def get_shipment(shipment_id: int, request: Request, user: dict = Depends(_get_current_user)):
    async with _acquire(request) as conn:
        row = await conn.fetchrow(
            "SELECT * FROM intel_shipments WHERE id=$1 AND tenant_id=$2",
            shipment_id, DEFAULT_TENANT,
        )
    if not row:
        raise HTTPException(status_code=404, detail="Shipment not found")
    return dict(row)


@app.post("/api/v1/intel/shipments", status_code=201)
async def create_shipment(request: Request, body: ShipmentCreate, user: dict = Depends(_get_current_user)):
    data = body.model_dump(exclude_none=True)
    cols = list(data.keys())
    vals = list(data.values())
    placeholders = ", ".join(f"${i+3}" for i in range(len(cols)))
    async with _acquire(request) as conn:
        row = await conn.fetchrow(
            f"""INSERT INTO intel_shipments (tenant_id, created_by, {", ".join(cols)})
                VALUES ($1, $2, {placeholders}) RETURNING *""",
            DEFAULT_TENANT, str(user["id"]), *vals,
        )
    return dict(row)


@app.post("/api/v1/intel/import/csv")
async def import_csv(request: Request, file: UploadFile = File(...), user: dict = Depends(_get_current_user)):
    content = await file.read()
    text = content.decode("utf-8-sig")
    reader = csv.DictReader(io.StringIO(text))

    col_map = {
        "shipper": "shipper", "发货人": "shipper", "exporter": "shipper",
        "consignee": "consignee", "收货人": "consignee", "importer": "consignee",
        "product_desc": "product_desc", "产品描述": "product_desc", "产品": "product_desc", "goods": "product_desc",
        "ship_date": "ship_date", "日期": "ship_date", "date": "ship_date",
        "dest_country": "dest_country", "目的国": "dest_country", "destination": "dest_country",
        "origin_country": "origin_country", "原产国": "origin_country",
        "hs_code": "hs_code", "hs编码": "hs_code",
        "qty": "qty", "数量": "qty",
        "qty_unit": "qty_unit", "单位": "qty_unit",
        "carrier": "carrier", "承运人": "carrier",
        "bl_no": "bl_no", "提单号": "bl_no",
    }

    inserted = 0
    processed = 0
    errors: list = []
    async with _acquire(request) as conn:
        for i, raw in enumerate(reader, start=2):
            processed = i - 1
            try:
                row = {}
                for k, v in raw.items():
                    if k and v:
                        mapped = col_map.get(k.strip().lower()) or col_map.get(k.strip())
                        if mapped:
                            row[mapped] = v.strip()
                if not all(k in row for k in ("shipper", "consignee", "product_desc")):
                    errors.append({"row": i, "error": "缺少必填字段 (shipper/consignee/product_desc)"})
                    continue
                cols = list(row.keys())
                vals = list(row.values())
                placeholders = ", ".join(f"${j+4}" for j in range(len(cols)))
                await conn.execute(
                    f"""INSERT INTO intel_shipments (tenant_id, created_by, source_channel, source_ref, is_verified, {", ".join(cols)})
                        VALUES ($1, $2, 'manual_csv', $3, false, {placeholders})""",
                    DEFAULT_TENANT, str(user["id"]), file.filename, *vals,
                )
                inserted += 1
            except Exception as e:
                errors.append({"row": i, "error": str(e)})

    return {"status": "success", "processed": processed, "inserted": inserted, "errors": len(errors), "error_details": errors[:10]}


@app.get("/api/v1/intel/trade-stats")
async def list_trade_stats(
    request: Request,
    user: dict = Depends(_get_current_user),
    hs_code: Optional[str] = None,
    partner_country: Optional[str] = None,
    limit: int = Query(100, le=500),
):
    where = ["tenant_id = $1"]
    params: list = [DEFAULT_TENANT]
    idx = 2
    if hs_code:
        where.append(f"hs_code = ${idx}"); params.append(hs_code); idx += 1
    if partner_country:
        where.append(f"partner_country ILIKE ${idx}"); params.append(f"%{partner_country}%"); idx += 1
    async with _acquire(request) as conn:
        rows = await conn.fetch(
            f"""SELECT * FROM intel_trade_stats WHERE {" AND ".join(where)}
                ORDER BY period DESC LIMIT ${idx}""",
            *params, limit,
        )
    return [_row_to_dict(r) for r in rows]


@app.get("/api/v1/intel/adapter-runs")
async def list_adapter_runs(
    request: Request,
    user: dict = Depends(_get_current_user),
    status: Optional[str] = None,
    limit: int = Query(50, le=200),
):
    where = ["tenant_id = $1"]
    params: list = [DEFAULT_TENANT]
    idx = 2
    if status:
        where.append(f"status = ${idx}"); params.append(status); idx += 1
    async with _acquire(request) as conn:
        rows = await conn.fetch(
            f"""SELECT * FROM intel_adapter_runs WHERE {" AND ".join(where)}
                ORDER BY started_at DESC LIMIT ${idx}""",
            *params, limit,
        )
    return [_row_to_dict(r) for r in rows]


@app.get("/api/v1/intel/channels")
async def list_channels(request: Request, user: dict = Depends(_get_current_user)):
    async with _acquire(request) as conn:
        rows = await conn.fetch(
            "SELECT * FROM intel_data_channels WHERE tenant_id=$1 ORDER BY tier, name",
            DEFAULT_TENANT,
        )
    channels = [_row_to_dict(r) for r in rows]
    return {
        "free_channels": [c for c in channels if c.get("tier") == "free"],
        "paid_channels": [
            {**c, "message": "未开通" if not c.get("is_enabled") else "已开通"}
            for c in channels if c.get("tier") == "paid"
        ],
    }


# ── Customers Endpoints ──
class CustomerCreate(BaseModel):
    company_name: str
    country: Optional[str] = None
    address: Optional[str] = None
    default_port: Optional[str] = None
    credit_level: Optional[str] = None
    stage: str = "lead"
    notes: Optional[str] = None


class ContactCreate(BaseModel):
    customer_id: int
    name: str
    position: Optional[str] = None
    phone: Optional[str] = None
    email: Optional[str] = None
    whatsapp: Optional[str] = None
    wechat: Optional[str] = None
    is_primary: bool = False


class InquiryCreate(BaseModel):
    customer_id: int
    channel: Optional[str] = None
    category_id: Optional[int] = None
    product_name_raw: Optional[str] = None
    quantity: Optional[float] = None
    quantity_unit: Optional[str] = None
    application: Optional[str] = None
    status: str = "inquiry"
    notes: Optional[str] = None


class StageUpdate(BaseModel):
    stage: str
    reason: Optional[str] = None


@app.get("/api/v1/customers")
async def list_customers(
    request: Request,
    user: dict = Depends(_get_current_user),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    stage: Optional[str] = None,
    country: Optional[str] = None,
    q: Optional[str] = None,
):
    where = ["tenant_id = $1"]
    params: list = [DEFAULT_TENANT]
    idx = 2
    if stage:
        where.append(f"stage = ${idx}"); params.append(stage); idx += 1
    if country:
        where.append(f"country ILIKE ${idx}"); params.append(f"%{country}%"); idx += 1
    if q:
        where.append(f"company_name ILIKE ${idx}"); params.append(f"%{q}%"); idx += 1
    where_sql = " AND ".join(where)
    async with _acquire(request) as conn:
        total = await conn.fetchval(f"SELECT COUNT(*) FROM cust_customers WHERE {where_sql}", *params)
        rows = await conn.fetch(
            f"SELECT * FROM cust_customers WHERE {where_sql} ORDER BY created_at DESC LIMIT ${idx} OFFSET ${idx+1}",
            *params, page_size, (page - 1) * page_size,
        )
    return {"items": [_row_to_dict(r) for r in rows], "total": total, "page": page, "page_size": page_size}


@app.post("/api/v1/customers", status_code=201)
async def create_customer(request: Request, body: CustomerCreate, user: dict = Depends(_get_current_user)):
    async with _acquire(request) as conn:
        row = await conn.fetchrow(
            """INSERT INTO cust_customers
               (tenant_id, company_name, country, address, default_port, credit_level, stage, notes, created_by)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *""",
            DEFAULT_TENANT, body.company_name, body.country, body.address,
            body.default_port, body.credit_level, body.stage, body.notes, str(user["id"]),
        )
    return dict(row)


@app.get("/api/v1/customers/{customer_id}")
async def get_customer(customer_id: int, request: Request, user: dict = Depends(_get_current_user)):
    async with _acquire(request) as conn:
        row = await conn.fetchrow(
            "SELECT * FROM cust_customers WHERE id=$1 AND tenant_id=$2", customer_id, DEFAULT_TENANT,
        )
        if not row:
            raise HTTPException(status_code=404, detail="Customer not found")
        contacts = await conn.fetch(
            "SELECT * FROM cust_contacts WHERE customer_id=$1 ORDER BY is_primary DESC, created_at", customer_id,
        )
        inquiries = await conn.fetch(
            "SELECT * FROM cust_inquiries WHERE customer_id=$1 ORDER BY created_at DESC", customer_id,
        )
        stage_log = await conn.fetch(
            "SELECT * FROM cust_stage_log WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 20", customer_id,
        )
    return {**dict(row), "contacts": [dict(c) for c in contacts], "inquiries": [dict(i) for i in inquiries], "stage_log": [dict(s) for s in stage_log]}


@app.post("/api/v1/customers/{customer_id}/contacts", status_code=201)
async def add_contact(customer_id: int, request: Request, body: ContactCreate, user: dict = Depends(_get_current_user)):
    async with _acquire(request) as conn:
        exists = await conn.fetchval("SELECT 1 FROM cust_customers WHERE id=$1 AND tenant_id=$2", customer_id, DEFAULT_TENANT)
        if not exists:
            raise HTTPException(status_code=404, detail="Customer not found")
        row = await conn.fetchrow(
            """INSERT INTO cust_contacts
               (tenant_id, customer_id, name, position, phone, email, whatsapp, wechat, is_primary)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *""",
            DEFAULT_TENANT, customer_id, body.name, body.position, body.phone,
            body.email, body.whatsapp, body.wechat, body.is_primary,
        )
    return dict(row)


@app.post("/api/v1/customers/{customer_id}/inquiries", status_code=201)
async def add_inquiry(customer_id: int, request: Request, body: InquiryCreate, user: dict = Depends(_get_current_user)):
    async with _acquire(request) as conn:
        exists = await conn.fetchval("SELECT 1 FROM cust_customers WHERE id=$1 AND tenant_id=$2", customer_id, DEFAULT_TENANT)
        if not exists:
            raise HTTPException(status_code=404, detail="Customer not found")
        row = await conn.fetchrow(
            """INSERT INTO cust_inquiries
               (tenant_id, customer_id, channel, category_id, product_name_raw,
                quantity, quantity_unit, application, status, notes, created_by)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *""",
            DEFAULT_TENANT, customer_id, body.channel, body.category_id, body.product_name_raw,
            body.quantity, body.quantity_unit, body.application, body.status, body.notes, str(user["id"]),
        )
    return dict(row)


@app.patch("/api/v1/customers/{customer_id}/stage")
async def update_stage(customer_id: int, request: Request, body: StageUpdate, user: dict = Depends(_get_current_user)):
    async with _acquire(request) as conn:
        cust = await conn.fetchrow("SELECT id, stage FROM cust_customers WHERE id=$1 AND tenant_id=$2", customer_id, DEFAULT_TENANT)
        if not cust:
            raise HTTPException(status_code=404, detail="Customer not found")
        from_stage = cust["stage"]
        await conn.execute(
            "UPDATE cust_customers SET stage=$1, updated_at=NOW() WHERE id=$2", body.stage, customer_id,
        )
        await conn.execute(
            """INSERT INTO cust_stage_log (tenant_id, customer_id, from_stage, to_stage, changed_by, reason)
               VALUES ($1,$2,$3,$4,$5,$6)""",
            DEFAULT_TENANT, customer_id, from_stage, body.stage, str(user["id"]), body.reason,
        )
        row = await conn.fetchrow("SELECT * FROM cust_customers WHERE id=$1", customer_id)
    return dict(row)


# ── Market Endpoints ──
class MarketProductCreate(BaseModel):
    region_code: str
    category_id: Optional[int] = None
    demand_level: Optional[str] = None
    popularity_rank: Optional[int] = None
    cert_requirements: Optional[List[str]] = None
    standards: Optional[List[str]] = None
    seasonality: Optional[str] = None
    source: str = "manual"
    confidence: Optional[str] = None


class MarketSpecCreate(BaseModel):
    market_product_id: int
    spec_key: str
    spec_value: str
    unit: Optional[str] = None
    frequency_rank: Optional[int] = None
    sku_id: Optional[int] = None


class NameMappingCreate(BaseModel):
    category_id: Optional[int] = None
    region_code: str
    lang: str
    local_name: str
    alt_names: Optional[List[str]] = None
    hs_code: Optional[str] = None
    source: str = "manual"
    confidence: Optional[str] = None
    is_verified: bool = False


@app.get("/api/v1/market/regions")
async def list_market_regions(request: Request, user: dict = Depends(_get_current_user)):
    async with _acquire(request) as conn:
        rows = await conn.fetch(
            """SELECT DISTINCT region_code FROM market_region_products WHERE tenant_id=$1 ORDER BY region_code""",
            DEFAULT_TENANT,
        )
    return [r["region_code"] for r in rows]


@app.get("/api/v1/market/regions/{region_code}/products")
async def list_region_products(region_code: str, request: Request, user: dict = Depends(_get_current_user)):
    async with _acquire(request) as conn:
        rows = await conn.fetch(
            """SELECT mrp.*, mrps.spec_key, mrps.spec_value, mrps.unit, mrps.frequency_rank
               FROM market_region_products mrp
               LEFT JOIN market_region_product_specs mrps ON mrps.market_product_id = mrp.id
               WHERE mrp.tenant_id=$1 AND mrp.region_code=$2
               ORDER BY mrp.popularity_rank NULLS LAST""",
            DEFAULT_TENANT, region_code.upper(),
        )
    products: dict = {}
    for r in rows:
        pid = r["id"]
        if pid not in products:
            d = _row_to_dict(r)
            d["specs"] = []
            products[pid] = d
        if r.get("spec_key"):
            products[pid]["specs"].append({"key": r["spec_key"], "value": r["spec_value"], "unit": r["unit"], "rank": r["frequency_rank"]})
    return list(products.values())


@app.get("/api/v1/market/name-lookup")
async def name_lookup(
    request: Request,
    user: dict = Depends(_get_current_user),
    q: str = Query(..., min_length=1),
    region_code: Optional[str] = None,
):
    where = ["tenant_id = $1", "(local_name ILIKE $2 OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(alt_names,'[]'::jsonb)) t WHERE t ILIKE $2))"]
    params: list = [DEFAULT_TENANT, f"%{q}%"]
    idx = 3
    if region_code:
        where.append(f"region_code = ${idx}"); params.append(region_code.upper()); idx += 1
    async with _acquire(request) as conn:
        rows = await conn.fetch(
            f"SELECT * FROM market_product_name_mappings WHERE {' AND '.join(where)} ORDER BY is_verified DESC, created_at DESC LIMIT 50",
            *params,
        )
    return [_row_to_dict(r) for r in rows]


@app.post("/api/v1/market/name-mappings", status_code=201)
async def create_name_mapping(request: Request, body: NameMappingCreate, user: dict = Depends(_get_current_user)):
    import json as _json
    async with _acquire(request) as conn:
        row = await conn.fetchrow(
            """INSERT INTO market_product_name_mappings
               (tenant_id, category_id, region_code, lang, local_name, alt_names, hs_code, source, confidence, is_verified)
               VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10) RETURNING *""",
            DEFAULT_TENANT, body.category_id, body.region_code.upper(), body.lang,
            body.local_name, _json.dumps(body.alt_names or []), body.hs_code,
            body.source, body.confidence, body.is_verified,
        )
    return dict(row)


@app.get("/api/v1/market/usages")
async def list_usages(request: Request, user: dict = Depends(_get_current_user)):
    async with _acquire(request) as conn:
        rows = await conn.fetch(
            "SELECT * FROM market_product_usages WHERE tenant_id=$1 ORDER BY usage_code", DEFAULT_TENANT,
        )
    return [_row_to_dict(r) for r in rows]


@app.get("/api/v1/market/ports")
async def list_ports(
    request: Request,
    user: dict = Depends(_get_current_user),
    country_code: Optional[str] = None,
    port_type: Optional[str] = None,
):
    where = ["tenant_id = $1"]
    params: list = [DEFAULT_TENANT]
    idx = 2
    if country_code:
        where.append(f"country_code = ${idx}"); params.append(country_code.upper()); idx += 1
    if port_type:
        where.append(f"port_type = ${idx}"); params.append(port_type); idx += 1
    async with _acquire(request) as conn:
        rows = await conn.fetch(
            f"SELECT * FROM market_ports WHERE {' AND '.join(where)} ORDER BY country_code, name_en",
            *params,
        )
    return [_row_to_dict(r) for r in rows]


# ── Subscriptions Endpoints ──
@app.get("/api/v1/subscriptions")
async def list_subscriptions(request: Request, user: dict = Depends(_get_current_user)):
    async with _acquire(request) as conn:
        rows = await conn.fetch(
            "SELECT * FROM subscriptions WHERE tenant_id=$1 AND status='active' ORDER BY plan_code", DEFAULT_TENANT,
        )
    return [_row_to_dict(r) for r in rows]


@app.get("/api/v1/subscriptions/bundles")
async def list_bundles(request: Request, user: dict = Depends(_get_current_user)):
    async with _acquire(request) as conn:
        rows = await conn.fetch(
            "SELECT * FROM subscription_bundles WHERE is_active=true ORDER BY bundle_code",
        )
    return [_row_to_dict(r) for r in rows]


# ── Dashboard Summary ──
@app.get("/api/v1/dashboard/summary")
async def dashboard_summary(
    request: Request,
    user: dict = Depends(_get_current_user),
    range: str = Query("today"),
):
    """仪表盘汇总：基于真实业务表统计（当前无采样层，sampled=total）。"""
    since_map = {
        "today": timedelta(days=1),
        "7d": timedelta(days=7),
        "30d": timedelta(days=30),
    }
    since = datetime.now(timezone.utc) - since_map.get(range, timedelta(days=1))
    async with _acquire(request) as conn:
        quotations_total = await conn.fetchval(
            "SELECT count(*) FROM quotations WHERE tenant_id=$1", DEFAULT_TENANT
        ) or 0
        quotations_total += await conn.fetchval(
            "SELECT count(*) FROM quote_orders WHERE tenant_id=$1", DEFAULT_TENANT
        ) or 0
        quotations_total += await conn.fetchval(
            "SELECT count(*) FROM cust_inquiries WHERE tenant_id=$1", DEFAULT_TENANT
        ) or 0
        active_customers = await conn.fetchval(
            "SELECT count(*) FROM cust_customers WHERE tenant_id=$1", DEFAULT_TENANT
        ) or 0
        ports = await conn.fetchval(
            "SELECT count(*) FROM market_ports WHERE tenant_id=$1", DEFAULT_TENANT
        ) or 0
        shipments = await conn.fetchval(
            "SELECT count(*) FROM intel_shipments WHERE tenant_id=$1", DEFAULT_TENANT
        ) or 0
        events_cnt = await conn.fetchval(
            "SELECT count(*) FROM events WHERE tenant_id=$1 AND created_at >= $2",
            DEFAULT_TENANT, since,
        ) or 0
    return {
        "range": range,
        "quotations_total": int(quotations_total),
        "quotations_sampled": int(quotations_total),
        "active_customers": int(active_customers),
        "customers_sampled": int(active_customers),
        "dataset_hits": {
            "港口库": int(ports),
            "船运情报": int(shipments),
            "平台事件": int(events_cnt),
        },
        # usage_events 尚无 token/延迟字段，占位为 0
        "token_total": 0,
        "token_sampled": 0,
        "p95_latency_ms": 0,
        "latency_sampled": 0,
    }


# ── Health ──
@app.get("/health")
async def health():
    return {"status": "ok", "service": "kaas-intel-worker"}


# ── Events Ingest (前端事件采集平台级基础设施，所有工位共用) ──
class EventCreate(BaseModel):
    schema_version: int = 1
    event_type: str
    event_source: str = "frontend"
    tenant_id: Optional[str] = None
    actor_id: Optional[str] = None
    session_id: Optional[str] = None
    trace_id: Optional[str] = None
    payload: Optional[dict] = None


@app.post("/api/v1/events")
async def create_event(body: EventCreate, request: Request):
    """接收前端事件采集器上报，写入 events 表（表不存在时静默吸收）。"""
    import json as _json
    async with _acquire(request) as conn:
        # 检测 events 表是否存在
        tbl = await conn.fetchrow(
            "SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='events'"
        )
        if not tbl:
            return {"id": "absorbed"}
        try:
            payload_json = _json.dumps(body.payload or {})
            row = await conn.fetchrow(
                """INSERT INTO events
                   (schema_version, tenant_id, event_type, event_source,
                    actor_id, session_id, trace_id, payload, sampled, created_at)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,false,now())
                   RETURNING id""",
                body.schema_version,
                body.tenant_id or DEFAULT_TENANT,
                body.event_type,
                body.event_source,
                body.actor_id,
                body.session_id,
                body.trace_id,
                payload_json,
            )
            return {"id": str(row["id"])}
        except Exception:
            # 落库失败也吸收，避免前端疯狂重试
            return {"id": "absorbed"}


# ── Worker Entrypoint ──
# 单 Worker 架构：/api/* 走 FastAPI，其余请求交给静态资产绑定
#（Next.js 导出资源 + SPA 回退），资产命中时 Worker 代码不执行。
class Default(WorkerEntrypoint):
    async def fetch(self, request):
        path = urlparse(request.url).path
        if path.startswith("/api/"):
            return await asgi.fetch(app, request, self.env)
        return await self.env.ASSETS.fetch(request)
