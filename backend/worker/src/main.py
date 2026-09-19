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

import asyncpg
import bcrypt
import jwt
from fastapi import FastAPI, Request, HTTPException, Query, UploadFile, File, Depends
from pydantic import BaseModel
from workers import WorkerEntrypoint, asgi

DEFAULT_TENANT = "default"


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
    return {"items": [dict(r) for r in rows], "total": total, "page": page, "page_size": page_size}


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
    return [dict(r) for r in rows]


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
    return [dict(r) for r in rows]


@app.get("/api/v1/intel/channels")
async def list_channels(request: Request, user: dict = Depends(_get_current_user)):
    async with _acquire(request) as conn:
        rows = await conn.fetch(
            "SELECT * FROM intel_data_channels WHERE tenant_id=$1 ORDER BY tier, name",
            DEFAULT_TENANT,
        )
    channels = [dict(r) for r in rows]
    return {
        "free_channels": [c for c in channels if c.get("tier") == "free"],
        "paid_channels": [
            {**c, "message": "未开通" if not c.get("is_enabled") else "已开通"}
            for c in channels if c.get("tier") == "paid"
        ],
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
class Default(WorkerEntrypoint):
    async def fetch(self, request):
        return await asgi.fetch(app, request, self.env)
