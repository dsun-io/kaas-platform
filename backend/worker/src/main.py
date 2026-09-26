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
from spec_hash import (
    compute_spec_hash as _compute_spec_hash,
    compute_sku_hash as _compute_sku_hash,
    normalize_value as _normalize_value,
)

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
# 共享内核自检。降级保护：即使打包时未带上 kaas_common，也不影响 Worker 启动，
# 只在 /health 里显示 loaded=false —— 部署后一眼就能确认打包链路是否通。
try:
    from kaas_common import core_health as _core_health
except Exception:  # noqa: BLE001 - 任何加载失败都不应阻断 Worker
    def _core_health():  # type: ignore[misc]
        return {"core": "kaas_common", "loaded": False}


@app.get("/health")
async def health():
    return {"status": "ok", "service": "kaas-intel-worker", "shared": _core_health()}


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


# ══════════ 阶段 3 · 第二批：规格分类树 / 向导 / 事件列表 / 管理 / 能力 ══════════
# 形状与 backend/orchestrator 对齐（契约 shared/contracts/spec-system.ts）；
# 存储语义差（tenants.yaml→单租户 / reload no-op 等）见 docs/CLEANUP_LOG.md。


def _build_category_tree(flat: list, parent_id=None):
    """分类嵌套树（同 orchestrator categories._build_tree 的返回形状）。"""
    nodes = []
    for cat in flat:
        if cat["parent_id"] == parent_id:
            node = {
                k: cat[k]
                for k in (
                    "id", "code", "name", "parent_id", "path",
                    "level", "industry_code", "is_leaf", "is_active",
                )
            }
            node["children"] = _build_category_tree(flat, cat["id"])
            nodes.append(node)
    return nodes


def _category_recursive_ids(flat: list, root_id: int) -> list:
    """收集 root_id 及全部子孙分类 id（分类量小，Python 展开足够）。"""
    ids = [root_id]
    changed = True
    while changed:
        changed = False
        for c in flat:
            if c["parent_id"] in ids and c["id"] not in ids:
                ids.append(c["id"])
                changed = True
    return ids


@app.get("/api/v1/spec/categories")
async def list_spec_categories(request: Request, user: dict = Depends(_get_current_user)):
    """品类树（GET /api/v1/spec/categories，形状同 orchestrator：{"items": 树}）。"""
    rows = await db.fetch(
        request,
        """SELECT id, code, name, parent_id, path, level, industry_code,
                  sort_order, is_leaf, is_active
             FROM product_categories
            WHERE is_active = TRUE
            ORDER BY sort_order, id""",
        table="product_categories",
    )
    flat = [_row_to_dict(r) for r in rows]
    return {"items": _build_category_tree(flat)}


@app.get("/api/v1/spec/categories/{category_id}")
async def get_spec_category(
    category_id: int, request: Request, user: dict = Depends(_get_current_user)
):
    row = await db.fetchrow(
        request,
        """SELECT id, code, name, parent_id, path, level, industry_code, is_leaf
             FROM product_categories WHERE id = $1""",
        category_id,
    )
    if row is None:
        return {"error": "not_found"}
    return _row_to_dict(row)


@app.get("/api/v1/spec/categories/{category_id}/bindings")
async def get_spec_category_bindings(
    category_id: int, request: Request, user: dict = Depends(_get_current_user)
):
    """分类绑定的规格属性 + 可选值（同 orchestrator get_bindings 形状）。"""
    rows = await db.fetch(
        request,
        """SELECT b.id AS binding_id, b.attr_role, b.is_required, b.is_locked,
                  b.sort_order, b.group_code,
                  a.id AS attr_id, a.code, a.name, a.data_type,
                  a.group_code AS attr_group, a.scope, a.unit, a.unit_group,
                  a.number_min, a.number_max, a.number_step
             FROM category_attribute_bindings b
             JOIN spec_attributes a ON a.id = b.attribute_id
            WHERE b.category_id = $1
              AND (a.scope = 'global' OR a.tenant_id = $2)
              AND a.status = 'active'
            ORDER BY b.sort_order, b.id""",
        category_id, DEFAULT_TENANT,
    )
    items = []
    for r in rows:
        values = await db.fetch(
            request,
            """SELECT id, value_code AS code, value_label AS label
                 FROM spec_attribute_values
                WHERE attribute_id = $1
                  AND (scope = 'global' OR tenant_id = $2)
                  AND status = 'active'
                ORDER BY sort_order, id""",
            r["attr_id"], DEFAULT_TENANT,
        )
        items.append({
            "binding_id": r["binding_id"],
            "attr_role": r["attr_role"],
            "is_required": r["is_required"],
            "is_locked": r["is_locked"],
            "sort_order": r["sort_order"],
            "group_code": r["group_code"],
            "attribute": {
                "id": r["attr_id"],
                "code": r["code"],
                "name": r["name"],
                "data_type": r["data_type"],
                "group_code": r["attr_group"],
                "scope": r["scope"],
                "unit": r["unit"],
                "unit_group": r["unit_group"],
                "number_min": float(r["number_min"]) if r["number_min"] is not None else None,
                "number_max": float(r["number_max"]) if r["number_max"] is not None else None,
                "number_step": float(r["number_step"]) if r["number_step"] is not None else None,
                "values": [{"id": v["id"], "code": v["code"], "label": v["label"]} for v in values],
            },
        })
    return {"items": items}


# ── 阶段 3 · 规格向导（/api/v1/spec/wizard，契约 shared/contracts/spec-system.ts）──
@app.post("/api/v1/spec/wizard/submit")
async def wizard_submit(body: dict, request: Request, user: dict = Depends(_get_current_user)):
    """向导提交：生成/命中 SKU（可选带价格）。
    响应形状 = WizardSubmitResponse {sku_id, price_id, spec_hash, is_new_sku, revision}。"""
    category_id = body.get("category_id")
    spec_values = body.get("spec_values") or {}
    if not isinstance(category_id, int) or not isinstance(spec_values, dict) or not spec_values:
        raise HTTPException(status_code=422, detail="category_id and spec_values are required")
    cat = await db.fetchrow(
        request, "SELECT id, code FROM product_categories WHERE id = $1", category_id
    )
    if cat is None:
        return {"error": "not_found"}
    spec_for_hash = {str(k): (v or {}).get("value") for k, v in spec_values.items()}
    spec_hash = _compute_sku_hash(cat["code"], spec_for_hash)
    existing = await db.fetchrow(
        request,
        """SELECT id, revision FROM product_skus
            WHERE tenant_id = $1 AND category_id = $2 AND spec_hash = $3 AND is_active = TRUE
            ORDER BY revision DESC LIMIT 1""",
        DEFAULT_TENANT, category_id, spec_hash,
    )
    if existing is not None:
        sku_id, revision, is_new = existing["id"], existing["revision"], False
    else:
        row = await db.fetchrow(
            request,
            """INSERT INTO product_skus
                   (tenant_id, category_id, spec_values, spec_hash, schema_version,
                    revision, weight_kg, description, is_active, created_by)
                 VALUES ($1, $2, $3, $4, 1, 1, $5, $6, TRUE, $7)
                 RETURNING id, revision""",
            DEFAULT_TENANT, category_id, _json.dumps(spec_values), spec_hash,
            to_float(body.get("weight_kg")), body.get("description"), str(user["id"]),
        )
        sku_id, revision, is_new = row["id"], row["revision"], True
    price_id = None
    pricing = body.get("pricing")
    if is_new and isinstance(pricing, dict):
        price = pricing.get("price")
        price_unit = (pricing.get("price_unit") or "").strip()
        change_reason = (pricing.get("change_reason") or "").strip()
        effective_from = parse_date(pricing.get("effective_from"))
        if (
            isinstance(price, (int, float)) and price > 0
            and price_unit and change_reason and effective_from is not None
        ):
            price_id = await _upsert_price(
                request,
                sku_id=sku_id,
                tenant_id=DEFAULT_TENANT,
                price=float(price),
                price_unit=price_unit,
                effective_from=effective_from,
                effective_to=parse_date(pricing.get("effective_to")),
                min_qty=to_float(pricing.get("min_qty")),
                tier_rules=pricing.get("tier_rules"),
                note=pricing.get("note"),
                change_reason=change_reason,
                created_by=str(user["id"]),
            )
    return {
        "sku_id": sku_id,
        "price_id": price_id,
        "spec_hash": spec_hash,
        "is_new_sku": is_new,
        "revision": revision,
    }


@app.post("/api/v1/spec/wizard/propose-attribute")
async def wizard_propose_attribute(
    body: dict, request: Request, user: dict = Depends(_get_current_user)
):
    """向导属性建议：未登记属性进 attribute_proposals（响应 {id, status}）。"""
    category_id = body.get("category_id")
    proposed_name = (body.get("proposed_name") or "").strip()
    group_code = (body.get("group_code") or "").strip()
    proposed_type = (body.get("proposed_type") or "string").strip()
    if not isinstance(category_id, int) or not proposed_name:
        raise HTTPException(status_code=422, detail="category_id and proposed_name are required")
    sample_values = body.get("sample_values")
    sample_values = [str(v) for v in sample_values] if isinstance(sample_values, list) else None
    import difflib

    existing = await db.fetch(
        request,
        "SELECT name, aliases FROM spec_attributes WHERE status = 'active'",
        table="spec_attributes",
    )
    pool: set = set()
    for r in existing:
        pool.add(r["name"])
        if r["aliases"]:
            pool.update(str(a) for a in r["aliases"])
    suggestions = difflib.get_close_matches(proposed_name, sorted(pool), n=3, cutoff=0.5)
    row = await db.fetchrow(
        request,
        """INSERT INTO attribute_proposals
               (tenant_id, category_id, group_code, proposed_name, proposed_aliases,
                proposed_unit, proposed_unit_group, proposed_type, sample_values,
                occurrence_count, recommended_for_promotion, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1, FALSE, 'pending')
             RETURNING id, status""",
        DEFAULT_TENANT, category_id, group_code, proposed_name,
        _json.dumps(suggestions), body.get("proposed_unit"), body.get("proposed_unit_group"),
        proposed_type,
        _json.dumps(sample_values) if sample_values is not None else None,
    )
    return {"id": row["id"], "status": row["status"]}


# ── 阶段 3 · 事件列表（GET /api/v1/events，与既有 POST 同表，倒序分页）──
@app.get("/api/v1/events")
async def list_events_api(
    request: Request,
    page: int = 1,
    page_size: int = 20,
    event_type: str = "",
    user: dict = Depends(_get_current_user),
):
    page = max(page, 1)
    page_size = min(max(page_size, 1), 100)
    where = "WHERE tenant_id = $1"
    args: list = [DEFAULT_TENANT]
    if event_type:
        args.append(event_type)
        where += f" AND event_type = ${len(args)}"
    total = await db.fetchval(request, f"SELECT count(*) FROM events {where}", *args)
    args.extend([page_size, (page - 1) * page_size])
    rows = await db.fetch(
        request,
        f"""SELECT * FROM events {where}
              ORDER BY id DESC LIMIT ${len(args) - 1} OFFSET ${len(args)}""",
        *args,
    )
    return {
        "items": [_row_to_dict(r) for r in rows],
        "total": total,
        "page": page,
        "page_size": page_size,
    }


# ── 阶段 3 · 管理（/api/v1/admin/*；yaml→DB 等语义差见 docs/CLEANUP_LOG.md）──
@app.get("/api/v1/admin/feature_flag")
async def get_feature_flag(
    flag_name: str, request: Request, user: dict = Depends(_get_current_user)
):
    row = await db.fetchrow(
        request,
        "SELECT flag_value FROM feature_flags WHERE tenant_id = $1 AND flag_name = $2",
        DEFAULT_TENANT, flag_name,
    )
    return {"flag_name": flag_name, "flag_value": bool(row["flag_value"]) if row else False}


@app.post("/api/v1/admin/feature_flag")
async def set_feature_flag(body: dict, request: Request, user: dict = Depends(_get_current_user)):
    """功能开关写 DB（orchestrator 写 tenants.yaml，存储差见 UNCERTAIN #13），并记审计。"""
    flag_name = (body.get("flag_name") or "").strip()
    if not flag_name:
        raise HTTPException(status_code=422, detail="flag_name is required")
    flag_value = bool(body.get("flag_value", False))
    tenant_id = (body.get("tenant_id") or DEFAULT_TENANT).strip()
    old = await db.fetchrow(
        request,
        "SELECT flag_value FROM feature_flags WHERE tenant_id = $1 AND flag_name = $2",
        tenant_id, flag_name,
    )
    old_value = bool(old["flag_value"]) if old else False
    row = await db.fetchrow(
        request,
        """INSERT INTO feature_flags (tenant_id, flag_name, flag_value, updated_by)
             VALUES ($1, $2, $3, $4)
           ON CONFLICT (tenant_id, flag_name)
             DO UPDATE SET flag_value = EXCLUDED.flag_value,
                           updated_at = now(),
                           updated_by = EXCLUDED.updated_by
           RETURNING id""",
        tenant_id, flag_name, flag_value, str(user["id"]),
    )
    await db.execute(
        request,
        """INSERT INTO feature_flag_audit
               (action, actor_id, tenant_id, resource_type, resource_id,
                flag_name, old_value, new_value, reason)
             VALUES ('feature_flag_change', $1, $2, 'feature_flag', $3, $4, $5, $6, $7)""",
        str(user["id"]), tenant_id, str(row["id"]), flag_name,
        str(old_value), str(flag_value), body.get("reason"),
    )
    return {"flag_name": flag_name, "flag_value": flag_value}


@app.get("/api/v1/admin/tenants")
async def list_tenants(user: dict = Depends(_get_current_user)):
    # Worker 单租户形态：tenants.yaml 不可移植，固定返回默认租户（UNCERTAIN #13）
    return {"items": [{"tenant_id": DEFAULT_TENANT, "name": DEFAULT_TENANT}]}


@app.post("/api/v1/admin/tenants/reload")
async def reload_tenants(request: Request, user: dict = Depends(_get_current_user)):
    """租户重载：Worker 无 yaml，仅记审计 no-op（语义差见 docs/CLEANUP_LOG.md）。"""
    await db.execute(
        request,
        """INSERT INTO feature_flag_audit (action, actor_id, tenant_id, resource_type, reason)
             VALUES ('tenants_reload', $1, $2, 'tenants', 'worker 单租户无 yaml，no-op 记账')""",
        str(user["id"]), DEFAULT_TENANT,
    )
    return {"reloaded": True, "items": [{"tenant_id": DEFAULT_TENANT, "name": DEFAULT_TENANT}]}


@app.get("/api/v1/admin/audit-log")
async def get_audit_log(
    request: Request,
    page: int = 1,
    page_size: int = 20,
    user: dict = Depends(_get_current_user),
):
    """审计日志（源=feature_flag_audit 表；orchestrator 源=deployment_audit.jsonl）。"""
    page = max(page, 1)
    page_size = min(max(page_size, 1), 100)
    total = await db.fetchval(request, "SELECT count(*) FROM feature_flag_audit")
    rows = await db.fetch(
        request,
        """SELECT id, action, actor_id, resource_type, resource_id, tenant_id,
                  flag_name, old_value, new_value, reason, created_at
             FROM feature_flag_audit
            ORDER BY id DESC LIMIT $1 OFFSET $2""",
        page_size, (page - 1) * page_size,
    )
    items = [
        {
            "id": r["id"],
            "action": r["action"],
            "actor_id": r["actor_id"],
            "resource_type": r["resource_type"],
            "resource_id": r["resource_id"],
            "tenant_id": r["tenant_id"],
            "flag_key": r["flag_name"],
            "enabled_before": r["old_value"],
            "enabled_after": r["new_value"],
            "reason": r["reason"],
            "timestamp": r["created_at"].isoformat() if r["created_at"] else None,
        }
        for r in rows
    ]
    return {"items": items, "total": total, "page": page, "page_size": page_size}


@app.get("/api/v1/admin/archive-logs")
async def get_archive_logs(user: dict = Depends(_get_current_user)):
    # Worker 无文件系统，归档日志占位空列表（语义差见 docs/CLEANUP_LOG.md）
    return {"items": [], "total": 0}


# ── 阶段 3 · 客户能力（/api/v1/capabilities*，表 customer_capabilities）──
def _capability_row(r) -> dict:
    """customer_capabilities 行 → API 形状（spec_constraints JSON 手动解码）。"""
    sc = r["spec_constraints"]
    if isinstance(sc, str):
        try:
            sc = _json.loads(sc)
        except ValueError:
            sc = {}
    return {
        "id": r["id"],
        "customer_id": r["customer_id"],
        "customer_name": r["customer_name"],
        "product_category": r["product_category"],
        "spec_constraints": sc or {},
        "notes": r["notes"],
        "effective_from": r["effective_from"],
        "updated_at": r["updated_at"],
    }


@app.get("/api/v1/capability-customers")
async def list_capability_customers(request: Request, user: dict = Depends(_get_current_user)):
    rows = await db.fetch(
        request,
        """SELECT customer_id, customer_name,
                  count(DISTINCT product_category) AS category_count,
                  max(updated_at) AS updated_at
             FROM customer_capabilities
            WHERE tenant_id = $1
            GROUP BY customer_id, customer_name
            ORDER BY max(updated_at) DESC""",
        DEFAULT_TENANT,
    )
    items = []
    for r in rows:
        d = _row_to_dict(r)
        d["locale"] = "zh-CN"
        d["region"] = "CN"
        items.append(d)
    return {"items": items}


@app.get("/api/v1/capabilities")
async def list_capabilities_api(
    request: Request, customer_id: str = "", user: dict = Depends(_get_current_user)
):
    if customer_id:
        rows = await db.fetch(
            request,
            """SELECT * FROM customer_capabilities
                WHERE tenant_id = $1 AND customer_id = $2
                ORDER BY product_category""",
            DEFAULT_TENANT, customer_id,
        )
    else:
        rows = await db.fetch(
            request,
            """SELECT * FROM customer_capabilities
                WHERE tenant_id = $1 ORDER BY customer_id, product_category""",
            DEFAULT_TENANT,
        )
    return {"capabilities": [_capability_row(r) for r in rows]}


@app.post("/api/v1/capabilities")
async def upsert_capability_api(body: dict, request: Request, user: dict = Depends(_get_current_user)):
    """客户能力登记/更新（按 租户+客户+品类 幂等 upsert，同 capabilities_repo）。"""
    customer_id = (body.get("customer_id") or "").strip()
    customer_name = (body.get("customer_name") or "").strip()
    product_category = (body.get("product_category") or "").strip()
    if not customer_id or not product_category:
        raise HTTPException(status_code=422, detail="customer_id and product_category are required")
    spec_constraints = body.get("spec_constraints") or {}
    notes = body.get("notes")
    effective_from = body.get("effective_from")
    existing = await db.fetchrow(
        request,
        """SELECT id FROM customer_capabilities
            WHERE tenant_id = $1 AND customer_id = $2 AND product_category = $3""",
        DEFAULT_TENANT, customer_id, product_category,
    )
    if existing is not None:
        row = await db.fetchrow(
            request,
            """UPDATE customer_capabilities
                  SET customer_name = $1, spec_constraints = $2, notes = $3,
                      effective_from = COALESCE($4, effective_from), updated_at = now()
                WHERE id = $5 RETURNING id""",
            customer_name or None, _json.dumps(spec_constraints), notes, effective_from,
            existing["id"],
        )
    else:
        row = await db.fetchrow(
            request,
            """INSERT INTO customer_capabilities
                   (tenant_id, customer_id, customer_name, product_category,
                    spec_constraints, notes, effective_from, schema_version)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, 1) RETURNING id""",
            DEFAULT_TENANT, customer_id, customer_name or None, product_category,
            _json.dumps(spec_constraints), notes, effective_from,
        )
    return {"id": row["id"]}


@app.get("/api/v1/customer/{customer_id}/capabilities")
async def get_customer_capabilities(
    customer_id: str, request: Request, user: dict = Depends(_get_current_user)
):
    rows = await db.fetch(
        request,
        """SELECT * FROM customer_capabilities
            WHERE tenant_id = $1 AND customer_id = $2 ORDER BY product_category""",
        DEFAULT_TENANT, customer_id,
    )
    items = []
    for r in rows:
        d = _capability_row(r)
        d["is_active"] = True
        items.append(d)
    return items


@app.patch("/api/v1/customer/{customer_id}/capabilities")
async def patch_customer_capability(
    customer_id: str, body: dict, request: Request, user: dict = Depends(_get_current_user)
):
    """更新单条能力（body {id, spec_constraints, is_active}；is_active 无存储列，见 CLEANUP_LOG）。"""
    cap_id = body.get("id")
    if not isinstance(cap_id, int):
        raise HTTPException(status_code=422, detail="id is required")
    row = await db.fetchrow(
        request,
        """UPDATE customer_capabilities
              SET spec_constraints = $1, updated_at = now()
            WHERE id = $2 AND tenant_id = $3 AND customer_id = $4
            RETURNING id""",
        _json.dumps(body.get("spec_constraints") or {}),
        cap_id, DEFAULT_TENANT, customer_id,
    )
    if row is None:
        return {"error": "not_found"}
    return {"id": row["id"], "is_active": body.get("is_active", True)}


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
# ── 阶段 6 · 订单工位（线上 /api/v1/orders*，对齐 orchestrator orders.py §10）──
# 线上简化（详见 docs/UNCERTAIN.md #16）：
# - 单租户 DEFAULT_TENANT；订单归属隔离已同步（owner_id/owner_scope，与 dev ws_common 对齐）
# - 汇率锁定 fx_rates（缺汇率后补，与 dev ws_common.lock_fx_rate 对齐）
# - 报价转化只记录来源与业务事件，不复制报价行项（quotations 结构确认后补）

# 必须覆盖全部单证类型（与 orchestrator/app/api/ws_common.py 一致）：
# 漏登记会用前三位大写兜底，产生 SA/NON/WEI 这类无业务含义的编号。
DOC_TYPE_PREFIX = {
    # 出口商自制
    "quotation": "QUO", "pi": "PI", "contract": "CON", "ci": "CI", "pl": "PL",
    "shipping_advice": "SA", "draft": "DR", "beneficiary_cert": "BEN",
    "non_wood_packing": "NWP", "weight_list": "WL", "quality_cert": "QC",
    "manufacturer_cert": "MC",
    # 第三方签发
    "bl": "BL", "co": "CO", "insurance": "INS",
    "customs_declaration": "CD", "fumigation_cert": "FUM",
    # 通用与其它单据
    "other": "DOC", "order": "ORD", "shipment": "SHP",
}


async def _next_doc_no(request, doc_type: str) -> str:
    """段号取单号（同步 orchestrator ws_common.next_doc_no）：月度分段、四位流水。"""
    period = datetime.now(timezone.utc).strftime("%Y%m")
    await db.execute(
        request,
        "INSERT INTO doc_sequences (tenant_id, doc_type, period, last_seq) VALUES ($1,$2,$3,0)"
        " ON CONFLICT DO NOTHING",
        DEFAULT_TENANT, doc_type, period,
    )
    seq = await db.fetchval(
        request,
        "UPDATE doc_sequences SET last_seq = last_seq + 1"
        " WHERE tenant_id=$1 AND doc_type=$2 AND period=$3 RETURNING last_seq",
        DEFAULT_TENANT, doc_type, period,
    )
    prefix = DOC_TYPE_PREFIX.get(doc_type, doc_type.upper()[:3])
    return f"{prefix}-{period}-{seq:04d}"


ORDER_NEXT = {
    "pending": ("confirmed", "cancelled"),
    "confirmed": ("producing", "cancelled"),
    "producing": ("shipped",),
    "shipped": ("completed",),
}


def _order_dict(row) -> dict:
    d = dict(row)
    for k in ("order_date", "delivery_date", "fx_rate_date", "created_at"):
        v = d.get(k)
        if v is not None and hasattr(v, "isoformat"):
            d[k] = v.isoformat()
    return d


async def _record_business_event(
    request, event_type: str, payload: dict, from_ws: str = None, to_ws: str = None
):
    """跨工位业务事件流水（阶段 6 · business_events）。"""
    await db.execute(
        request,
        """INSERT INTO business_events
               (tenant_id, event_type, from_workstation, to_workstation, payload, actor_id)
           VALUES ($1, $2, $3, $4, $5, $6)""",
        DEFAULT_TENANT, event_type, from_ws, to_ws,
        _json.dumps(payload), payload.get("actor_id"),
    )


def _can_see_all(user: dict) -> bool:
    """管理员可见全部（与 dev ws_common.can_see_all 对齐）。"""
    return str(user.get("role") or "") == "system_admin"


def _owner_visible(user: dict, row) -> bool:
    """归属范围：非管理员只见自己名下或租户共享数据（与 dev ws_common.scope_filter 对齐）。"""
    if _can_see_all(user):
        return True
    d = dict(row)
    if d.get("owner_id") is not None and str(d["owner_id"]) == str(user["id"]):
        return True
    return d.get("owner_scope") == "tenant"


def _check_write_access(user: dict, row):
    """写权限：非管理员只能改自己名下的数据（与 dev ws_common.check_write_access 对齐）。"""
    if not _can_see_all(user):
        d = dict(row)
        if d.get("owner_id") is not None and str(d["owner_id"]) != str(user["id"]):
            raise HTTPException(status_code=403, detail={
                "error": "forbidden", "code": "NOT_OWNER",
                "detail": "只能修改自己账号的数据",
            })


@app.get("/api/v1/orders")
async def list_orders_api(
    request: Request,
    page: int = 1,
    page_size: int = 20,
    status: str = "",
    q: str = "",
    user: dict = Depends(_get_current_user),
):
    where, params = ["tenant_id = $1"], [DEFAULT_TENANT]
    if status:
        params.append(status)
        where.append(f"status = ${len(params)}")
    if q:
        params.append(f"%{q}%")
        where.append(
            f"(customer_name ILIKE ${len(params)} OR order_no ILIKE ${len(params)})"
        )
    if not _can_see_all(user):
        params.append(str(user["id"]))
        where.append(f"(owner_id = ${len(params)} OR owner_scope = 'tenant')")
    cond = " AND ".join(where)
    total = await db.fetchval(
        request, f"SELECT count(*) FROM orders WHERE {cond}", *params
    )
    rows = await db.fetch(
        request,
        f"SELECT * FROM orders WHERE {cond} ORDER BY created_at DESC, id DESC LIMIT $%d OFFSET $%d"
        % (len(params) + 1, len(params) + 2),
        *params,
        max(1, min(page_size, 200)),
        (max(1, page) - 1) * max(1, min(page_size, 200)),
        table="orders",
    )
    return {
        "items": [_order_dict(r) for r in rows],
        "total": total,
        "page": page,
        "page_size": page_size,
    }


@app.post("/api/v1/orders", status_code=201)
async def create_order_api(
    request: Request, body: dict, user: dict = Depends(_get_current_user)
):
    items = body.get("items") or []
    currency = (body.get("currency") or "USD").upper()
    order_no = await _next_doc_no(request, "order")
    total = 0.0
    computed_lines = []
    for it in items:
        line = it.get("line_amount")
        if line is None and it.get("unit_price") is not None:
            qty = float(it.get("qty") if it.get("qty") is not None else 1)
            line = round(qty * float(it["unit_price"]), 2)
        if line is not None:
            total += float(line)
        computed_lines.append(line)

    row = await db.fetchrow(
        request,
        """INSERT INTO orders
               (tenant_id, order_no, customer_id, customer_name, status, currency,
                total_amount, order_date, delivery_date, notes,
                created_by, owner_id, owner_scope)
           VALUES ($1,$2,$3,$4,'pending',$5,$6,$7,$8,$9,$10,$10,$11)
           RETURNING *""",
        DEFAULT_TENANT, order_no, body.get("customer_id"), body.get("customer_name"),
        currency, total or None, parse_date(body.get("order_date")),
        parse_date(body.get("delivery_date")), body.get("notes"),
        str(user["id"]), body.get("owner_scope") or "private",
    )
    order_id = row["id"]
    for idx, it in enumerate(items):
        await db.execute(
            request,
            """INSERT INTO order_items
                   (tenant_id, order_id, sku_id, product_name, spec_snapshot, qty, qty_unit,
                    unit_price, currency, line_amount, sort_order)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)""",
            DEFAULT_TENANT, order_id, it.get("sku_id"), it.get("product_name"),
            _json.dumps(it["spec_snapshot"]) if it.get("spec_snapshot") is not None else None,
            it.get("qty") if it.get("qty") is not None else 1, it.get("qty_unit"),
            it.get("unit_price"), (it.get("currency") or currency),
            computed_lines[idx], it.get("sort_order") or idx,
        )
    quotation_id = body.get("quotation_id")
    if quotation_id is not None:
        await _record_business_event(
            request,
            "quotation.converted",
            {
                "quotation_id": str(quotation_id),
                "order_id": str(order_id),
                "customer_id": body.get("customer_id") or "",
                "actor_id": str(user["id"]),
            },
            from_ws="quotation",
            to_ws="order",
        )
    return _order_dict(row)


@app.get("/api/v1/orders/{order_id}")
async def get_order_api(
    request: Request, order_id: int, user: dict = Depends(_get_current_user)
):
    row = await db.fetchrow(
        request,
        "SELECT * FROM orders WHERE tenant_id = $1 AND id = $2",
        DEFAULT_TENANT, order_id, table="orders",
    )
    if row is None:
        raise HTTPException(status_code=404, detail="ORDER_NOT_FOUND")
    if not _owner_visible(user, row):
        raise HTTPException(status_code=404, detail="ORDER_NOT_FOUND")
    items = await db.fetch(
        request,
        """SELECT * FROM order_items WHERE tenant_id = $1 AND order_id = $2
           ORDER BY sort_order, id""",
        DEFAULT_TENANT, order_id, table="order_items",
    )
    return {
        **_order_dict(row),
        "items": [row_to_dict(r, "order_items") for r in items],
    }


@app.patch("/api/v1/orders/{order_id}")
async def update_order_api(
    request: Request, order_id: int, body: dict, user: dict = Depends(_get_current_user)
):
    row = await db.fetchrow(
        request,
        "SELECT * FROM orders WHERE tenant_id = $1 AND id = $2",
        DEFAULT_TENANT, order_id, table="orders",
    )
    if row is None:
        raise HTTPException(status_code=404, detail="ORDER_NOT_FOUND")
    if not _owner_visible(user, row):
        raise HTTPException(status_code=404, detail="ORDER_NOT_FOUND")
    _check_write_access(user, row)
    updated = await db.fetchrow(
        request,
        """UPDATE orders SET
               customer_name = COALESCE($3, customer_name),
               delivery_date = COALESCE($4, delivery_date),
               notes = COALESCE($5, notes)
           WHERE tenant_id = $1 AND id = $2 RETURNING *""",
        DEFAULT_TENANT, order_id, body.get("customer_name"),
        parse_date(body.get("delivery_date")), body.get("notes"),
        table="orders",
    )
    return _order_dict(updated)


# ── 阶段 6 任务2：订单状态机 + 确认建应收 + order.shipped 跨工位事件 ──────

async def _lock_fx_rate(request: Request, currency: str):
    """锁定汇率（与 dev ws_common 对齐）：fx_rates 取 ≤今天的最近一条；
    同币种=1.0；缺记录返回 (None, None)=汇率后补，单据照建。fx_rates 全局表无租户过滤。"""
    from datetime import date as _date
    from decimal import Decimal
    cur = (currency or "USD").upper()
    if cur == "CNY":
        return Decimal("1"), _date.today()
    row = await db.fetchrow(
        request,
        "SELECT rate, rate_date FROM fx_rates"
        " WHERE base_currency=$1 AND quote_currency='CNY' AND rate_date<=CURRENT_DATE"
        " ORDER BY rate_date DESC LIMIT 1",
        cur, table="fx_rates",
    )
    if not row or row["rate"] is None:
        return None, None
    return row["rate"], row["rate_date"]


async def _create_receivable_for_order(request: Request, o: dict):
    """确认时建应收台账（幂等：tenant+order 唯一，§10.2）。
    汇率用订单锁定值（fx_rates 取得；缺汇率则 base_amount 空=汇率后补）。"""
    existing = await db.fetchrow(
        request,
        "SELECT id FROM receivables WHERE tenant_id=$1 AND order_id=$2",
        DEFAULT_TENANT, o["id"],
    )
    if existing:
        return
    total = o["total_amount"] or 0
    rate = o.get("fx_rate")
    base = None
    if rate is not None:
        from decimal import Decimal, ROUND_HALF_UP
        base = (Decimal(str(total)) * Decimal(str(rate))).quantize(
            Decimal("0.01"), rounding=ROUND_HALF_UP)
    await db.execute(
        request,
        "INSERT INTO receivables (tenant_id, order_id, currency, total_amount,"
        " fx_rate, fx_rate_date, base_currency, base_amount, received_amount,"
        " status, owner_id, owner_scope) VALUES ($1,$2,$3,$4,$5,$6,'CNY',$7,0,'unpaid',$8,$9)",
        DEFAULT_TENANT, o["id"], o.get("currency") or "USD", total,
        float(rate) if rate is not None else None, o.get("fx_rate_date"), base,
        o.get("owner_id"), o.get("owner_scope") or "private",
        table="receivables",
    )


@app.post("/api/v1/orders/{order_id}/status")
async def change_order_status(order_id: int, request: Request, body: dict,
                              user: dict = Depends(_get_current_user)):
    """订单状态流转（§10.4 状态机）。确认时建应收；发货时发 order.shipped 跨工位事件。"""
    row = await db.fetchrow(
        request,
        "SELECT * FROM orders WHERE tenant_id=$1 AND id=$2",
        DEFAULT_TENANT, order_id,
        table="orders",
    )
    if not row:
        raise HTTPException(status_code=404, detail={"error": "order_not_found"})
    if not _owner_visible(user, row):
        raise HTTPException(status_code=404, detail={"error": "order_not_found"})
    _check_write_access(user, row)
    o = _order_dict(row)
    target = (body.get("status") or "").strip()
    allowed = ORDER_NEXT.get(o["status"], ())
    if target != o["status"] and target not in allowed:
        raise HTTPException(status_code=409, detail={
            "error": "conflict", "code": "ILLEGAL_TRANSITION",
            "field": "status", "from": o["status"], "to": target,
            "allowed": list(allowed),
        })

    now = datetime.now(timezone.utc)
    await db.execute(
        request,
        "UPDATE orders SET status=$3, updated_at=$4 WHERE tenant_id=$1 AND id=$2",
        DEFAULT_TENANT, order_id, target, now, table="orders",
    )
    if target == "confirmed" and o["status"] == "pending":
        rate, rate_date = await _lock_fx_rate(request, o.get("currency") or "USD")
        await db.execute(
            request,
            "UPDATE orders SET fx_rate=$3, fx_rate_date=$4 WHERE tenant_id=$1 AND id=$2",
            DEFAULT_TENANT, order_id,
            float(rate) if rate is not None else None, rate_date, table="orders",
        )
        o["fx_rate"] = rate
        o["fx_rate_date"] = rate_date
        await _create_receivable_for_order(request, o)
    if target == "shipped":
        await _record_business_event(
            request, "order.shipped",
            {"order_id": order_id, "shipment_ref": (body.get("shipment_ref") or ""),
             "actor_id": user["id"]},
            from_ws="orders", to_ws="trade_docs",
        )

    row2 = await db.fetchrow(
        request,
        "SELECT * FROM orders WHERE tenant_id=$1 AND id=$2",
        DEFAULT_TENANT, order_id,
        table="orders",
    )
    return _order_dict(row2)


# ── 阶段 6 任务2：付款计划 + 标记收款（汇兑损益）+ 应收台账 ─────────────

def _schedule_dict(row) -> dict:
    from decimal import Decimal as _D
    d = dict(row)
    for k in ("due_date", "actual_date", "created_at", "updated_at"):
        v = d.get(k)
        d[k] = v.isoformat() if v is not None and hasattr(v, "isoformat") else v
    for k in ("ratio", "amount", "fx_rate", "exchange_gain_loss"):
        if isinstance(d.get(k), _D):
            d[k] = float(d[k])
    return d


@app.get("/api/v1/orders/{order_id}/payment-schedules")
async def list_schedules(order_id: int, request: Request,
                         user: dict = Depends(_get_current_user)):
    o = await db.fetchrow(request, "SELECT * FROM orders WHERE tenant_id=$1 AND id=$2",
                          DEFAULT_TENANT, order_id, table="orders")
    if not o:
        raise HTTPException(status_code=404, detail={"error": "order_not_found"})
    if not _owner_visible(user, o):
        raise HTTPException(status_code=404, detail={"error": "order_not_found"})
    rows = await db.fetch(
        request,
        "SELECT * FROM payment_schedules WHERE tenant_id=$1 AND order_id=$2"
        " ORDER BY due_date NULLS LAST, id",
        DEFAULT_TENANT, order_id, table="payment_schedules",
    )
    return {"items": [_schedule_dict(r) for r in rows], "total": len(rows)}


@app.post("/api/v1/orders/{order_id}/payment-schedules", status_code=201)
async def create_schedule(order_id: int, request: Request, body: dict,
                          user: dict = Depends(_get_current_user)):
    from decimal import Decimal, ROUND_HALF_UP
    row = await db.fetchrow(request, "SELECT * FROM orders WHERE tenant_id=$1 AND id=$2",
                            DEFAULT_TENANT, order_id, table="orders")
    if not row:
        raise HTTPException(status_code=404, detail={"error": "order_not_found"})
    if not _owner_visible(user, row):
        raise HTTPException(status_code=404, detail={"error": "order_not_found"})
    _check_write_access(user, row)
    o = _order_dict(row)
    stype = (body.get("schedule_type") or "full").strip()
    if stype not in ("deposit", "balance", "full"):
        raise HTTPException(status_code=422, detail={"error": "bad_schedule_type"})
    ratio = body.get("ratio")
    amount = body.get("amount")
    if (ratio is None) == (amount is None):
        raise HTTPException(status_code=422,
                            detail={"error": "ratio_xor_amount_required"})
    if ratio is not None:
        amount = (Decimal(str(o["total_amount"] or 0)) * Decimal(str(ratio))) \
            .quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    row2 = await db.fetchrow(
        request,
        "INSERT INTO payment_schedules (tenant_id, order_id, schedule_type, ratio,"
        " amount, currency, due_date, notes, status, owner_id, owner_scope)"
        " VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9,$10) RETURNING *",
        DEFAULT_TENANT, order_id, stype, ratio, amount,
        o.get("currency") or "USD", parse_date(body.get("due_date")),
        body.get("notes") or None, str(user["id"]), o.get("owner_scope") or "private",
        table="payment_schedules",
    )
    return _schedule_dict(row2)


@app.patch("/api/v1/payment-schedules/{schedule_id}")
async def update_schedule(schedule_id: int, request: Request, body: dict,
                          user: dict = Depends(_get_current_user)):
    from decimal import Decimal, ROUND_HALF_UP
    s = await db.fetchrow(request, "SELECT * FROM payment_schedules WHERE tenant_id=$1 AND id=$2",
                          DEFAULT_TENANT, schedule_id, table="payment_schedules")
    if not s:
        raise HTTPException(status_code=404, detail={"error": "schedule_not_found"})
    o_row = await db.fetchrow(
        request, "SELECT owner_id, owner_scope FROM orders WHERE tenant_id=$1 AND id=$2",
        DEFAULT_TENANT, s["order_id"], table="orders",
    )
    if o_row is not None and not _owner_visible(user, o_row):
        raise HTTPException(status_code=404, detail={"error": "schedule_not_found"})
    if o_row is not None:
        _check_write_access(user, dict(o_row))
    s = _schedule_dict(s)
    new_status = (body.get("status") or s["status"]).strip()
    if s["status"] == "paid" and new_status != "paid":
        raise HTTPException(status_code=409, detail={
            "error": "conflict", "code": "ILLEGAL_TRANSITION",
            "field": "status", "from": "paid", "to": new_status,
        })
    now = datetime.now(timezone.utc)
    if new_status == "paid" and s["status"] != "paid":
        # 标记收款：按实际汇率与锁定汇率差记汇兑损益（缺汇率则后补，不记损益）
        from decimal import Decimal, ROUND_HALF_UP
        actual_rate = Decimal(str(body["fx_rate"])) if body.get("fx_rate") is not None else None
        recv = await db.fetchrow(
            request, "SELECT fx_rate FROM receivables WHERE tenant_id=$1 AND order_id=$2",
            DEFAULT_TENANT, s["order_id"], table="receivables",
        )
        o_row = await db.fetchrow(
            request, "SELECT fx_rate FROM orders WHERE tenant_id=$1 AND id=$2",
            DEFAULT_TENANT, s["order_id"], table="orders",
        )
        lock_raw = (recv["fx_rate"] if recv and recv["fx_rate"] is not None else None)
        if lock_raw is None and o_row:
            lock_raw = o_row["fx_rate"]
        amt = Decimal(str(s["amount"] or 0))
        gl = None
        if actual_rate is not None and lock_raw is not None:
            lock_rate = Decimal(str(lock_raw))
            gl = (amt * (actual_rate - lock_rate)).quantize(Decimal("0.01"),
                                                          rounding=ROUND_HALF_UP)
        actual_date = parse_date(body.get("actual_date")) or now.date()
        await db.execute(
            request,
            "UPDATE payment_schedules SET status='paid', actual_date=$3, fx_rate=$4,"
            " exchange_gain_loss=$5, updated_at=$6 WHERE tenant_id=$1 AND id=$2",
            DEFAULT_TENANT, schedule_id, actual_date,
            float(actual_rate) if actual_rate is not None else None, gl, now,
            table="payment_schedules",
        )
        await db.execute(
            request,
            "UPDATE receivables SET received_amount=received_amount+$3,"
            " exchange_gain_loss=COALESCE(exchange_gain_loss,0)+$4,"
            " status=CASE WHEN received_amount+$3>=total_amount THEN 'paid'"
            " ELSE 'partial' END, updated_at=$5 WHERE tenant_id=$1 AND order_id=$2",
            DEFAULT_TENANT, s["order_id"], amt,
            gl if gl is not None else Decimal("0"), now, table="receivables",
        )
    else:
        await db.execute(
            request,
            "UPDATE payment_schedules SET due_date=COALESCE($3, due_date),"
            " notes=COALESCE($4, notes), updated_at=$5 WHERE tenant_id=$1 AND id=$2",
            DEFAULT_TENANT, schedule_id, parse_date(body.get("due_date")),
            body.get("notes"), now, table="payment_schedules",
        )
    s2 = await db.fetchrow(request, "SELECT * FROM payment_schedules WHERE tenant_id=$1 AND id=$2",
                           DEFAULT_TENANT, schedule_id, table="payment_schedules")
    return _schedule_dict(s2)


@app.get("/api/v1/receivables")
async def list_receivables(request: Request, status: str = None, page: int = 1,
                           page_size: int = 20, user: dict = Depends(_get_current_user)):
    cond = ""
    params = [DEFAULT_TENANT]
    if status:
        status = status.strip()
        if status not in ("unpaid", "partial", "paid"):
            raise HTTPException(status_code=422, detail={"error": "bad_receivable_status"})
        cond = " AND r.status=$2"
        params.append(status)
    rows = await db.fetch(
        request,
        "SELECT r.*, o.order_no, o.customer_name FROM receivables r"
        " LEFT JOIN orders o ON o.id=r.order_id AND o.tenant_id=r.tenant_id"
        f" WHERE r.tenant_id=$1{cond} ORDER BY r.id DESC"
        f" LIMIT ${len(params) + 1} OFFSET ${len(params) + 2}",
        *params, page_size, (page - 1) * page_size, table="receivables",
    )
    total = await db.fetchval(
        request,
        f"SELECT count(*) FROM receivables r WHERE r.tenant_id=$1{cond}",
        *params,
    )
    items = []
    for r in rows:
        d = _schedule_dict(r)
        items.append(d)
    return {"items": items, "total": total, "page": page, "page_size": page_size}


# ── 阶段 6 任务2：外贸票据工位 + shipment.documented 事件 ──────────────────

# 18 类单证（与前端模板清单及 dev domain/enums.DOC_TYPE 三方一致，
# 由 scripts/contracts-check.ts 的 R3 规则校验）
DOC_TYPE_SET = (
    # 出口商自制
    "quotation", "pi", "contract", "ci", "pl",
    "shipping_advice", "draft", "beneficiary_cert", "non_wood_packing",
    "weight_list", "quality_cert", "manufacturer_cert",
    # 第三方签发
    "bl", "co", "insurance", "customs_declaration", "fumigation_cert",
    # 通用
    "other",
)
DOC_NEXT = {"draft": ("issued", "void"), "issued": ("void",)}

# ── 单证渲染数据装配（镜像 backend/orchestrator/app/services/trade_doc_payload.py）──
# Worker 是刻意精简的单文件实现（不引入额外依赖），无法 import orchestrator 的模块，
# 所以这里是**镜像实现**。最容易漂移的是「单证类型 → 本单编号字段名」映射 ——
# 猜错就会把合同号印成发票号，因此由 scripts/contracts-check.ts 的 R4 规则逐项比对两侧。
TRADE_TERM_FIELDS = ("incoterm", "payment_terms", "port_of_loading",
                     "port_of_destination", "shipping_marks", "country_of_origin")

# 模板里占位符名字按单证惯例定（发票 $invoice_no、装箱单 $pl_no…），不能用启发式规则去猜：
# 商业发票同时有 contract_no / lc_no，猜错就印错单号。
DOC_NO_FIELDS = {
    "quotation": ("quote_no", "quote_date"),
    "pi": ("pi_no", "pi_date"),
    "contract": ("contract_no", "contract_date"),
    "ci": ("invoice_no", "invoice_date"),
    "pl": ("pl_no", "pl_date"),
    "shipping_advice": ("advice_no", "advice_date"),
    "draft": ("draft_no", "draft_date"),
    "beneficiary_cert": ("cert_no", "cert_date"),
    "non_wood_packing": ("declaration_no", "declaration_date"),
    "weight_list": ("weight_list_no", "weight_list_date"),
    "quality_cert": ("quality_cert_no", "quality_cert_date"),
    "manufacturer_cert": ("mfr_cert_no", "mfr_cert_date"),
    "bl": ("bl_no", None),
    "co": ("co_no", None),
    "insurance": ("policy_no", None),
    "customs_declaration": ("customs_decl_no", "customs_decl_date"),
    "fumigation_cert": ("fumi_cert_no", "fumi_cert_date"),
    "other": (None, None),
}

# 行项里可由规格快照带出的申报要素（报关/装箱必需）
_SPEC_FIELDS = ("specification", "hs_code", "package", "gross_weight", "net_weight", "volume")


def _clean(value):
    """空串视为「未填写」，避免覆盖上游值。"""
    if value is None:
        return None
    if isinstance(value, str) and not value.strip():
        return None
    return value


def _spec_to_text(spec):
    """规格快照（JSONB）→ 单据上的一行规格描述。"""
    if not spec:
        return None
    if isinstance(spec, str):
        return spec.strip() or None
    if not isinstance(spec, dict):
        return None
    parts = []
    for key in ("specification", "spec", "size", "mesh", "wire_diameter", "height", "length"):
        value = _clean(spec.get(key))
        if value is not None:
            parts.append(str(value))
    if parts:
        return ", ".join(parts)
    fallback = [f"{k}: {v}" for k, v in spec.items() if _clean(v) is not None]
    return ", ".join(fallback) or None


def _item_from_source(raw: dict) -> dict:
    """上游行项 → 渲染行项（规格/HS Code/毛净重摊平到行项上）。"""
    spec = raw.get("spec_snapshot") if isinstance(raw, dict) else None
    item = {
        "product_name": raw.get("product_name"),
        "qty": raw.get("qty"),
        "qty_unit": raw.get("qty_unit"),
        "unit_price": raw.get("unit_price"),
        "line_amount": raw.get("line_amount"),
        "specification": _spec_to_text(spec),
    }
    if isinstance(spec, dict):
        for field in _SPEC_FIELDS:
            if field == "specification":
                continue
            value = _clean(spec.get(field))
            if value is not None:
                item[field] = value
    for field in _SPEC_FIELDS:
        value = _clean(raw.get(field))
        if value is not None:
            item[field] = value
    return {k: v for k, v in item.items() if v is not None}


def _buyer_block(customer, contact) -> dict:
    """客户档案 + 主联系人 → 单证买方区块。

    Consignee 只有公司名是清关大忌：目的国海关要求收货人名称与地址齐全。
    """
    block = {}
    if customer is not None:
        c = dict(customer)
        block["company"] = c.get("name")
        block["address"] = c.get("address")
    if contact is not None:
        ct = dict(contact)
        block["contact"] = ct.get("name")
        block["phone"] = ct.get("phone")
        block["email"] = ct.get("email")
    return {k: v for k, v in block.items() if _clean(v) is not None}


def _build_render_data(*, doc_type, doc_no, currency, total_amount, created_at, issued_at,
                       seller, buyer, bank_info, sources, trade_terms, custom, defaults) -> dict:
    """装配渲染数据。字段优先级（后者覆盖前者）：
    公司默认条款 → 上游条款与货物 → 买卖双方主体 → 单据自身编号/日期/金额 → 手工填写。

    手工填写放最后：业务员在单据上改过的内容不能被自动带入悄悄覆盖。
    """
    data = {}
    # ① 公司级默认条款（省去每张单据重填）
    for key, value in (defaults or {}).items():
        if _clean(value) is not None:
            data[key] = value

    # ② 上游快照：货物与条款
    sources = sources or {}
    upstream = sources.get("order") or sources.get("quote") or {}
    items = [_item_from_source(i) for i in (upstream.get("items") or [])]
    if items:
        data["items"] = items
    if _clean(upstream.get("currency")) is not None:
        data["currency"] = upstream["currency"]
    for key, value in (trade_terms or {}).items():
        data[key] = value

    # ③ 交易双方（企业主体 / 客户档案）
    if seller:
        data["seller"] = seller
        # 卖方同时是托运人/出口商（各单证叫法不同，指向同一主体）
        data["shipper"] = seller
        data["exporter"] = seller
    if buyer:
        data["buyer"] = buyer
        data["consignee"] = buyer
        data["insured"] = buyer
    if bank_info:
        data["bank_info"] = bank_info

    # ④ 单据自身（编号 / 日期 / 金额）
    no_field, date_field = DOC_NO_FIELDS.get(doc_type, (None, None))
    if no_field:
        data[no_field] = doc_no
    if date_field:
        data[date_field] = issued_at or created_at
    data["currency"] = data.get("currency") or currency
    if _clean(total_amount) is not None:
        data["total_amount"] = total_amount

    # ⑤ 手工填写覆盖最后应用
    for key, value in (custom or {}).items():
        data[key] = value
    return data


def _seller_block(profile) -> dict:
    """企业主体信息 → 单证卖方区块（渲染器认 company/address/phone/email/bank/account/swift）。"""
    if not profile:
        return {}
    p = dict(profile)
    return {k: v for k, v in {
        "company": p.get("name_en"),
        "address": p.get("address_en"),
        "phone": p.get("phone"),
        "email": p.get("email"),
        "bank": p.get("bank_name"),
        "account": p.get("bank_account"),
        "swift": p.get("swift_code"),
    }.items() if v}



def _doc_dict(row) -> dict:
    from decimal import Decimal as _D
    d = dict(row)
    for k in ("issued_at", "created_at", "updated_at"):
        v = d.get(k)
        d[k] = v.isoformat() if v is not None and hasattr(v, "isoformat") else v
    if isinstance(d.get("total_amount"), _D):
        d["total_amount"] = float(d["total_amount"])
    return d


@app.get("/api/v1/trade-docs")
async def list_trade_docs(request: Request, doc_type: str = None, status: str = None,
                          order_id: int = None, page: int = 1, page_size: int = 20,
                          user: dict = Depends(_get_current_user)):
    cond = ""
    params = [DEFAULT_TENANT]
    if doc_type:
        if doc_type not in DOC_TYPE_SET:
            raise HTTPException(status_code=422, detail={"error": "bad_doc_type"})
        params.append(doc_type)
        cond += f" AND doc_type=${len(params)}"
    if status:
        if status not in DOC_NEXT:
            raise HTTPException(status_code=422, detail={"error": "bad_doc_status"})
        params.append(status)
        cond += f" AND status=${len(params)}"
    if order_id:
        params.append(order_id)
        cond += f" AND order_id=${len(params)}"
    rows = await db.fetch(
        request,
        f"SELECT * FROM trade_docs WHERE tenant_id=$1{cond} ORDER BY created_at DESC"
        f" LIMIT ${len(params) + 1} OFFSET ${len(params) + 2}",
        *params, page_size, (page - 1) * page_size, table="trade_docs",
    )
    total = await db.fetchval(
        request, f"SELECT count(*) FROM trade_docs WHERE tenant_id=$1{cond}", *params,
    )
    return {"items": [_doc_dict(r) for r in rows], "total": total,
            "page": page, "page_size": page_size}


def _snap_rows(rows):
    """快照行 Decimal→float（JSON 序列化安全）。"""
    from decimal import Decimal
    return [{k: (float(v) if isinstance(v, Decimal) else v) for k, v in dict(r).items()}
            for r in rows]


async def _order_snapshot(request: Request, order_id: int) -> dict:
    """订单冻结快照（表头+行项，与 dev trade_docs._order_snapshot 对齐）。

    贸易条款与规格快照必须一起冻进来：单证上的条款要等于开单当时的条款，
    而不是「现在去订单表读」——订单改了不能污染已开出的单据。
    """
    o = await db.fetchrow(request, "SELECT * FROM orders WHERE tenant_id=$1 AND id=$2",
                          DEFAULT_TENANT, order_id, table="orders")
    if not o:
        raise HTTPException(status_code=404, detail={"error": "not_found", "code": "ORDER_NOT_FOUND"})
    o = _order_dict(o)
    items = await db.fetch(
        request,
        "SELECT product_name, qty, qty_unit, unit_price, line_amount, spec_snapshot"
        " FROM order_items"
        " WHERE tenant_id=$1 AND order_id=$2 ORDER BY sort_order, id",
        DEFAULT_TENANT, order_id, table="order_items",
    )
    snap = {
        "order_id": o["id"], "order_no": o["order_no"],
        "customer_id": o["customer_id"], "customer_name": o["customer_name"],
        "status": o["status"], "currency": o["currency"],
        "total_amount": o["total_amount"], "fx_rate": o["fx_rate"],
        "items": _snap_rows(items),
    }
    for field in TRADE_TERM_FIELDS:
        snap[field] = o.get(field)
    return snap


async def _quote_snapshot(request: Request, quote_order_id: int) -> dict:
    """报价冻结快照（quote_orders 表头+行项，与 dev 对齐）。"""
    q = await db.fetchrow(
        request, "SELECT * FROM quote_orders WHERE tenant_id=$1 AND id=$2",
        DEFAULT_TENANT, quote_order_id, table="quote_orders")
    if not q:
        raise HTTPException(status_code=404, detail={"error": "not_found", "code": "QUOTE_NOT_FOUND"})
    items = await db.fetch(
        request,
        "SELECT product_name, qty, qty_unit, unit_price, line_amount, spec_snapshot"
        " FROM quote_order_items"
        " WHERE tenant_id=$1 AND quote_order_id=$2 ORDER BY sort_order, id",
        DEFAULT_TENANT, quote_order_id, table="quote_order_items",
    )
    qd = _snap_rows([q])[0]
    snap = {
        "quote_order_id": quote_order_id,
        "quote_no": qd.get("quote_no"), "customer_id": qd.get("customer_id"),
        "customer_name": qd.get("customer_name"), "status": qd.get("status"),
        "currency": qd.get("currency"), "total_amount": qd.get("total_amount"),
        "items": _snap_rows(items),
    }
    for field in TRADE_TERM_FIELDS:
        snap[field] = qd.get(field)
    return snap


async def _inquiry_snapshot(request: Request, inquiry_id: int) -> dict:
    """询价冻结快照（cust_inquiries，与 dev 对齐）。"""
    r = await db.fetchrow(
        request, "SELECT * FROM cust_inquiries WHERE tenant_id=$1 AND id=$2",
        DEFAULT_TENANT, inquiry_id, table="cust_inquiries")
    if not r:
        raise HTTPException(status_code=404, detail={"error": "not_found", "code": "INQUIRY_NOT_FOUND"})
    rd = _snap_rows([r])[0]
    return {
        "inquiry_id": rd.get("id"), "customer_id": rd.get("customer_id"),
        "status": rd.get("status"), "channel": rd.get("channel"),
        "product_name_raw": rd.get("product_name_raw"), "quantity": rd.get("quantity"),
        "quantity_unit": rd.get("quantity_unit"), "application": rd.get("application"),
    }


@app.post("/api/v1/trade-docs", status_code=201)
async def create_trade_doc(request: Request, body: dict,
                           user: dict = Depends(_get_current_user)):
    """生成单证（上游快照入 raw_payload 冻结 + refs 溯源，与 dev trade_docs 对齐）。"""
    order_id = body.get("order_id")
    quote_order_id = body.get("quote_order_id")
    inquiry_id = body.get("inquiry_id")
    if not any([order_id, quote_order_id, inquiry_id]):
        raise HTTPException(status_code=422, detail={
            "error": "validation", "code": "SOURCE_REQUIRED",
            "detail": "单证需至少一个上游来源：order_id / quote_order_id / inquiry_id",
        })
    doc_type = (body.get("doc_type") or "").strip()
    if doc_type not in DOC_TYPE_SET:
        raise HTTPException(status_code=422, detail={"error": "bad_doc_type"})
    currency = (body.get("currency") or "USD").strip()

    payload = {"sources": {}, "custom": body.get("raw_payload") or {}}
    total_amount = None
    customer_id = body.get("customer_id")
    if order_id:
        payload["sources"]["order"] = await _order_snapshot(request, order_id)
        total_amount = payload["sources"]["order"]["total_amount"]
        if customer_id is None:
            customer_id = payload["sources"]["order"]["customer_id"]
    if quote_order_id:
        payload["sources"]["quote"] = await _quote_snapshot(request, quote_order_id)
        if total_amount is None:
            total_amount = payload["sources"]["quote"]["total_amount"]
        if customer_id is None:
            customer_id = payload["sources"]["quote"]["customer_id"]
    if inquiry_id:
        payload["sources"]["inquiry"] = await _inquiry_snapshot(request, inquiry_id)

    doc_no = await _next_doc_no(request, doc_type)
    d = await db.fetchrow(
        request,
        "INSERT INTO trade_docs (tenant_id, doc_no, doc_type, order_id, customer_id,"
        " status, currency, total_amount, raw_payload)"
        " VALUES ($1,$2,$3,$4,$5,'draft',$6,$7,$8) RETURNING *",
        DEFAULT_TENANT, doc_no, doc_type, order_id, customer_id, currency,
        total_amount, _json.dumps(payload), table="trade_docs",
    )
    for ref_table, ref_col, ref_id in (
        ("trade_doc_order_refs", "order_id", order_id),
        ("trade_doc_quote_refs", "quote_order_id", quote_order_id),
        ("trade_doc_inquiry_refs", "inquiry_id", inquiry_id),
    ):
        if ref_id:
            await db.execute(
                request,
                f"INSERT INTO {ref_table} (tenant_id, trade_doc_id, {ref_col}, ref_type)"
                " VALUES ($1,$2,$3,'generated_from')",
                DEFAULT_TENANT, d["id"], ref_id, table=ref_table,
            )
    await _record_business_event(
        request, "shipment.documented",
        {"doc_id": d["id"], "doc_no": doc_no, "doc_type": doc_type,
         "order_id": order_id, "actor_id": user["id"]},
        from_ws="trade_docs", to_ws="trade_docs",
    )
    return _doc_dict(d)


@app.get("/api/v1/trade-docs/{doc_id}")
async def get_trade_doc(doc_id: int, request: Request,
                        user: dict = Depends(_get_current_user)):
    d = await db.fetchrow(request, "SELECT * FROM trade_docs WHERE tenant_id=$1 AND id=$2",
                          DEFAULT_TENANT, doc_id, table="trade_docs")
    if not d:
        raise HTTPException(status_code=404, detail={"error": "not_found", "code": "DOC_NOT_FOUND"})
    refs = {"orders": [], "quotes": [], "inquiries": []}
    rows = await db.fetch(request,
                          "SELECT order_id, ref_type FROM trade_doc_order_refs"
                          " WHERE tenant_id=$1 AND trade_doc_id=$2", DEFAULT_TENANT, doc_id)
    refs["orders"] = [dict(r) for r in rows]
    rows = await db.fetch(request,
                          "SELECT quote_order_id, ref_type FROM trade_doc_quote_refs"
                          " WHERE tenant_id=$1 AND trade_doc_id=$2", DEFAULT_TENANT, doc_id)
    refs["quotes"] = [dict(r) for r in rows]
    rows = await db.fetch(request,
                          "SELECT inquiry_id, ref_type FROM trade_doc_inquiry_refs"
                          " WHERE tenant_id=$1 AND trade_doc_id=$2", DEFAULT_TENANT, doc_id)
    refs["inquiries"] = [dict(r) for r in rows]
    return {**_doc_dict(d), "refs": refs}


@app.patch("/api/v1/trade-docs/{doc_id}")
async def update_trade_doc(doc_id: int, request: Request, body: dict,
                           user: dict = Depends(_get_current_user)):
    d = await db.fetchrow(request, "SELECT * FROM trade_docs WHERE tenant_id=$1 AND id=$2",
                          DEFAULT_TENANT, doc_id, table="trade_docs")
    if not d:
        raise HTTPException(status_code=404, detail={"error": "not_found", "code": "DOC_NOT_FOUND"})
    d = _doc_dict(d)
    new_status = (body.get("status") or d["status"]).strip()
    allowed = DOC_NEXT.get(d["status"], ())
    if new_status != d["status"] and new_status not in allowed:
        raise HTTPException(status_code=409, detail={
            "error": "conflict", "code": "ILLEGAL_TRANSITION",
            "field": "status", "from": d["status"], "to": new_status,
            "allowed": list(allowed),
        })
    now = datetime.now(timezone.utc)
    raw_payload = body.get("raw_payload")
    if raw_payload is not None and d["status"] != "draft":
        raise HTTPException(status_code=409, detail={
            "error": "conflict", "code": "PAYLOAD_LOCKED",
            "detail": "issued 后单证内容锁定，不可修改",
        })
    if new_status == "issued" and d["status"] == "draft":
        await db.execute(
            request,
            "UPDATE trade_docs SET status=$3, issued_at=$4, issued_by=$5,"
            " raw_payload=COALESCE($6, raw_payload), updated_at=$7"
            " WHERE tenant_id=$1 AND id=$2",
            DEFAULT_TENANT, doc_id, new_status, now, user["id"],
            _json.dumps(raw_payload) if raw_payload is not None else None, now,
            table="trade_docs",
        )
    else:
        await db.execute(
            request,
            "UPDATE trade_docs SET status=$3, raw_payload=COALESCE($4, raw_payload),"
            " updated_at=$5 WHERE tenant_id=$1 AND id=$2",
            DEFAULT_TENANT, doc_id, new_status,
            _json.dumps(raw_payload) if raw_payload is not None else None, now,
            table="trade_docs",
        )
    d2 = await db.fetchrow(request, "SELECT * FROM trade_docs WHERE tenant_id=$1 AND id=$2",
                           DEFAULT_TENANT, doc_id, table="trade_docs")
    return _doc_dict(d2)


# ── 企业主体信息（卖方抬头）────────────────────────────────────────────────
# 为什么需要：对外单据第一行是卖方信头（英文公司名/地址/联系方式），
# PI/合同/汇票还要收款银行与 SWIFT。没有它，每张单据抬头都是空白、每次都要手填。
# 保存一次，所有单据自动带入。

_COMPANY_FIELDS = ("name_en", "name_zh", "address_en", "address_zh", "phone", "email",
                   "website", "bank_name", "bank_account", "swift_code", "logo_url",
                   "default_incoterm", "default_payment_terms", "default_country_of_origin")


@app.get("/api/v1/tenant/company-profile")
async def get_company_profile(request: Request, user: dict = Depends(_get_current_user)):
    row = await db.fetchrow(
        request, "SELECT * FROM tenant_company_profile WHERE tenant_id=$1",
        DEFAULT_TENANT, table="tenant_company_profile",
    )
    # 未配置时返回空结构而不是 404：前端表单可直接绑定，不会把页面变成错误页
    if not row:
        return {**{f: None for f in _COMPANY_FIELDS}, "configured": False}
    r = _snap_rows([row])[0]
    return {**{f: r.get(f) for f in _COMPANY_FIELDS}, "configured": bool(r.get("name_en"))}


@app.put("/api/v1/tenant/company-profile")
async def put_company_profile(request: Request, body: dict,
                              user: dict = Depends(_get_current_user)):
    name_en = (body.get("name_en") or "").strip()
    if not name_en:
        raise HTTPException(status_code=422, detail={
            "error": "validation", "code": "NAME_EN_REQUIRED",
            "detail": "英文公司名必填（对外单据的卖方主体名）",
        })
    # 逐字段覆盖（含 NULL）：允许把填错的字段清空，而不是"擦不掉"
    values = [body.get(f) if f != "name_en" else name_en for f in _COMPANY_FIELDS]
    cols = ", ".join(_COMPANY_FIELDS)
    placeholders = ", ".join(f"${i + 2}" for i in range(len(_COMPANY_FIELDS)))
    updates = ", ".join(f"{f}=EXCLUDED.{f}" for f in _COMPANY_FIELDS)
    await db.execute(
        request,
        f"INSERT INTO tenant_company_profile (tenant_id, {cols}) VALUES ($1, {placeholders})"
        f" ON CONFLICT (tenant_id) DO UPDATE SET {updates}, updated_at=now()",
        DEFAULT_TENANT, *values, table="tenant_company_profile",
    )
    return await get_company_profile(request, user)


@app.get("/api/v1/trade-docs/{doc_id}/render-data")
async def get_trade_doc_render_data(doc_id: int, request: Request,
                                    user: dict = Depends(_get_current_user)):
    """返回渲染一份单据所需的全部数据（前端负责排版/预览/打印）。

    为什么由后端装配：数据来源跨 5 张表（单证/客户/联系人/订单/报价）+ 企业主体信息，
    这套映射放在后端只有一份，前后端不会各自猜一遍字段名。
    """
    d = await db.fetchrow(request, "SELECT * FROM trade_docs WHERE tenant_id=$1 AND id=$2",
                          DEFAULT_TENANT, doc_id, table="trade_docs")
    if not d:
        raise HTTPException(status_code=404, detail={"error": "not_found", "code": "DOC_NOT_FOUND"})
    doc = _doc_dict(d)

    payload = doc.get("raw_payload") or {}
    if isinstance(payload, str):
        payload = _json.loads(payload)
    sources = payload.get("sources") or {}
    custom = payload.get("custom") or {}
    upstream = sources.get("order") or sources.get("quote") or {}

    profile = await db.fetchrow(
        request, "SELECT * FROM tenant_company_profile WHERE tenant_id=$1",
        DEFAULT_TENANT, table="tenant_company_profile",
    )
    profile_dict = dict(profile) if profile else {}

    buyer = {}
    cid = doc.get("customer_id")
    if cid:
        try:
            cid_int = int(cid)
        except (TypeError, ValueError):
            cid_int = None
        if cid_int is not None:
            customer = await db.fetchrow(
                request,
                "SELECT id, name, address FROM customers WHERE tenant_id=$1 AND id=$2",
                DEFAULT_TENANT, cid_int, table="customers",
            )
            contact = await db.fetchrow(
                request,
                "SELECT name, phone, email FROM cust_contacts"
                " WHERE tenant_id=$1 AND customer_id=$2 ORDER BY is_primary DESC, id LIMIT 1",
                DEFAULT_TENANT, cid_int,
            )
            buyer = _buyer_block(customer, contact)

    data = _build_render_data(
        doc_type=doc["doc_type"], doc_no=doc["doc_no"],
        currency=doc.get("currency") or "USD",
        total_amount=doc.get("total_amount"),
        created_at=doc.get("created_at"), issued_at=doc.get("issued_at"),
        seller=_seller_block(profile), buyer=buyer, bank_info=_seller_block(profile),
        sources=sources,
        trade_terms={f: upstream.get(f) for f in TRADE_TERM_FIELDS
                     if _clean(upstream.get(f)) is not None},
        custom=custom,
        defaults={
            "incoterm": profile_dict.get("default_incoterm"),
            "payment_terms": profile_dict.get("default_payment_terms"),
            "country_of_origin": profile_dict.get("default_country_of_origin"),
        },
    )
    return {
        "doc": doc,
        "data": data,
        # 企业主体未配置时明确告知，避免用户对着空白抬头单据猜原因
        "company_profile_configured": bool(profile_dict.get("name_en")),
    }


import chain  # noqa: E402,F401

