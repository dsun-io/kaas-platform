"""KaaS Intel Workstation API — Cloudflare Python Worker.

纯 asyncpg + FastAPI 实现，避开 SQLAlchemy async（Workers 缺 greenlet 支持）。
数据链: 谁(shipper) → 什么时间(ship_date) → 通过谁(carrier) → 向什么地区(dest_country) → 谁(consignee) → 发了什么货(product_desc)
"""
import os
import csv
import io
import hmac
import contextvars
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

from dbjson import row_to_dict
from spec_hash import compute_spec_hash as _compute_spec_hash

# ── 阶段 3 统一数据库封装（platform/db.py 按文件加载）──
# 本包目录与标准库模块 `platform` 同名，不能按包导入，见 platform/db.py 顶部说明。
from importlib.util import (
    spec_from_file_location as _spec_from_file,
    module_from_spec as _module_from_spec,
)

_db_spec = _spec_from_file(
    "platform_db", os.path.join(os.path.dirname(__file__), "platform", "db.py")
)
db = _module_from_spec(_db_spec)
_db_spec.loader.exec_module(db)

DEFAULT_TENANT = "default"

import json as _json


def _row_to_dict(row: asyncpg.Record) -> dict:
    """兼容旧调用点（未指定表名 → 仅按 market_ports 的 jsonb 列解码）。

    jsonb 列映射的唯一真源已收敛到 dbjson.py；新增表请在那里登记，
    并优先使用 `row_to_dict(row, "表名")` 精确解码。
    """
    return row_to_dict(row)


# ── Config（⚠️ 必须按请求读取绑定）───────────────────────────────
# Python Workers 在**模块导入期** os.environ 是空的，只有请求期通过
# request.scope["env"] 才能拿到 vars/secrets（env.HYPERDRIVE 也是这么用的）。
#
# 历史踩坑（生产实证）：JWT_SECRET / ADMIN_SETUP_TOKEN 原先在 import 期用
# os.environ 读取 → 生产一直是空值。后果：
#   - ADMIN_SETUP_TOKEN 失效，bootstrap-admin 恒 503；
#   - JWT_SECRET 回退到公开默认串 "kaas-dev-jwt-secret-change-in-prod"，
#     意味任何知道该字符串的人都能伪造管理员 token。
# 故此处一律在请求期读取，且**不保留任何公开默认值**。
_CURRENT_ENV: contextvars.ContextVar = contextvars.ContextVar("worker_env", default=None)


def _binding(key: str, request: Optional[Request] = None) -> str:
    """请求期读取 vars/secrets。

    优先级：显式传入的 request.scope["env"] → 中间件写入的 ContextVar → os.environ。
    最后一项只是兜底（本地 CPython / 未来运行时行为变化）。
    """
    env = request.scope.get("env") if request is not None else None
    if env is None:
        env = _CURRENT_ENV.get()
    value = getattr(env, key, None) if env is not None else None
    if value is None:
        value = os.environ.get(key)
    return value or ""


def _jwt_secret(request: Optional[Request] = None) -> str:
    """JWT 签名密钥。缺失则 503（绝不回退到任何默认值）。"""
    secret = _binding("JWT_SECRET", request)
    if not secret:
        raise HTTPException(status_code=503, detail="JWT_SECRET not configured")
    return secret


JWT_ALGORITHM = "HS256"


# ── Auth helpers ──
def _hash_password(password: str) -> str:
    """与原后端 (bcrypt) 格式一致。"""
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def _verify_password(password: str, hashed: str) -> bool:
    return bcrypt.checkpw(password.encode("utf-8"), hashed.encode("utf-8"))


def _create_token(user_id: int, request: Optional[Request] = None) -> str:
    payload = {
        "sub": str(user_id),
        "exp": datetime.now(timezone.utc) + timedelta(minutes=1440),
        "iat": datetime.now(timezone.utc),
    }
    return jwt.encode(payload, _jwt_secret(request), algorithm=JWT_ALGORITHM)


def _decode_token(token: str, request: Optional[Request] = None) -> dict:
    try:
        return jwt.decode(token, _jwt_secret(request), algorithms=[JWT_ALGORITHM])
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")


async def _get_current_user(request: Request) -> dict:
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer token")
    payload = _decode_token(auth[7:], request)
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


@app.middleware("http")
async def bind_worker_env(request: Request, call_next):
    """把当前请求的 Worker env 写进 ContextVar。

    供没有 request 参数的深层函数（如 chain.py 的邮件密钥解析）在请求期读到绑定值。
    后注册的中间件在最外层，故它先于 CORS 中间件执行。
    """
    _CURRENT_ENV.set(request.scope.get("env"))
    return await call_next(request)


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
    setup_token = _binding("ADMIN_SETUP_TOKEN", request)
    if not setup_token:
        raise HTTPException(status_code=503, detail="ADMIN_SETUP_TOKEN not configured")
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer ") or not hmac.compare_digest(auth[7:], setup_token):
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
    token = _create_token(row["id"], request)
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

    token = _create_token(row["id"], request)
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
        where.append(f"name ILIKE ${idx}"); params.append(f"%{q}%"); idx += 1
    where_sql = " AND ".join(where)
    async with _acquire(request) as conn:
        total = await conn.fetchval(f"SELECT COUNT(*) FROM customers WHERE {where_sql}", *params)
        rows = await conn.fetch(
            f"SELECT *, name AS company_name FROM customers WHERE {where_sql} ORDER BY created_at DESC LIMIT ${idx} OFFSET ${idx+1}",
            *params, page_size, (page - 1) * page_size,
        )
    return {"items": [_row_to_dict(r) for r in rows], "total": total, "page": page, "page_size": page_size}


@app.post("/api/v1/customers", status_code=201)
async def create_customer(request: Request, body: CustomerCreate, user: dict = Depends(_get_current_user)):
    async with _acquire(request) as conn:
        row = await conn.fetchrow(
            """INSERT INTO customers
               (tenant_id, name, country, address, default_port, credit_level, stage, notes, created_by)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *, name AS company_name""",
            DEFAULT_TENANT, body.company_name, body.country, body.address,
            body.default_port, body.credit_level, body.stage, body.notes, str(user["id"]),
        )
    return dict(row)


@app.get("/api/v1/customers/{customer_id}")
async def get_customer(customer_id: int, request: Request, user: dict = Depends(_get_current_user)):
    async with _acquire(request) as conn:
        row = await conn.fetchrow(
            "SELECT *, name AS company_name FROM customers WHERE id=$1 AND tenant_id=$2", customer_id, DEFAULT_TENANT,
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
        exists = await conn.fetchval("SELECT 1 FROM customers WHERE id=$1 AND tenant_id=$2", customer_id, DEFAULT_TENANT)
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
        exists = await conn.fetchval("SELECT 1 FROM customers WHERE id=$1 AND tenant_id=$2", customer_id, DEFAULT_TENANT)
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
        cust = await conn.fetchrow("SELECT id, stage FROM customers WHERE id=$1 AND tenant_id=$2", customer_id, DEFAULT_TENANT)
        if not cust:
            raise HTTPException(status_code=404, detail="Customer not found")
        from_stage = cust["stage"]
        await conn.execute(
            "UPDATE customers SET stage=$1, updated_at=NOW() WHERE id=$2", body.stage, customer_id,
        )
        await conn.execute(
            """INSERT INTO cust_stage_log (tenant_id, customer_id, from_stage, to_stage, changed_by, reason)
               VALUES ($1,$2,$3,$4,$5,$6)""",
            DEFAULT_TENANT, customer_id, from_stage, body.stage, str(user["id"]), body.reason,
        )
        row = await conn.fetchrow("SELECT *, name AS company_name FROM customers WHERE id=$1", customer_id)
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
            "SELECT count(*) FROM customers WHERE tenant_id=$1", DEFAULT_TENANT
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
    # 已弃用：tenant 一律取自 token（早期允许调用方指定，等于跨租户可写）。
    # 保留字段仅为兼容旧客户端，服务端忽略。
    tenant_id: Optional[str] = None
    actor_id: Optional[str] = None
    session_id: Optional[str] = None
    trace_id: Optional[str] = None
    payload: Optional[dict] = None


@app.post("/api/v1/events")
async def create_event(body: EventCreate, request: Request,
                       user: dict = Depends(_get_current_user)):
    """接收前端事件采集器上报，写入 events 表。

    鉴权：与其他端点一致，必须带 token——此前该端点是唯一无鉴权的写入口，
    任何人都能直接刷库，且可通过 body.tenant_id 指定跨租户写入。
    tenant/actor 现在一律取自 token，落库失败静默吸收（避免前端疯狂重试）。
    """
    payload_json = _json.dumps(body.payload or {})
    try:
        async with _acquire(request) as conn:
            row = await conn.fetchrow(
                """INSERT INTO events
                   (schema_version, tenant_id, event_type, event_source,
                    actor_id, session_id, trace_id, payload, sampled, created_at)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,false,now())
                   RETURNING id""",
                body.schema_version,
                DEFAULT_TENANT,
                body.event_type,
                body.event_source,
                str(user["id"]),
                body.session_id,
                body.trace_id,
                payload_json,
            )
            return {"id": str(row["id"])}
    except Exception:
        # 落库失败也吸收，避免前端疯狂重试
        return {"id": "absorbed"}


# ── 阶段 3 补线上接口（统一走 platform.db；所有查询带 tenant_id）──


class QuotationCreateBody(BaseModel):
    """手动录入报价记录（POST /api/v1/quotations）。"""

    customer_id: str
    product_category: str
    product_spec: dict = {}
    quantity: Optional[int] = None
    unit_price: Optional[float] = None
    currency: str = "CNY"
    unit: str = "meter"
    discount: Optional[float] = None
    notes: Optional[str] = None
    source: str = "manual"


@app.get("/api/v1/quotations")
async def list_quotations_api(
    request: Request,
    customer_id: Optional[str] = None,
    product_category: Optional[str] = None,
    spec_hash: Optional[str] = None,
    limit: int = 100,
    user: dict = Depends(_get_current_user),
):
    """查询历史报价记录（保留入口之一，前端「报价历史」页）。"""
    where = ["tenant_id = $1"]
    params: list = [DEFAULT_TENANT]
    idx = 2
    for col, val in (
        ("customer_id", customer_id),
        ("product_category", product_category),
        ("spec_hash", spec_hash),
    ):
        if val:
            where.append(f"{col} = ${idx}")
            params.append(val)
            idx += 1
    w = " AND ".join(where)
    lim = max(1, min(limit, 500))
    items = await db.fetch(
        request,
        f"""SELECT id, customer_id, product_category, product_spec, spec_hash,
                   unit_price, currency, unit, discount, min_quantity,
                   source, notes, effective_from, created_at
            FROM quotations WHERE {w}
            ORDER BY effective_from DESC LIMIT {lim}""",
        *params,
        table="quotations",
    )
    total = await db.fetchval(
        request, f"SELECT COUNT(*) FROM quotations WHERE {w}", *params
    )
    for r in items:
        r["id"] = str(r["id"])
    return {"items": items, "total": total}


@app.post("/api/v1/quotations", status_code=201)
async def create_quotation_manual(
    body: QuotationCreateBody,
    request: Request,
    user: dict = Depends(_get_current_user),
):
    """手动录入报价记录。报价账以 SKU 价格表 + quotations 为准（David 确认）。"""
    spec_hash = _compute_spec_hash(body.product_spec)
    row = await db.fetchrow(
        request,
        """INSERT INTO quotations
           (tenant_id, customer_id, product_category, product_spec, spec_hash,
            unit_price, currency, unit, discount, min_quantity, source, notes,
            created_by)
           VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           RETURNING id, spec_hash""",
        DEFAULT_TENANT,
        body.customer_id,
        body.product_category,
        _json.dumps(body.product_spec),
        spec_hash,
        body.unit_price,
        body.currency,
        body.unit,
        body.discount,
        body.quantity,
        body.source,
        body.notes,
        str(user["id"]),
    )
    return {"id": str(row["id"]), "spec_hash": row["spec_hash"]}


# ── 阶段 3 · 定价数据（/api/v1/pricing-data，前端「定价数据」页）──
from pricing_rules import (  # noqa: E402
    UNIT_TO_COST_TYPE,
    build_spec_dict,
    expand_category_search,
    normalize_category,
    parse_date,
    to_float,
)

_COST_STATUSES = ("active", "inactive", "deprecated")
_SPEC_DETAIL_COLS = (
    "product_type", "wire_diameter", "height",
    "mesh_width", "mesh_spec", "roll_length",
)


def _spec_json_of(spec: dict) -> dict:
    """规格快照（写入成本条目的 product_spec_json，形状同 orchestrator）。"""
    return {
        "spec_id": spec["id"],
        "product_category": spec["product_category"],
        "product_type": spec["product_type"],
        "wire_diameter": spec["wire_diameter"],
        "height": spec["height"],
        "mesh_width": spec["mesh_width"],
        "mesh_spec": spec["mesh_spec"],
        "roll_length": spec["roll_length"],
        "weight_kg": spec["weight_kg"],
    }


def _spec_detail_of(spec: Optional[dict]) -> Optional[dict]:
    if spec is None:
        return None
    return {
        "id": spec["id"],
        "product_category": spec["product_category"],
        "product_type": spec["product_type"],
        "wire_diameter": spec["wire_diameter"],
        "height": spec["height"],
        "mesh_width": spec["mesh_width"],
        "mesh_spec": spec["mesh_spec"],
        "roll_length": spec["roll_length"],
        "weight_kg": spec["weight_kg"],
    }


async def _find_or_create_spec(request: Request, spec_dict: dict, body: dict) -> dict:
    """按 spec_hash 查找平台通用规格，不存在则创建（规则同 orchestrator）。

    规格是平台通用资产（不带 tenant）；spec_hash 用 body 原始值计算以保持跨运行时一致，
    数值列入库前才转 float（asyncpg 严格类型要求）。
    """
    spec_hash = _compute_spec_hash(spec_dict)
    row = await db.fetchrow(
        request,
        """SELECT id, product_category, product_type, wire_diameter, height,
                  mesh_width, mesh_spec, roll_length, weight_kg
           FROM product_specs WHERE spec_hash = $1""",
        spec_hash,
    )
    if row is not None:
        return dict(row)
    created = await db.fetchrow(
        request,
        """INSERT INTO product_specs
           (product_category, product_type, wire_diameter, height, mesh_width,
            mesh_spec, roll_length, weight_kg, spec_hash)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           RETURNING id, product_category, product_type, wire_diameter, height,
                     mesh_width, mesh_spec, roll_length, weight_kg""",
        normalize_category(
            str(spec_dict.get("product_category") or body.get("product_category") or "")
        ),
        spec_dict.get("product_type"),
        spec_dict.get("wire_diameter"),
        to_float(spec_dict.get("height")),
        to_float(spec_dict.get("mesh_width")),
        spec_dict.get("mesh_spec"),
        to_float(spec_dict.get("roll_length")),
        to_float(body.get("weight_kg")),
        spec_hash,
    )
    return dict(created)


@app.get("/api/v1/pricing-data")
async def list_pricing_data(
    request: Request,
    product_category: Optional[str] = None,
    page: int = 1,
    page_size: int = 20,
    user: dict = Depends(_get_current_user),
):
    """查询当前用户的定价数据列表（tenant/customer 不信任请求体）。"""
    customer_id = str(user["id"])
    where = ["tenant_id = $1", "customer_id = $2"]
    params: list = [DEFAULT_TENANT, customer_id]
    idx = 3
    if product_category:
        normalized = normalize_category(product_category)
        where.append(f"product_category = ANY(${idx})")
        params.append(expand_category_search(normalized))
        idx += 1
    w = " AND ".join(where)
    pg = max(1, page)
    ps = min(100, max(1, page_size))
    total = await db.fetchval(
        request, f"SELECT COUNT(*) FROM customer_cost_items WHERE {w}", *params
    )
    rows = await db.fetch(
        request,
        f"""SELECT id, product_category, spec_hash, product_spec_id, cost_type,
                   amount, currency, unit, effective_from, effective_to,
                   status, source, notes, created_at
            FROM customer_cost_items WHERE {w}
            ORDER BY id DESC LIMIT {ps} OFFSET {(pg - 1) * ps}""",
        *params,
        table="customer_cost_items",
    )
    spec_ids = [r["product_spec_id"] for r in rows if r["product_spec_id"]]
    spec_map: dict = {}
    if spec_ids:
        specs = await db.fetch(
            request,
            """SELECT id, product_category, product_type, wire_diameter, height,
                      mesh_width, mesh_spec, roll_length, weight_kg
               FROM product_specs WHERE id = ANY($1)""",
            spec_ids,
        )
        spec_map = {s["id"]: dict(s) for s in specs}
    items = []
    for r in rows:
        items.append({
            "id": r["id"],
            "product_category": r["product_category"],
            "spec_hash": r["spec_hash"],
            "spec_id": r["product_spec_id"],
            "cost_type": r["cost_type"],
            "amount": r["amount"],
            "currency": r["currency"],
            "unit": r["unit"],
            "effective_from": r["effective_from"],
            "effective_to": r["effective_to"],
            "status": r["status"],
            "source": r["source"],
            "notes": r["notes"],
            "created_at": r["created_at"],
            "product_spec": _spec_detail_of(
                spec_map.get(r["product_spec_id"]) if r["product_spec_id"] else None
            ),
        })
    return {
        "items": items,
        "total": total,
        "page": pg,
        "page_size": ps,
        "pages": (total + ps - 1) // ps if total > 0 else 0,
    }


@app.post("/api/v1/pricing-data", status_code=201)
async def create_pricing_data(
    body: dict,
    request: Request,
    user: dict = Depends(_get_current_user),
):
    """录入客户规格 + 成本价数据：同一事务写 product_specs + customer_cost_items。

    tenant/customer 归属以登录用户为准，不信任请求体（规则同 orchestrator）。
    """
    customer_id = str(user["id"])
    raw_category = (body.get("product_category") or "").strip()
    product_category = normalize_category(raw_category)
    if not product_category:
        raise HTTPException(status_code=422, detail="product_category is required")
    cost_amount = body.get("cost_amount")
    if cost_amount is None or not isinstance(cost_amount, (int, float)) or cost_amount <= 0:
        raise HTTPException(status_code=422, detail="cost_amount must be > 0")
    cost_unit = (body.get("cost_unit") or "").strip()
    cost_type = UNIT_TO_COST_TYPE.get(cost_unit)
    if cost_type is None:
        raise HTTPException(
            status_code=422,
            detail=f"cost_unit must be one of: {list(UNIT_TO_COST_TYPE.keys())}",
        )
    status = (body.get("status") or "active").strip()
    if status not in _COST_STATUSES:
        raise HTTPException(
            status_code=422, detail="status must be active, inactive, or deprecated"
        )
    spec_dict = build_spec_dict(body)
    if not spec_dict:
        raise HTTPException(
            status_code=422,
            detail="At least one spec field is required beyond product_category",
        )
    spec = await _find_or_create_spec(request, spec_dict, body)
    spec_hash = _compute_spec_hash(spec_dict)
    row = await db.fetchrow(
        request,
        """INSERT INTO customer_cost_items
           (tenant_id, customer_id, product_category, product_spec_id,
            product_spec_json, spec_hash, cost_type, amount, currency, unit,
            effective_from, effective_to, status, source, notes, created_by)
           VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
           RETURNING id, amount, currency, unit, status, effective_from,
                     effective_to""",
        DEFAULT_TENANT,
        customer_id,
        product_category,
        spec["id"],
        _json.dumps(_spec_json_of(spec)),
        spec_hash,
        cost_type,
        float(cost_amount),
        (body.get("cost_currency") or "CNY").strip(),
        cost_unit,
        # effective_from 列 NOT NULL：不传 = 立即生效（同 server_default 语义）
        parse_date(body.get("effective_from")) or datetime.now(timezone.utc),
        parse_date(body.get("effective_to")),
        status,
        "manual",
        body.get("notes"),
        str(user["id"]),
    )
    return {
        "id": row["id"],
        "product_category": product_category,
        "spec_hash": spec_hash,
        "spec_id": spec["id"],
        "cost_type": cost_type,
        "amount": row["amount"],
        "currency": row["currency"],
        "unit": row["unit"],
        "effective_from": row["effective_from"],
        "effective_to": row["effective_to"],
        "status": row["status"],
        "product_spec": _spec_detail_of(spec),
    }


@app.patch("/api/v1/pricing-data/{item_id}")
async def update_pricing_data(
    item_id: int,
    body: dict,
    request: Request,
    user: dict = Depends(_get_current_user),
):
    """编辑客户规格 + 成本价数据（仅本人数据；规格变更时重建 spec_hash）。"""
    customer_id = str(user["id"])
    current = await db.fetchrow(
        request,
        """SELECT id, product_category, spec_hash, product_spec_id, product_spec_json
           FROM customer_cost_items
           WHERE id = $1 AND tenant_id = $2 AND customer_id = $3""",
        item_id,
        DEFAULT_TENANT,
        customer_id,
        table="customer_cost_items",
    )
    if current is None:
        raise HTTPException(status_code=404, detail="Pricing data not found")

    updates: dict = {}
    new_amount = body.get("cost_amount")
    if new_amount is not None:
        if not isinstance(new_amount, (int, float)) or new_amount <= 0:
            raise HTTPException(status_code=422, detail="cost_amount must be > 0")
        updates["amount"] = float(new_amount)
    new_unit = body.get("cost_unit")
    if new_unit is not None:
        new_cost_type = UNIT_TO_COST_TYPE.get(str(new_unit).strip())
        if new_cost_type is None:
            raise HTTPException(
                status_code=422,
                detail=f"cost_unit must be one of: {list(UNIT_TO_COST_TYPE.keys())}",
            )
        updates["cost_type"] = new_cost_type
        updates["unit"] = str(new_unit).strip()
    new_category = body.get("product_category")
    if new_category is not None:
        updates["product_category"] = normalize_category(str(new_category).strip())

    spec_changed = any(f in body for f in _SPEC_DETAIL_COLS)
    if spec_changed:
        old_snap = current["product_spec_json"] or {}
        full_spec = {
            "product_category": updates.get(
                "product_category", current["product_category"]
            ),
        }
        for f in _SPEC_DETAIL_COLS:
            full_spec[f] = body[f] if f in body else old_snap.get(f)
        non_null = {k: v for k, v in full_spec.items() if v is not None}
        spec = await _find_or_create_spec(request, non_null, body)
        updates["spec_hash"] = _compute_spec_hash(non_null)
        updates["product_spec_id"] = spec["id"]
        updates["product_spec_json"] = _spec_json_of(spec)
    if "effective_from" in body:
        # 列 NOT NULL：空值 = 保持原样，不更新
        _ef = parse_date(body["effective_from"])
        if _ef is not None:
            updates["effective_from"] = _ef
    if "effective_to" in body:
        updates["effective_to"] = parse_date(body["effective_to"])
    if "status" in body:
        new_status = str(body["status"]).strip()
        if new_status not in _COST_STATUSES:
            raise HTTPException(
                status_code=422,
                detail="status must be active, inactive, or deprecated",
            )
        updates["status"] = new_status
    if "notes" in body:
        updates["notes"] = body["notes"]
    if not updates:
        raise HTTPException(status_code=422, detail="No fields to update")

    set_parts = []
    params: list = []
    for i, (col, val) in enumerate(updates.items(), start=1):
        if col == "product_spec_json":
            set_parts.append(f"{col} = ${i}::jsonb")
            params.append(_json.dumps(val))
        else:
            set_parts.append(f"{col} = ${i}")
            params.append(val)
    params += [item_id, DEFAULT_TENANT, customer_id]
    n = len(updates)
    row = await db.fetchrow(
        request,
        f"""UPDATE customer_cost_items SET {', '.join(set_parts)}
            WHERE id = ${n + 1} AND tenant_id = ${n + 2} AND customer_id = ${n + 3}
            RETURNING id, product_category, spec_hash, product_spec_id,
                      cost_type, amount, currency, unit, effective_from,
                      effective_to, status, product_spec_json""",
        *params,
        table="customer_cost_items",
    )
    if row is None:
        raise HTTPException(status_code=500, detail="Failed to update cost item")
    snap = row["product_spec_json"] or {}
    spec = {"id": snap.get("spec_id"), **snap} if snap.get("spec_id") else None
    return {
        "id": row["id"],
        "product_category": row["product_category"],
        "spec_hash": row["spec_hash"],
        "spec_id": row["product_spec_id"],
        "cost_type": row["cost_type"],
        "amount": row["amount"],
        "currency": row["currency"],
        "unit": row["unit"],
        "effective_from": row["effective_from"],
        "effective_to": row["effective_to"],
        "status": row["status"],
        "product_spec": _spec_detail_of(spec),
    }


@app.delete("/api/v1/pricing-data/{item_id}")
async def delete_pricing_data(
    item_id: int,
    request: Request,
    user: dict = Depends(_get_current_user),
):
    """软删除定价数据（设为 inactive，仅本人数据）。"""
    row = await db.fetchrow(
        request,
        """UPDATE customer_cost_items SET status = 'inactive'
           WHERE id = $1 AND tenant_id = $2 AND customer_id = $3
           RETURNING id""",
        item_id,
        DEFAULT_TENANT,
        str(user["id"]),
    )
    if row is None:
        raise HTTPException(
            status_code=404, detail="Pricing data not found or access denied"
        )
    return {"id": item_id, "status": "inactive", "message": "Pricing data deactivated"}


# ── 阶段 3 · SKU 价格（/api/v1/spec/skus/{id}/prices + /api/v1/spec/prices/{id}）──
# 规则同 orchestrator services/price_engine.upsert_price：INSERT-only，
# 改价 = 截断/作废旧价 + 插入新价，不原地修改历史价格。
# 与 orchestrator 的差异：所有查询带 tenant_id（计划硬要求）；
# 新价被旧价完全包含时返回 422（orchestrator 为异常 500），错误更清晰。


async def _upsert_price(
    request: Request,
    *,
    sku_id: int,
    tenant_id: str,
    price: float,
    price_unit: str,
    effective_from: datetime,
    effective_to: Optional[datetime] = None,
    min_qty: Optional[float] = None,
    tier_rules: Optional[list] = None,
    note: Optional[str] = None,
    change_reason: Optional[str] = None,
    created_by: Optional[str] = None,
) -> int:
    overlapping = await db.fetch(
        request,
        """SELECT id, effective_from, effective_to FROM product_sku_prices
           WHERE sku_id = $1 AND tenant_id = $2 AND status = 'active'
             AND tstzrange(effective_from,
                           COALESCE(effective_to, 'infinity'::timestamptz), '[)')
                 && tstzrange($3::timestamptz,
                              COALESCE($4::timestamptz, 'infinity'::timestamptz), '[)')
           FOR UPDATE""",
        sku_id,
        tenant_id,
        effective_from,
        effective_to,
    )
    for old in overlapping:
        old_from, old_to = old["effective_from"], old["effective_to"]
        if old_from >= effective_from and (
            effective_to is None or (old_to is not None and old_to <= effective_to)
        ):
            await db.execute(
                request,
                "UPDATE product_sku_prices SET status = 'superseded' WHERE id = $1",
                old["id"],
            )
        elif old_from < effective_from:
            await db.execute(
                request,
                "UPDATE product_sku_prices SET effective_to = $1 WHERE id = $2",
                effective_from,
                old["id"],
            )
        else:
            raise HTTPException(
                status_code=422,
                detail="New price is fully contained in an existing active price range.",
            )
    row = await db.fetchrow(
        request,
        """INSERT INTO product_sku_prices
           (sku_id, tenant_id, price, price_unit, min_qty, tier_rules,
            effective_from, effective_to, status, note, change_reason, created_by)
           VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,'active',$9,$10,$11)
           RETURNING id""",
        sku_id,
        tenant_id,
        price,
        price_unit,
        min_qty,
        _json.dumps(tier_rules) if tier_rules is not None else None,
        effective_from,
        effective_to,
        note,
        change_reason,
        created_by,
    )
    return row["id"]


@app.post("/api/v1/spec/skus/{sku_id}/prices")
async def create_price(
    sku_id: int,
    body: dict,
    request: Request,
    user: dict = Depends(_get_current_user),
):
    """为 SKU 设定价格（INSERT-only 改价规则同 orchestrator）。"""
    sku = await db.fetchrow(
        request,
        "SELECT id FROM product_skus WHERE id = $1 AND tenant_id = $2",
        sku_id,
        DEFAULT_TENANT,
    )
    if sku is None:
        return {"error": "not_found"}
    price = body.get("price")
    if not isinstance(price, (int, float)) or price <= 0:
        raise HTTPException(status_code=422, detail="price must be > 0")
    price_unit = (body.get("price_unit") or "").strip()
    if not price_unit:
        raise HTTPException(status_code=422, detail="price_unit is required")
    unit = await db.fetchrow(
        request, "SELECT code FROM price_units WHERE code = $1", price_unit
    )
    if unit is None:
        raise HTTPException(
            status_code=422, detail=f"Unknown price_unit: {price_unit}"
        )
    change_reason = (body.get("change_reason") or "").strip()
    if not change_reason:
        raise HTTPException(status_code=422, detail="change_reason is required")
    # 价格按天生效：parse_date 截断到当天（同定价数据）
    effective_from = parse_date(body.get("effective_from"))
    if effective_from is None:
        raise HTTPException(status_code=422, detail="effective_from is required")
    price_id = await _upsert_price(
        request,
        sku_id=sku_id,
        tenant_id=DEFAULT_TENANT,
        price=float(price),
        price_unit=price_unit,
        effective_from=effective_from,
        effective_to=parse_date(body.get("effective_to")),
        min_qty=to_float(body.get("min_qty")),
        tier_rules=body.get("tier_rules"),
        note=body.get("note"),
        change_reason=change_reason,
        created_by=str(user["id"]),
    )
    return {"id": price_id}


@app.patch("/api/v1/spec/prices/{price_id}")
async def patch_price(
    price_id: int,
    body: dict,
    request: Request,
    user: dict = Depends(_get_current_user),
):
    """价格条目维护（只允许改 status / note / effective_to，同 orchestrator）。"""
    current = await db.fetchrow(
        request,
        "SELECT id FROM product_sku_prices WHERE id = $1 AND tenant_id = $2",
        price_id,
        DEFAULT_TENANT,
    )
    if current is None:
        return {"error": "not_found"}
    updates: dict = {}
    if body.get("status") is not None:
        updates["status"] = str(body["status"]).strip()
    if body.get("note") is not None:
        updates["note"] = body["note"]
    if body.get("effective_to") is not None:
        _et = parse_date(body["effective_to"])
        if _et is not None:
            updates["effective_to"] = _et
    if not updates:
        return {"id": price_id, "status": None}
    set_parts = [f"{col} = ${i}" for i, col in enumerate(updates.keys(), start=1)]
    params = list(updates.values()) + [price_id, DEFAULT_TENANT]
    n = len(updates)
    row = await db.fetchrow(
        request,
        f"""UPDATE product_sku_prices SET {', '.join(set_parts)}
            WHERE id = ${n + 1} AND tenant_id = ${n + 2}
            RETURNING id, status""",
        *params,
    )
    return {"id": row["id"], "status": row["status"]}


# ── Worker Entrypoint ──
# 单 Worker 架构：/api/* 与 /health 走 FastAPI，其余请求交给静态资产绑定
#（Next.js 导出资源 + SPA 回退），资产命中时 Worker 代码不执行。
#
# 注意：/health 必须显式走 Worker，否则会被 assets 的 SPA 回退吃掉，
# 永远返回 index.html（状态码 200 但内容不是健康检查结果）——曾导致
# CI 冒烟测试形同虚设，Worker 实际已挂却仍然"通过"。
class Default(WorkerEntrypoint):
    async def fetch(self, request):
        path = urlparse(request.url).path
        if path.startswith("/api/") or path == "/health":
            return await asgi.fetch(app, request, self.env)
        return await self.env.ASSETS.fetch(request)


# ── P1-P7 工位链（AI 层/线索池/触达）：chain.py 注册到 app ──
import chain  # noqa: E402,F401

