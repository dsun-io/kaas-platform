"""KaaS Intel Workstation API — Cloudflare Python Worker.

纯 asyncpg + FastAPI 实现，避开 SQLAlchemy async（Workers 缺 greenlet 支持）。
数据链: 谁(shipper) → 什么时间(ship_date) → 通过谁(carrier) → 向什么地区(dest_country) → 谁(consignee) → 发了什么货(product_desc)
"""
import os
import csv
import io
import hmac
import re
import secrets
import hashlib
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

from kaas_common.workstation.customer_serializers import row_to_customer, row_to_inquiry
from kaas_common.workstation.customer_rules import validate_manual_stage
from kaas_common.workstation.inquiry_rules import build_inquiry_no, normalize_abbr
from kaas_common.domain.enums import validate_enum
from kaas_common.workstation.number_rules import build_number, NumberError, normalize_number
from kaas_common.workstation.scope import can_view, can_write, is_admin_role
from kaas_common.workstation.teams import (
    TeamRuleError, invite_state, normalize_invite_token, validate_team_name,
)


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
            "SELECT id, email, display_name, account_type, role, status, team_id, console_access"
            " FROM users WHERE id=$1",
            int(payload["sub"]),
        )
    if not row or row["status"] != "active":
        raise HTTPException(status_code=401, detail="User not found or inactive")
    return dict(row)


def _require_platform_ops(user: dict) -> None:
    """平台运营 = internal 账号 + 管理员角色。

    与 `ws_admin_accounts`（system_admin）、`ws_admin_proposals`（internal+admin）同口径。
    前端只按 `account_type === 'internal'` 隐藏入口 —— **前端隐藏不是权限边界**：
    本文件 6 个 `/api/v1/admin/*` 端点此前只校验"已登录"，任意 customer 账号可直接
    写 feature flag / 读审计日志（2026-10-19 安全审查 高-1）。
    """
    from kaas_common.workstation.scope import is_admin_role

    if user.get("account_type") != "internal" or not is_admin_role(user.get("role")):
        raise HTTPException(
            status_code=403,
            detail={"error": "forbidden", "message": "Platform operator required"},
        )


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
    try:
        response = await call_next(request)
    except Exception:
        # 未捕获异常由外层的 ServerErrorMiddleware 接走时会绕过本中间件，
        # 浏览器只能看到"无 CORS 头"，把真实 500 伪装成跨域问题（2026-10-19 生产实证）。
        # 这里自己兜一层：带上 CORS 头的 500，前端至少能读到错误。
        import traceback
        traceback.print_exc()
        from fastapi.responses import JSONResponse
        response = JSONResponse(
            status_code=500,
            content={"detail": "internal_error: unexpected server error"},
        )
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
               account_type, role, plan, status, is_tenant_admin, created_at, updated_at)
               VALUES ($1,$2,$3,'internal','system_admin','internal','active',false,NOW(),NOW())
               RETURNING id, email, display_name, account_type, role""",
            body.email.lower(), _hash_password(body.password), body.display_name,
        )
    token = _create_token(row["id"], request)
    return {"access_token": token, "token_type": "bearer", "user": dict(row)}


@app.post("/api/v1/auth/login")
async def login(request: Request, body: LoginRequest):
    async with _acquire(request) as conn:
        row = await conn.fetchrow(
            "SELECT id, email, password_hash, display_name, account_type, role, status,"
            " team_id, console_access FROM users WHERE email=$1",
            body.email.lower(),
        )
    if not row or row["status"] != "active":
        raise HTTPException(status_code=401, detail="Invalid credentials")
    if not _verify_password(body.password, row["password_hash"]):
        raise HTTPException(status_code=401, detail="Invalid credentials")

    token = _create_token(row["id"], request)
    user = {k: v for k, v in dict(row).items() if k != "password_hash"}
    user["user_id"] = user["id"]
    user["team_name"] = await _team_name_of(request, user.get("team_id"))
    return {"access_token": token, "token_type": "bearer", "user": user}


async def _team_name_of(request: Request, team_id) -> Optional[str]:
    """团队名（前端 buildUser 读它显示"当前团队"）。未加入团队 → None。"""
    if team_id is None:
        return None
    async with _acquire(request) as conn:
        row = await conn.fetchrow("SELECT name FROM teams WHERE id=$1", team_id)
    return row["name"] if row else None


@app.get("/api/v1/auth/me")
async def get_me(request: Request, user: dict = Depends(_get_current_user)):
    # `user_id` 是前端 buildUser() 读取的字段名（内部主键叫 id）；少了它刷新页面后
    # 前端的 user_id 会变成 undefined，权限判断随之失效。
    # 返回**扁平**结构：team_id/team_name（账号归属哪个团队）、console_access（官网数据后台权限）。
    return {**user, "user_id": user["id"],
            "team_name": await _team_name_of(request, user.get("team_id"))}


@app.post("/api/v1/auth/logout")
async def logout():
    """登出（stateless JWT —— 服务端没有会话可销毁，客户端丢弃 token 即可）。

    与 orchestrator `app/api/auth.py` 的 /logout 同语义、同响应体。
    此前线上**没有**这条路由，而前端 `lib/auth/auth-context.tsx` 会调用它 ——
    用户点登出拿到的是 404（原登记在 scripts/route-parity-allowlist.txt 的待补项，本次已摘除）。
    """
    return {"message": "Logged out (client should discard token)"}


# ── 忘记密码 / 重置密码（token 只存哈希，30 分钟过期，用后即废）──────────
# 与 orchestrator `app/api/auth.py` 同契约、同错误码（route-parity.py 会校验）。
# 发信走 Resend REST + `_binding("RESEND_API_KEY")`（请求期读绑定，见 AGENTS.md 绑定铁律）。

_RESEND_API_URL = "https://api.resend.com/emails"
_RESET_TTL_MINUTES = 30


def _hash_reset_token(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


async def _http_post_json(url: str, headers: dict, payload: dict, timeout: int = 30):
    """出站 HTTP（Workers: js.fetch；本地 CPython: urllib）—— 与 chain.py 同法。

    不从 chain.py 导入：chain.py 反过来 import main（循环）。此处就地定义一份，
    仅 forgot-password 发信用（低频，成本可忽略）。
    """
    body = _json.dumps(payload)
    try:
        from js import fetch  # type: ignore  (Pyodide / Python Workers)
    except ImportError:
        import urllib.request
        req = urllib.request.Request(
            url, data=body.encode("utf-8"), method="POST",
            headers={**headers, "Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    opts = {"method": "POST", "headers": {**headers, "Content-Type": "application/json"}, "body": body}
    resp = await fetch(url, opts)
    return int(resp.status), await resp.text()


def _reset_email_html(reset_link: str) -> str:
    return (
        "<div style=\"font-family:sans-serif;max-width:520px;margin:0 auto;"
        "padding:24px;line-height:1.6\">"
        "<h2 style=\"margin:0 0 12px\">重置你的登录密码</h2>"
        "<p>我们收到了重置密码的请求。点击下面的按钮设置新密码：</p>"
        f"<p><a href=\"{reset_link}\" style=\"display:inline-block;background:#2563eb;"
        "color:#fff;text-decoration:none;padding:10px 20px;border-radius:6px\">"
        "设置新密码</a></p>"
        f"<p style=\"word-break:break-all;font-size:13px;color:#555\">"
        f"如果按钮无法点击，请复制以下链接到浏览器打开：<br>{reset_link}</p>"
        f"<p style=\"font-size:13px;color:#888\">该链接 {_RESET_TTL_MINUTES} 分钟内有效，"
        "且只能使用一次。若不是你本人操作，可忽略此邮件。</p>"
        "</div>"
    )


async def _send_reset_email(request: Request, to_email: str, reset_link: str) -> bool:
    """经 Resend 发重置邮件；失败只记日志、不抛（与 orchestrator 同口径）。"""
    api_key = _binding("RESEND_API_KEY", request)
    if not api_key:
        return False
    from_email = _binding("RESET_FROM_EMAIL", request) or "noreply@send.powervoy.com"
    try:
        status, text = await _http_post_json(
            _RESEND_API_URL,
            {"Authorization": f"Bearer {api_key}"},
            {
                "from": from_email,
                "to": [to_email],
                "subject": "重置你的登录密码",
                "html": _reset_email_html(reset_link),
                "text": f"点击以下链接设置新密码（{_RESET_TTL_MINUTES} 分钟内有效，仅可使用一次）：\n{reset_link}",
            },
        )
        return status in (200, 201)
    except Exception:
        return False


class _ForgotIn(BaseModel):
    email: str = ""


class _ResetIn(BaseModel):
    token: str = ""
    new_password: str = ""


@app.post("/api/v1/auth/forgot-password")
async def forgot_password(request: Request, body: _ForgotIn):
    """发送重置密码邮件（**不泄露邮箱存在性**：响应恒为 `{"ok": true, ...}`）。"""
    email = (body.email or "").strip().lower()
    if not email or "@" not in email:
        raise HTTPException(status_code=422, detail="validation_error: email is required")

    async with _acquire(request) as conn:
        async with conn.transaction():
            row = await conn.fetchrow(
                "SELECT id, email, status FROM users WHERE email=$1", email
            )
            if row and row["status"] == "active":
                raw_token = secrets.token_urlsafe(32)
                await conn.execute(
                    """UPDATE password_reset_tokens SET used_at=NOW()
                       WHERE user_id=$1 AND used_at IS NULL""",
                    row["id"],
                )
                await conn.execute(
                    """INSERT INTO password_reset_tokens
                       (user_id, token_hash, expires_at, requested_ip, created_at)
                       VALUES ($1,$2, NOW() + make_interval(mins => $3), $4, NOW())""",
                    row["id"], _hash_reset_token(raw_token), _RESET_TTL_MINUTES,
                    request.client.host if request.client else None,
                )
                reset_link = (
                    (_binding("FRONTEND_BASE_URL", request) or "https://kaas.powervoy.com").rstrip("/")
                    + f"/reset-password?token={raw_token}"
                )
                await _send_reset_email(request, row["email"], reset_link)
    return {"ok": True, "message": "如果该邮箱已注册，重置链接已发送"}


@app.post("/api/v1/auth/reset-password")
async def reset_password(request: Request, body: _ResetIn):
    """用重置令牌设置新密码（无效/过期/已用统一 400 `invalid_token`）。"""
    token = (body.token or "").strip()
    new_password = body.new_password or ""
    if not token:
        raise HTTPException(status_code=422, detail="validation_error: token is required")
    if len(new_password) < 8:
        raise HTTPException(
            status_code=422,
            detail="validation_error: Password must be at least 8 characters",
        )

    async with _acquire(request) as conn:
        async with conn.transaction():
            row = await conn.fetchrow(
                """SELECT t.id AS token_id, t.user_id, u.status
                   FROM password_reset_tokens t JOIN users u ON u.id = t.user_id
                   WHERE t.token_hash=$1 AND t.used_at IS NULL
                     AND t.expires_at > NOW() AND u.status='active'""",
                _hash_reset_token(token),
            )
            if not row:
                raise HTTPException(
                    status_code=400,
                    detail={"error": "invalid_token", "message": "重置链接无效或已过期，请重新申请"},
                )
            await conn.execute(
                "UPDATE users SET password_hash=$1, updated_at=NOW() WHERE id=$2",
                _hash_password(new_password), row["user_id"],
            )
            await conn.execute(
                "UPDATE password_reset_tokens SET used_at=NOW() WHERE user_id=$1 AND used_at IS NULL",
                row["user_id"],
            )
    return {"ok": True, "message": "密码已重置，请用新密码登录"}


# ── 客户自助注册（含团队选择）────────────────────────────────────────────────
# 与 orchestrator `app/api/auth.py` 的 /register 同语义，差异只有两处（都是适配）：
#   1) **单租户**：生产 Worker 所有数据都落 DEFAULT_TENANT。dev 会给每个注册账号新建
#      一个 UUID tenant，但 Worker 的查询一律按 DEFAULT_TENANT —— 复制过来只会让新建的
#      customer 行在 Worker 自己的查询里查不到。这里账号隔离改由「团队」这一层承担。
#   2) 团队选择：注册时可选「新建团队」（注册者成为团队管理员）或「凭邀请码加入」。
#      两者互斥；都不给则与旧行为一致（无团队）。
_CATEGORIES = frozenset([
    # 与 dev 同一清单（前端注册页的下拉就是这些值）
    "fencing",
    "mesh_panel_roll",
    "woven_mesh",
    "welded_mesh",
    "perforated_mesh",
    "wire_rope",
    "filter_mesh",
    "gabion_protection",
    "custom_wire_mesh",
    "other",
])

_SLUG_RE = re.compile(r"[^a-z0-9_]")


def _slugify(name: str) -> str:
    """公司名 → customer code 前缀（与 dev `_slugify` 同规则）。"""
    slug = _SLUG_RE.sub("_", (name or "").strip().lower())
    slug = re.sub(r"_+", "_", slug).strip("_")
    return slug[:24] if slug else "cust"


class RegisterRequest(BaseModel):
    email: str
    password: str
    display_name: str
    company_name: Optional[str] = None   # 可选（2026-10-19 去重）：与 team_name 重复，只进日志不落库
    product_category: str
    contact: Optional[str] = None
    invite_token: Optional[str] = None   # 加入现有团队（凭邀请码）
    team_name: Optional[str] = None      # 新建团队（成为团队管理员）
    # 新建团队时勾选要开通的工位（当前阶段全部免费）；不传 = 默认全部工位
    workstations: Optional[List[str]] = None


async def _unique_customer_code(conn, company_name: str) -> str:
    base = _slugify(company_name)
    for _ in range(5):
        candidate = f"{base}_{secrets.token_hex(3)}"
        if await conn.fetchval("SELECT 1 FROM customers WHERE code=$1", candidate) is None:
            return candidate
    return f"{base}_{secrets.token_hex(8)}"


@app.post("/api/v1/auth/register")
async def register(request: Request, body: RegisterRequest):
    """注册新账号（仅 customer 账号）；可选加入或新建团队。

    安全规则（与 dev 一致，反伪造）：忽略 body 里的 account_type/role/plan，
    强制 account_type='customer'、plan='free'。
    整个流程在**一个事务**里：用户名占用、邀请码无效、团队重名等任一失败都整体回滚，
    不会留下"账号建了但没进团队"的半截状态。
    """
    email = (body.email or "").strip().lower()
    password = body.password or ""
    display_name = (body.display_name or "").strip()
    company_name = (body.company_name or "").strip()
    product_category = (body.product_category or "").strip().lower()
    invite_raw = (body.invite_token or "").strip()
    team_name_raw = (body.team_name or "").strip()

    if not email or not password or not display_name:
        raise HTTPException(status_code=422, detail=(
            "validation_error: email, password, display_name are required"))
    if not product_category or product_category not in _CATEGORIES:
        raise HTTPException(status_code=422, detail=(
            "validation_error: product_category is required and must be one of: "
            + ", ".join(sorted(_CATEGORIES))))
    if len(password) < 8:
        raise HTTPException(status_code=422, detail=(
            "validation_error: Password must be at least 8 characters"))
    if "@" not in email or "." not in email.split("@")[-1]:
        raise HTTPException(status_code=422, detail="validation_error: Invalid email format")
    if invite_raw and team_name_raw:
        raise HTTPException(status_code=422, detail={
            "error": "validation", "code": "TEAM_ACTION_CONFLICT",
            "detail": "只能二选一：凭邀请码加入现有团队，或新建一个团队"})

    async with _acquire(request) as conn:
        async with conn.transaction():
            if await conn.fetchval("SELECT 1 FROM users WHERE email=$1", email) is not None:
                raise HTTPException(status_code=409, detail="conflict: Email already registered")

            # ── 团队动作预校验（放在建账号之前，失败即整体回滚）──
            invite = None
            if invite_raw:
                token = normalize_invite_token(invite_raw)
                invite = await conn.fetchrow(
                    "SELECT * FROM team_invites WHERE token=$1", token)
                state = invite_state(dict(invite) if invite is not None else None)
                if state == "not_found":
                    raise HTTPException(status_code=404, detail={
                        "error": "not_found", "code": "INVITE_NOT_FOUND"})
                if state == "revoked":
                    raise HTTPException(status_code=410, detail={
                        "error": "gone", "code": "INVITE_REVOKED"})
                if state == "used":
                    raise HTTPException(status_code=409, detail={
                        "error": "conflict", "code": "INVITE_ALREADY_USED"})
                if state == "expired":
                    raise HTTPException(status_code=410, detail={
                        "error": "gone", "code": "INVITE_EXPIRED"})

            new_team_name = None
            if team_name_raw:
                try:
                    new_team_name = validate_team_name(team_name_raw)
                except TeamRuleError as exc:
                    raise HTTPException(status_code=422, detail={
                        "error": "validation", "code": exc.code, "detail": exc.detail})
                if await conn.fetchval(
                    "SELECT 1 FROM teams WHERE tenant_id=$1 AND name=$2",
                    DEFAULT_TENANT, new_team_name,
                ) is not None:
                    raise HTTPException(status_code=409, detail={
                        "error": "conflict", "code": "TEAM_NAME_TAKEN",
                        "message": f"已存在同名团队「{new_team_name}」"})

            # 建团队的成为团队管理员（role=owner）；凭码加入的是普通成员（role=user）
            role = "user" if invite is not None else "owner"
            user_row = await conn.fetchrow(
                "INSERT INTO users (email, password_hash, display_name, account_type, role,"
                " plan, status, is_tenant_admin) VALUES ($1,$2,$3,'customer',$4,'free','active',false)"
                " RETURNING id, email, display_name, account_type, role, status",
                email, _hash_password(password), display_name, role,
            )
            uid = user_row["id"]

            # 不再为注册者创建 `customers` 行：公司身份由**团队**承载。
            # `customers` 从此只放**业务客户**（客户工位里录入的、我们卖货给谁）。
            # 这也是"团队 / 用户 / 业务客户"三概念分开的关键一步。
            team_id = None
            team_name_out = None

            async def _open_workstations(tid):
                for ws_code in ws_teams._resolve_signup_workstations(body.workstations):
                    await conn.execute(
                        "INSERT INTO team_subscriptions (team_id, code, active, source)"
                        " VALUES ($1,$2,true,'signup')"
                        " ON CONFLICT (team_id, code) DO UPDATE SET"
                        "   active = true, source = 'signup', updated_at = now()",
                        tid, ws_code)

            if invite is not None:
                team_id = invite["team_id"]
                await conn.execute(
                    "UPDATE users SET team_id=$2 WHERE id=$1", uid, team_id)
                await conn.execute(
                    "UPDATE team_invites SET status='accepted', accepted_at=now(),"
                    " accepted_by=$2 WHERE id=$1",
                    invite["id"], uid)
                trow = await conn.fetchrow("SELECT name FROM teams WHERE id=$1", team_id)
                team_name_out = trow["name"] if trow else None
            else:
                # 与 orchestrator 同口径：只有显式传 team_name 才建团队。
                # 2026-10-19 去掉 company_name 兜底 —— 注册页公司名称输入框已删除，
                # company_name 即将不再上传；留着兜底会让"稍后再说"的旧客户端
                # 凭空多建一个团队（且与 docstring"都不给=无团队"自相矛盾）。
                if new_team_name:
                    team = await conn.fetchrow(
                        "INSERT INTO teams (tenant_id, name, created_by) VALUES ($1,$2,$3)"
                        " RETURNING id, name",
                        DEFAULT_TENANT, new_team_name, uid)
                    team_id, team_name_out = team["id"], team["name"]
                    await conn.execute(
                        "UPDATE users SET team_id=$2 WHERE id=$1", uid, team_id)
                    await _open_workstations(team_id)

    # 扁平响应：前端 buildUser() 读 user_id / team_id / team_name / console_access
    return {
        "user_id": uid,
        "email": user_row["email"],
        "display_name": user_row["display_name"],
        "account_type": user_row["account_type"],
        "role": user_row["role"],
        "team_id": team_id,
        "team_name": team_name_out,
        "console_access": False,          # 官网数据后台权限：默认关闭，由团队管理员授予
        "access_token": _create_token(uid, request),
        "token_type": "bearer",
    }


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
    # 公司名与联系人**至少填一个**（2026-10-17 用户口径）：只有个人联系人的客户也要能建。
    company_name: Optional[str] = None
    contact_name: Optional[str] = None
    contact_phone: Optional[str] = None
    contact_email: Optional[str] = None
    # 客户缩写（询盘编号用）：2-6 位字母/数字；可空
    abbr: Optional[str] = None
    country: Optional[str] = None
    address: Optional[str] = None
    default_port: Optional[str] = None
    credit_level: Optional[str] = None
    # 手动客户阶段（活跃 / 沉寂）；「已下单」由开启中的订单推导，不许手写。
    stage: str = "active"
    notes: Optional[str] = None
    owner_scope: Optional[str] = None   # private | tenant（§10.3）


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
    # 询盘三态：新建默认「未报价」；生成报价后自动「已报价」；「已关闭」仅手动
    status: str = "unquoted"
    notes: Optional[str] = None


class StageUpdate(BaseModel):
    stage: str
    reason: Optional[str] = None


# 客户阶段的**唯一**推导 SQL（与 kaas_common.workstation.customer_rules 同口径）：
# 名下有开启中的订单 ⇒ ordered；否则按库里手动值归一（inactive/lost → 沉寂，其余活跃）。
# 为什么不落库：订单状态才是源头，落库就会出现「订单改了、客户阶段没跟上」的旧数据。
_OPEN_ORDER_STATUS_SQL = "('pending','confirmed','producing','shipped')"


def _customer_stage_sql(alias: str = "c") -> str:
    return (
        "CASE WHEN EXISTS (SELECT 1 FROM orders o"
        f" WHERE o.tenant_id = {alias}.tenant_id AND o.customer_id = {alias}.id"
        f" AND o.status IN {_OPEN_ORDER_STATUS_SQL}) THEN 'ordered'"
        f" WHEN {alias}.stage IN ('inactive','lost') THEN 'inactive'"
        " ELSE 'active' END"
    )


def _customer_api(row) -> dict:
    """客户行 → API 响应（stage=推导展示值，manual_stage=手动值）。"""
    d = dict(row)
    return row_to_customer(d, display_stage=d.get("stage_display"))


async def _next_inquiry_no(conn, customer: dict) -> str:
    """生成唯一询盘编号：`INQ-国家-客户-时间戳`（同秒冲突加后缀）。"""
    for suffix in range(1, 21):
        candidate = build_number("inquiry", customer, suffix=suffix)
        exists = await conn.fetchval(
            "SELECT 1 FROM cust_inquiries WHERE tenant_id=$1 AND inquiry_no=$2 LIMIT 1",
            DEFAULT_TENANT, candidate,
        )
        if not exists:
            return candidate
    return build_number("inquiry", customer) + "-X"


def _norm_abbr(raw) -> Optional[str]:
    """客户缩写：空 → None；非空但不合法 → 422。"""
    if raw is None or str(raw).strip() == "":
        return None
    value = normalize_abbr(raw)
    if value is None:
        raise HTTPException(status_code=422, detail={
            "error": "validation", "code": "INVALID_CUSTOMER_ABBR",
            "detail": "客户缩写需为 2-6 位字母/数字（用于询盘编号）",
        })
    return value


async def _customer_or_404(conn, customer_id: int, user: dict) -> dict:
    """取客户并做「未删除 + 三层可见性」过滤（与 dev `_get_customer_or_404` 同口径）。

    客户域必须与订单/报价/单证执行**同一套规则**，否则会出现
    「列表里看得见、点进去 404」这种自相矛盾（见 docs/TEAMS_AND_VISIBILITY.md）。
    不可见一律 404，不泄露存在性。
    """
    row = await conn.fetchrow(
        f"SELECT c.*, c.name AS company_name, {_customer_stage_sql('c')} AS stage_display"
        " FROM customers c"
        " WHERE c.id=$1 AND c.tenant_id=$2 AND c.is_deleted = false",
        customer_id, DEFAULT_TENANT,
    )
    if row is None or not _owner_visible(user, row):
        raise HTTPException(status_code=404, detail={
            "error": "not_found", "code": "CUSTOMER_NOT_FOUND"})
    return dict(row)


# ── 单据归属闸门：单据必须挂在**已有业务客户**上（手动新建 / 导入也要选）──────
# 为什么收在这里：报价（quote_api）/ 订单 / 单证三条写入路径必须走**同一道**闸门。
# dev 侧的同一道闸门是 `app/api/ws_common.py::resolve_customer_for_doc`
# （语义：存在 + 未软删 + 可见 + 属本团队，跨团队一律 404 CUSTOMER_NOT_FOUND），
# 本文件是它的 raw SQL 版 —— 两侧判据必须逐条一致，否则同一份数据
# 「本地能建、线上 404」，或者反过来某条路径绕过了团队隔离。
# 判定本身不另写：可见性走 `_owner_visible`（→ kaas_common.scope.can_view）、
# 管理员豁免走 `_can_see_all`（→ kaas_common.scope.is_admin_role）。


def _as_bigint(raw, *, field: str, code: str) -> Optional[int]:
    """请求体里的 BIGINT 外键 → int；空值/空白 → None；非数字 → 422。

    为什么不宽容转换：这些列全是 BIGINT 外键，而前端选择器里可能残留
    `"cust-1"` 这类历史 mock 形态的字符串（见 use-upstream.toCustomerIdPayload）。
    静默取 0 会写出一堆指向"客户 0"的脏数据，422 能让调用方当场改对。
    """
    if raw is None:
        return None
    text = str(raw).strip()
    if not text:
        return None
    if not text.isdigit():
        raise HTTPException(status_code=422, detail={
            "error": "validation", "code": code, "field": field,
            "value": str(raw), "detail": f"{field} 必须是整数 id",
        })
    return int(text)


def _same_team(a, b) -> bool:
    """团队一致（都未分组视为一致）—— 与 dev `resolve_customer_for_doc` 同口径。

    宽松比较的原因：`team_id` 在库里是 BIGINT，而 `user.team_id` 来自 token
    解析（int / str 都可能），直接用 `!=` 会把同一个团队判成不一致。
    """
    if a is None or b is None:
        return a is None and b is None
    return str(a) == str(b)


async def _doc_customer(conn, raw_id, user: dict, *, required: bool) -> Optional[dict]:
    """单据上的客户引用 → 客户行（客户闸门；报价 / 订单 / 单证共用这一份）。

    - `required=True`：缺 `customer_id` → **422 `CUSTOMER_REQUIRED`**。
      "没选客户"（表单漏填）与"客户不可见"（404）必须分开说，
      否则用户对着"客户不存在"根本找不到原因。
    - 给了就一定过 `_customer_or_404`（存在 / 未软删 / 可见）→ 否则 404。
    - 再加**团队一致**：客户必须属于调用者的团队；管理员豁免 ——
      管理员在客户域本来就"全租户可见"，强行要求团队一致会出现
      「客户列表里看得见、开单时选不了」的死路（dev 也是这么写的）。
    """
    customer_id = _as_bigint(raw_id, field="customer_id", code="INVALID_CUSTOMER_ID")
    if customer_id is None:
        if required:
            raise HTTPException(status_code=422, detail={
                "error": "validation", "code": "CUSTOMER_REQUIRED",
                "field": "customer_id",
                "detail": ("单据必须归属业务客户：请从已有业务客户里选择"
                           "（没有 customer_id，客户页的「往来记录」里就查不到这张单）"),
            })
        return None
    customer = await _customer_or_404(conn, customer_id, user)
    if not _can_see_all(user) and not _same_team(customer.get("team_id"),
                                                user.get("team_id")):
        # 与"客户不存在"同样回 404：不泄露别家客户是否存在
        raise HTTPException(status_code=404, detail={
            "error": "not_found", "code": "CUSTOMER_NOT_FOUND",
            "detail": "客户不存在或不属于你的团队"})
    return customer


async def _order_source_quote(conn, quote_id: int, user: dict) -> dict:
    """报价转订单的来源闸门：报价必须可见，且处于可转化状态。

    `orders.quote_id` 是客户页「报价 → 订单」包含关系的**唯一来源**，
    写错就是把订单挂到别人家的报价下；状态口径与 dev `orders.create_order`
    一致（rejected / expired / cancelled 不可转化）。
    """
    row = await conn.fetchrow(
        "SELECT * FROM quote_orders WHERE tenant_id=$1 AND id=$2",
        DEFAULT_TENANT, quote_id,
    )
    if row is None or not _owner_visible(user, row):
        raise HTTPException(status_code=404, detail={
            "error": "not_found", "code": "QUOTE_NOT_FOUND"})
    quote = dict(row)
    if quote.get("status") in ("rejected", "expired", "cancelled"):
        raise HTTPException(status_code=409, detail={
            "error": "conflict", "code": "QUOTE_NOT_CONVERTIBLE",
            "detail": f"报价单状态 {quote['status']} 不可转化为订单"})
    return quote


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
    # 软删除的客户不再出现（is_deleted 原先只写不读 —— 标记了也照样列出来）
    where = ["c.tenant_id = $1", "c.is_deleted = false"]
    params: list = [DEFAULT_TENANT]
    idx = 2
    if stage:
        # stage 是**展示值**：ordered 由订单推导，active/inactive 是手动列。
        validate_enum("customer_stage", stage)
        has_open = ("EXISTS (SELECT 1 FROM orders o"
                    " WHERE o.tenant_id = c.tenant_id AND o.customer_id = c.id"
                    f" AND o.status IN {_OPEN_ORDER_STATUS_SQL})")
        if stage == "ordered":
            where.append(has_open)
        elif stage == "inactive":
            where.append(f"NOT {has_open} AND c.stage IN ('inactive','lost')")
        else:  # active
            where.append(f"NOT {has_open} AND c.stage NOT IN ('inactive','lost')")
    if country:
        where.append(f"c.country ILIKE ${idx}"); params.append(f"%{country}%"); idx += 1
    if q:
        where.append(f"c.name ILIKE ${idx}"); params.append(f"%{q}%"); idx += 1
    # 三层组织 + §10.3：谁创建的客户，就在其团队可见；其他团队看不到
    if not _can_see_all(user):
        params.append(str(user["id"]))
        scope_cond = f"(c.owner_id = ${idx} OR c.owner_scope = 'tenant'"
        idx += 1
        if user.get("team_id") is not None:
            params.append(user["team_id"])
            scope_cond += f" OR c.team_id = ${idx}"
            idx += 1
        where.append(scope_cond + ")")
    where_sql = " AND ".join(where)
    async with _acquire(request) as conn:
        # 2026-10-18：不再在这里跑 30/90 天兜底、也不再重算客户阶段 ——
        # 客户阶段只有 active/inactive 手动值 + ordered 推导值，读时算，不落库。
        total = await conn.fetchval(
            f"SELECT COUNT(*) FROM customers c WHERE {where_sql}", *params)
        rows = await conn.fetch(
            f"SELECT c.*, c.name AS company_name, {_customer_stage_sql('c')} AS stage_display"
            f" FROM customers c WHERE {where_sql}"
            f" ORDER BY c.created_at DESC LIMIT ${idx} OFFSET ${idx+1}",
            *params, page_size, (page - 1) * page_size,
        )
    return {"items": [_customer_api(r) for r in rows], "total": total,
            "page": page, "page_size": page_size}


@app.post("/api/v1/customers", status_code=201)
async def create_customer(request: Request, body: CustomerCreate, user: dict = Depends(_get_current_user)):
    # §10.3 归属必须落库：dev 的 create_customer 写 owner_id/owner_scope，线上原先不写。
    # 不写的后果是自相矛盾 —— 既有 GET /customers 不做归属过滤（列表里有），
    # 而按归属过滤的接口（PATCH /customers/{id}、GET .../inquiries）会把这条记录
    # 判为不可见 → 404「列表里看得见、点进去没有」。同时补上枚举校验（与 dev 一致）。
    #
    # 2026-10-17 两个线上问题：
    #   ① 500：customers.plan / status 是 NOT NULL 且只有 ORM 默认值（没有 server_default），
    #      裸 SQL 不写它们 ⇒ 约束失败。这里显式写 'free' / 'active'。
    #   ② 需求：公司名与联系人至少填一个；只填联系人时用联系人名做展示名，并落一条主联系人。
    company_name = (body.company_name or "").strip()
    contact_name = (body.contact_name or "").strip()
    if not company_name and not contact_name:
        raise HTTPException(status_code=422, detail={
            "error": "missing_identity",
            "code": "CUSTOMER_IDENTITY_REQUIRED",
            "detail": "公司名称和联系人至少填写一个",
        })
    # 客户阶段只有活跃/沉寂可手写；已下单由开启中的订单推导（用户 2026-10-18 口径）。
    stage = body.stage or "active"
    ok, msg = validate_manual_stage(stage)
    if not ok:
        raise HTTPException(status_code=422, detail={
            "error": "invalid_enum", "code": "INVALID_CUSTOMER_STAGE",
            "detail": msg,
        })
    owner_scope = validate_enum("owner_scope", body.owner_scope) or "private"
    async with _acquire(request) as conn:
        async with conn.transaction():
            row = await conn.fetchrow(
                """INSERT INTO customers
                   (tenant_id, name, abbr, plan, status, country, address, default_port,
                    credit_level, stage, notes, created_by, owner_id, owner_scope, team_id)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
                   RETURNING *, name AS company_name""",
                DEFAULT_TENANT, company_name or contact_name, _norm_abbr(body.abbr),
                "free", "active",
                body.country, body.address, body.default_port, body.credit_level,
                stage, body.notes, str(user["id"]), str(user["id"]), owner_scope,
                user.get("team_id"),
            )
            if contact_name:
                await conn.execute(
                    """INSERT INTO cust_contacts
                           (tenant_id, customer_id, name, phone, email, is_primary)
                       VALUES ($1,$2,$3,$4,$5,true)""",
                    DEFAULT_TENANT, row["id"], contact_name,
                    (body.contact_phone or "").strip() or None,
                    (body.contact_email or "").strip() or None,
                )
    return _customer_api(row)


# ── 客户阶段（2026-10-18 用户口径）────────────────────────────────────────────
#   客户阶段与订单阶段是**两层，不能混**：
#     · 客户阶段 = active（活跃）/ inactive（沉寂，手动关闭）/ ordered（已下单，推导）；
#     · 「已下单」只由**开启中的订单**推导（pending/confirmed/producing/shipped）；
#     · 不再按询盘/报价状态改写客户阶段，也不再跑 30/90 天自动流失/沉寂。
#   本文件原先的 `_recompute_customer_stage` / `_refresh_stale_customer_stages`
#   已删除：那套逻辑正是「手动改阶段被系统覆盖」的根因。
#   推导的唯一 SQL 入口 = `_customer_stage_sql()`（读时算，不落库）。


@app.get("/api/v1/customers/{customer_id}")
async def get_customer(customer_id: int, request: Request, user: dict = Depends(_get_current_user)):
    async with _acquire(request) as conn:
        row = await _customer_or_404(conn, customer_id, user)
        contacts = await conn.fetch(
            "SELECT * FROM cust_contacts WHERE customer_id=$1 ORDER BY is_primary DESC, created_at", customer_id,
        )
        inquiries = await conn.fetch(
            "SELECT * FROM cust_inquiries WHERE customer_id=$1 ORDER BY created_at DESC", customer_id,
        )
        stage_log = await conn.fetch(
            "SELECT * FROM cust_stage_log WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 20", customer_id,
        )
        inquiry_items = []
        for i in inquiries:
            item = row_to_inquiry(dict(i))
            has_quote = await conn.fetchval(
                "SELECT 1 FROM quote_orders WHERE tenant_id=$1 AND inquiry_id=$2 LIMIT 1",
                DEFAULT_TENANT, i["id"],
            )
            item["inquiry_no_editable"] = not bool(has_quote)
            inquiry_items.append(item)
    return {
        **_customer_api(row),
        "contacts": [dict(c) for c in contacts],
        "inquiries": inquiry_items,
        "stage_log": [dict(s) for s in stage_log],
    }


@app.post("/api/v1/customers/{customer_id}/contacts", status_code=201)
async def add_contact(customer_id: int, request: Request, body: ContactCreate, user: dict = Depends(_get_current_user)):
    async with _acquire(request) as conn:
        await _customer_or_404(conn, customer_id, user)
        row = await conn.fetchrow(
            """INSERT INTO cust_contacts
               (tenant_id, customer_id, name, position, phone, email, whatsapp, wechat, is_primary)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *""",
            DEFAULT_TENANT, customer_id, body.name, body.position, body.phone,
            body.email, body.whatsapp, body.wechat, body.is_primary,
        )
    return dict(row)


class ContactUpdate(BaseModel):
    name: Optional[str] = None
    position: Optional[str] = None
    phone: Optional[str] = None
    email: Optional[str] = None
    whatsapp: Optional[str] = None
    wechat: Optional[str] = None
    is_primary: Optional[bool] = None


@app.patch("/api/v1/customers/{customer_id}/contacts/{contact_id}")
async def update_contact(customer_id: int, contact_id: int, request: Request,
                         body: ContactUpdate, user: dict = Depends(_get_current_user)):
    async with _acquire(request) as conn:
        await _customer_or_404(conn, customer_id, user)   # 可见性 + 未删除
        ct = await conn.fetchrow(
            "SELECT * FROM cust_contacts WHERE id=$1 AND customer_id=$2 AND tenant_id=$3",
            contact_id, customer_id, DEFAULT_TENANT)
        if not ct:
            raise HTTPException(status_code=404, detail="Contact not found")
        if body.is_primary:
            await conn.execute(
                "UPDATE cust_contacts SET is_primary=false WHERE customer_id=$1 AND tenant_id=$2 AND id != $3",
                customer_id, DEFAULT_TENANT, contact_id)
        row = await conn.fetchrow(
            """UPDATE cust_contacts SET
               name=COALESCE($2,name), position=COALESCE($3,position),
               phone=COALESCE($4,phone), email=COALESCE($5,email),
               whatsapp=COALESCE($6,whatsapp), wechat=COALESCE($7,wechat),
               is_primary=COALESCE($8,is_primary)
               WHERE id=$1 RETURNING *""",
            contact_id, body.name, body.position, body.phone, body.email,
            body.whatsapp, body.wechat, body.is_primary)
    return dict(row)


@app.delete("/api/v1/customers/{customer_id}/contacts/{contact_id}", status_code=204)
async def delete_contact(customer_id: int, contact_id: int, request: Request,
                         user: dict = Depends(_get_current_user)):
    async with _acquire(request) as conn:
        await _customer_or_404(conn, customer_id, user)   # 可见性 + 未删除
        await conn.execute(
            "DELETE FROM cust_contacts WHERE id=$1 AND customer_id=$2 AND tenant_id=$3",
            contact_id, customer_id, DEFAULT_TENANT)
    return None


@app.delete("/api/v1/customers/{customer_id}", status_code=204)
async def soft_delete_customer(customer_id: int, request: Request,
                               user: dict = Depends(_get_current_user)):
    """客户软删除（列表隐藏、历史单据保留引用）。

    有**开启中的订单**时 409 `OPEN_ORDERS_EXIST`：订单还在跑却把客户删掉，
    后续发货/对账会找不到客户（用户 2026-10-18 确认）。
    """
    async with _acquire(request) as conn:
        await _customer_or_404(conn, customer_id, user)   # 可见性 + 未删除（已删则 404）
        open_orders = await conn.fetch(
            "SELECT id, order_no, status FROM orders"
            " WHERE tenant_id=$1 AND customer_id=$2"
            f" AND status IN {_OPEN_ORDER_STATUS_SQL} ORDER BY id",
            DEFAULT_TENANT, customer_id)
        if open_orders:
            raise HTTPException(status_code=409, detail={
                "error": "conflict", "code": "OPEN_ORDERS_EXIST",
                "detail": f"客户名下有 {len(open_orders)} 张开启中的订单，请先关闭订单再删除",
                "open_orders": [
                    {"id": o["id"], "order_no": o["order_no"], "status": o["status"]}
                    for o in open_orders
                ],
            })
        await conn.execute(
            "UPDATE customers SET is_deleted=true, deleted_at=now() WHERE id=$1 AND tenant_id=$2",
            customer_id, DEFAULT_TENANT)
    return None


@app.post("/api/v1/customers/{customer_id}/inquiries", status_code=201)
async def add_inquiry(customer_id: int, request: Request, body: InquiryCreate, user: dict = Depends(_get_current_user)):
    async with _acquire(request) as conn:
        customer = await _customer_or_404(conn, customer_id, user)
        inquiry_no = await _next_inquiry_no(conn, customer)
        inquiry_status = "unquoted" if body.status in (None, "", "open") else body.status
        row = await conn.fetchrow(
            """INSERT INTO cust_inquiries
               (tenant_id, customer_id, inquiry_no, channel, category_id, product_name_raw,
                quantity, quantity_unit, application, status, notes, created_by,
                owner_id, owner_scope, team_id)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *""",
            DEFAULT_TENANT, customer_id, inquiry_no, body.channel, body.category_id,
            body.product_name_raw,
            body.quantity, body.quantity_unit, body.application, inquiry_status, body.notes,
            str(user["id"]), str(user["id"]), "private", user.get("team_id"),
        )
        # 2026-10-18：询盘是**单据阶段**，不再联动改客户阶段（客户阶段只有
        # 活跃/沉寂/已下单，已下单只由开启中的订单推导）。
    return dict(row)


@app.patch("/api/v1/customers/{customer_id}/stage")
async def update_stage(customer_id: int, request: Request, body: StageUpdate, user: dict = Depends(_get_current_user)):
    """手动切换客户阶段（活跃 / 沉寂）。

    2026-10-18 用户口径：
      · 客户阶段只有三种，其中「已下单」由开启中的订单推导，**不允许手写**；
      · 「流失」属于订单阶段，客户阶段不再有 lost，也不再要求拒绝文件。
    """
    target = body.stage
    ok, msg = validate_manual_stage(target)
    if not ok:
        raise HTTPException(status_code=422, detail={
            "error": "invalid_enum", "code": "INVALID_CUSTOMER_STAGE",
            "detail": msg,
        })
    async with _acquire(request) as conn:
        cust = await _customer_or_404(conn, customer_id, user)
        from_stage = cust["stage"]
        reason = (body.reason or "").strip() or None
        await conn.execute(
            "UPDATE customers SET stage=$1, updated_at=NOW() WHERE id=$2", target, customer_id,
        )
        await conn.execute(
            """INSERT INTO cust_stage_log (tenant_id, customer_id, from_stage, to_stage, changed_by, reason)
               VALUES ($1,$2,$3,$4,$5,$6)""",
            DEFAULT_TENANT, customer_id, from_stage, target, str(user["id"]), reason,
        )
        row = await _customer_or_404(conn, customer_id, user)
    return {**_customer_api(row), "closed_inquiries": []}


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
    # schema_version 必须显式写入：它 NOT NULL 且**没有数据库默认值**，
    # 而 orchestrator 侧的 `default=1` 只是 SQLAlchemy 客户端行为、不会生成 DDL 默认。
    # 漏写会稳定触发 NotNullViolationError（即这条接口在线上必 500）。
    # 这里直接写字面量 1，避免改动后面 13 个占位符的编号。
    row = await db.fetchrow(
        request,
        """INSERT INTO quotations
           (schema_version, tenant_id, customer_id, product_category, product_spec,
            spec_hash, unit_price, currency, unit, discount, min_quantity, source,
            notes, created_by)
           VALUES (1,$1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12,$13)
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
# 2026-10-19 重写：旧实现是「按 product_specs 的自由规格成本」（老算价流程），
# 返回 {items,total,page,pages} 分页列表 —— 前端定价页要的是产品定价键的**完整矩阵**
# （orchestrator app/api/pricing_data.py 语义），读到旧形状 matrix.rows 是
# undefined → TypeError（生产实证，页面白屏）。本块与 orchestrator 同语义同形状；
# 矩阵/档位逻辑直接复用 quote_api 的移植（与算价接口共用同一身份与规则，
# 保证「这里配的价 = 算价用的价」）。
from pricing_rules import parse_date, to_float  # noqa: E402

# 成本单位 → cost_type（与 orchestrator app/api/pricing_data.py:55-63 逐字一致）
_PRICING_UNIT_TO_COST_TYPE = {
    "元/kg": "cost_per_kg",
    "kg": "cost_per_kg",
    "元/卷": "cost_per_roll",
    "元/捆": "cost_per_bundle",
    "元/平方米": "cost_per_sqm",
    "元/个": "fixed",
    "元/根": "fixed",
}


def _pricing_history(items: list, product_key: str) -> dict:
    """把定价行的全部版本按 (customer_id, 定价键) 归拢（orchestrator collect_price_history）。"""
    prefix = f"{product_key}:"
    out: dict = {}
    for item in items:
        spec_hash = item.get("spec_hash") or ""
        if not spec_hash.startswith(prefix):
            continue
        amount = item.get("amount")
        if amount is None or float(amount) <= 0:
            continue
        key = spec_hash.split(":", 1)[1]
        out.setdefault((item.get("customer_id"), key), []).append(item)
    return out


def _pricing_reference(rows: list) -> dict:
    """一批历次录入的参考统计（全部历史 + 近 30 天；orchestrator reference_stats）。

    `rows` 需按**最新在前**排（查询按 id 倒序）。
    """
    empty = {"count": 0, "avg": None, "min": None, "max": None,
             "last": None, "last_at": None, "avg_30d": None, "count_30d": 0}
    amounts = [float(i["amount"]) for i in rows if i.get("amount") is not None]
    if not amounts:
        return empty
    newest = rows[0]
    created = newest.get("created_at")
    recent: list = []
    # 窗口基准必须是**现在**，不能拿"最新一条"当基准（orchestrator 同注释）
    now = datetime.now(timezone.utc)
    for i in rows:
        at = i.get("created_at")
        if at is None:
            continue
        if at.tzinfo is None:          # 库里可能是 naive（无时区）
            at = at.replace(tzinfo=timezone.utc)
        if (now - at).days <= 30:
            recent.append(float(i["amount"]))
    return {
        "count": len(amounts),
        "avg": round(sum(amounts) / len(amounts), 6),
        "min": min(amounts),
        "max": max(amounts),
        "last": amounts[0],
        "last_at": created.isoformat() if created else None,
        "avg_30d": (round(sum(recent) / len(recent), 6) if recent else None),
        "count_30d": len(recent),
    }


@app.get("/api/v1/pricing-data")
async def list_pricing_data(
    request: Request,
    user: dict = Depends(_get_current_user),
):
    """某产品定价键的**完整矩阵**（与 orchestrator app/api/pricing_data.py 同语义）。

    - `scope=own`（默认）：当前客户自己的配置。身份与算价接口**同一口径**
      （quote_api._customer_of —— 保证「这里配的价 = 算价用的价」）。
    - `scope=all`（仅内部管理员）：本租户所有客户的配置，按客户分组。
    - 客户自己在定价数据里加过的档位会并入规格空间（与算价看到的选项一致）。
    """
    quote_api._require_engine()
    product_key = (request.query_params.get("product_key") or "").strip()
    if not product_key:
        raise HTTPException(status_code=422, detail="product_key is required")
    try:
        product = quote_api.get_product(product_key)
    except Exception:
        raise HTTPException(status_code=404, detail=f"未知产品: {product_key}")

    scope = (request.query_params.get("scope") or "own").strip()
    if scope not in ("own", "all"):
        raise HTTPException(status_code=422, detail="scope must be own or all")

    tenant = quote_api._tenant_of(user)
    if scope == "all":
        # 跨客户查看属内部视图，必须内部管理员（orchestrator: require_tenant_admin）
        if not quote_api._is_internal_admin(user):
            raise HTTPException(status_code=403, detail="跨客户查看仅管理员可用")
        extended = quote_api.extend_product(
            product,
            await quote_api._load_option_extensions(request, tenant, None, product),
        )
        customer_id = None
    else:
        customer_id = quote_api._customer_of(user)
        extended = quote_api.extend_product(
            product,
            await quote_api._load_option_extensions(request, tenant, customer_id, product),
        )

    dims = quote_api.describe_pricing_key(extended)
    rows = quote_api._matrix_rows(extended)
    items = await quote_api._pricing_key_items(request, tenant, customer_id, product.key)

    prefix = f"{product.key}:"
    by_customer: dict = {}
    for item in items:
        spec_hash = item.get("spec_hash") or ""
        if not spec_hash.startswith(prefix):
            continue
        key = spec_hash.split(":", 1)[1]
        bucket = by_customer.setdefault(item.get("customer_id"), {})
        if key not in bucket:      # 查询按 id 倒序 → 首次遇到即最新
            bucket[key] = item
    history = _pricing_history(items, product.key)

    def _cell(cid, bucket, row):
        item = bucket.get(row["key"])
        eff = item.get("effective_from") if item else None
        return {
            "key": row["key"],
            "values": row["values"],
            "labels": row["labels"],
            "amount": float(item["amount"]) if item else None,
            "unit": (item.get("unit") if item else
                     (product.cost_unit.split("/")[-1] if product.cost_unit else "")),
            "item_id": item.get("id") if item else None,
            "effective_from": eff.isoformat() if eff else None,
            "source": item.get("source") if item else "product_default",
            "notes": item.get("notes") if item else None,
            "configured": item is not None,
            "reference": _pricing_reference(history.get((cid, row["key"])) or []),
        }

    if customer_id is not None:
        bucket = by_customer.get(customer_id, {})
        return {
            "product_key": product.key,
            "product_name": product.name,
            "cost_unit": product.cost_unit,
            "scope": "own",
            "dims": dims,
            "rows": [_cell(customer_id, bucket, r) for r in rows],
        }
    customers = [
        {
            "customer_id": cid,
            "rows": [_cell(cid, bucket, r) for r in rows],
            "configured_count": sum(1 for r in rows if bucket.get(r["key"])),
        }
        for cid, bucket in sorted(by_customer.items())
    ]
    return {
        "product_key": product.key,
        "product_name": product.name,
        "cost_unit": product.cost_unit,
        "scope": "all",
        "dims": dims,
        "rows": [_cell("", {}, r) for r in rows],   # 兜底模板（全为未配置）
        "customers": customers,
    }


@app.post("/api/v1/pricing-data", status_code=201)
async def create_pricing_data(
    request: Request,
    user: dict = Depends(_get_current_user),
):
    """保存一个定价键组合的成本（INSERT 新版本 + 同键旧版本置 inactive）。

    与 orchestrator app/api/pricing_data.py:create_pricing_data 同语义。
    INSERT-only 而非 UPDATE：成本价会变，但已经发出去的报价必须能复现当时的成本。
    单语句数据修改 CTE 保证「停用旧版本 + 插入新版本」原子性（db 助手每语句独立连接）。
    """
    quote_api._require_engine()
    body = await request.json()
    # 身份一律取登录态，不信任请求体（与 orchestrator require_tenant/customer_match 同效果）
    tenant = quote_api._tenant_of(user)
    customer_id = quote_api._customer_of(user)

    product_key = str(body.get("product_key") or "").strip()
    if not product_key:
        raise HTTPException(status_code=422, detail="product_key is required")
    try:
        product = quote_api.get_product(product_key)
    except Exception:
        raise HTTPException(status_code=404, detail=f"未知产品: {product_key}")
    if not product.pricing_key:
        raise HTTPException(
            status_code=422,
            detail=f"产品 {product_key} 未声明定价键，无法保存定价数据",
        )

    values = body.get("values")
    if not isinstance(values, dict) or not values:
        raise HTTPException(status_code=422, detail="values is required")
    key = quote_api.pricing_key_of(product, values)
    if not key:
        raise HTTPException(
            status_code=422,
            detail=f"values 缺少定价键维度；需要: {[d['field'] for d in product.pricing_key]}",
        )

    amount = body.get("amount")
    if amount is None or not isinstance(amount, (int, float)) or amount <= 0:
        raise HTTPException(status_code=422, detail="amount must be > 0")
    unit = str(body.get("unit") or "").strip() or (
        product.cost_unit.split("/")[-1] if product.cost_unit else "kg"
    )
    cost_type = _PRICING_UNIT_TO_COST_TYPE.get(unit)
    if cost_type is None:
        raise HTTPException(
            status_code=422,
            detail=f"unit 必须是以下之一: {sorted(set(_PRICING_UNIT_TO_COST_TYPE.keys()))}",
        )

    spec_hash = f"{product.key}:{key}"
    effective_from = parse_date(body.get("effective_from"))
    # 客户自加档位的显示名由界面给（如「镀锌60g/㎡」），不写进产品定义
    raw_labels = body.get("labels")
    labels = (
        {str(k): str(v) for k, v in raw_labels.items()}
        if isinstance(raw_labels, dict) else {}
    )
    payload_json = _json.dumps({
        "kind": "pricing_key",
        "product_key": product.key,
        "pricing_key": key,
        "values": values,
        "labels": labels,
    })

    row = await db.fetchrow(
        request,
        """WITH deactivated AS (
               UPDATE customer_cost_items SET status='inactive'
               WHERE tenant_id=$1 AND customer_id=$2 AND spec_hash=$3 AND status='active'
           )
           INSERT INTO customer_cost_items
               (tenant_id, customer_id, product_category, product_spec_id,
                product_spec_json, spec_hash, cost_type, amount, currency, unit,
                effective_from, source, notes, created_by)
           VALUES ($1,$2,$4,NULL,$5::jsonb,$3,$6,$7,$8,$9,$10,'manual',$11,$12)
           RETURNING id, amount, unit, effective_from, status""",
        tenant,
        customer_id,
        spec_hash,
        product.name,                    # product_category（同 orchestrator）
        payload_json,
        cost_type,
        float(amount),
        str(body.get("currency") or "CNY").strip(),
        unit,
        effective_from or datetime.now(timezone.utc),   # 列 NOT NULL：不传 = 立即生效
        body.get("notes"),
        str(user["id"]),
        table="customer_cost_items",
    )
    eff = row["effective_from"]
    return {
        "id": row["id"],
        "product_key": product.key,
        "key": key,
        "values": values,
        "amount": float(row["amount"]),
        "unit": row["unit"],
        "effective_from": eff.isoformat() if eff else None,
        "status": row["status"],
    }


@app.patch("/api/v1/pricing-data/{item_id}")
async def update_pricing_data(
    item_id: int,
    request: Request,
    user: dict = Depends(_get_current_user),
):
    """改金额/单位/生效日期/备注（与 orchestrator update_pricing_data 同语义）。

    改「规格组合」请用 POST 建新版本；身份取登录态（tenant/customer 不信任请求体）。
    """
    body = await request.json()
    tenant = quote_api._tenant_of(user)
    customer_id = quote_api._customer_of(user)

    updates: dict = {}
    if "amount" in body:
        amount = body.get("amount")
        if not isinstance(amount, (int, float)) or amount <= 0:
            raise HTTPException(status_code=422, detail="amount must be > 0")
        updates["amount"] = float(amount)
    if "unit" in body:
        unit = str(body.get("unit") or "").strip()
        cost_type = _PRICING_UNIT_TO_COST_TYPE.get(unit)
        if cost_type is None:
            raise HTTPException(status_code=422, detail="unit 取值不合法")
        updates["cost_type"] = cost_type
        updates["unit"] = unit
    if "effective_from" in body:
        updates["effective_from"] = parse_date(body["effective_from"])
    if "effective_to" in body:
        updates["effective_to"] = parse_date(body["effective_to"])
    if "notes" in body:
        updates["notes"] = body["notes"]
    if "status" in body:
        status = str(body["status"]).strip()
        if status not in ("active", "inactive", "deprecated"):
            raise HTTPException(status_code=422, detail="status 取值不合法")
        updates["status"] = status
    if not updates:
        raise HTTPException(status_code=422, detail="No fields to update")

    set_parts = []
    params: list = []
    for i, (col, val) in enumerate(updates.items(), start=1):
        set_parts.append(f"{col} = ${i}")
        params.append(val)
    params += [item_id, tenant, customer_id]
    n = len(updates)
    row = await db.fetchrow(
        request,
        f"""UPDATE customer_cost_items SET {', '.join(set_parts)}
            WHERE id = ${n + 1} AND tenant_id = ${n + 2} AND customer_id = ${n + 3}
            RETURNING id, amount, unit, effective_from, status""",
        *params,
        table="customer_cost_items",
    )
    if row is None:
        raise HTTPException(status_code=404, detail="Pricing data not found")
    eff = row["effective_from"]
    return {
        "id": row["id"],
        "amount": float(row["amount"]),
        "unit": row["unit"],
        "effective_from": eff.isoformat() if eff else None,
        "status": row["status"],
    }


@app.delete("/api/v1/pricing-data/{item_id}")
async def delete_pricing_data(
    item_id: int,
    request: Request,
    user: dict = Depends(_get_current_user),
):
    """停用一条定价数据（软删除，与 orchestrator 同语义：停用即回退产品兜底值）。"""
    row = await db.fetchrow(
        request,
        """UPDATE customer_cost_items SET status = 'inactive'
           WHERE id = $1 AND tenant_id = $2 AND customer_id = $3
           RETURNING id""",
        item_id,
        quote_api._tenant_of(user),
        quote_api._customer_of(user),
    )
    if row is None:
        raise HTTPException(
            status_code=404, detail="Pricing data not found or access denied"
        )
    return {"id": item_id, "status": "inactive"}


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
    request: Request,
    tenant_id: str = "",
    flag_name: str = "",
    user: dict = Depends(_get_current_user),
):
    """读取 feature flags —— 形状是前端消费契约的 `Record<tenant_id, Record<flag, bool>>`。

    前端 gray-release 页读 `flags?.[t.tenant_id]?.["use_v2"]`（page.tsx:45），
    所以**必须**返回「租户号 → {开关: bool}」的映射；旧版这里要求 `flag_name` **必填**、
    只回单值 `{flag_name, flag_value}` ⇒ 灰度页所有开关恒 OFF（real 模式实测症状）。
    worker 是单租户部署：只可能返回 DEFAULT_TENANT 那一项；显式要别的租户 = 不存在 ⇒ 404
    （不泄露存在性，与 orchestrator 同口径）。`flag_name` 参数过渡期保留但不再改变形状。
    """
    _require_platform_ops(user)
    tid = (tenant_id or DEFAULT_TENANT).strip() or DEFAULT_TENANT
    if tid != DEFAULT_TENANT:
        raise HTTPException(
            status_code=404,
            detail={"error": "not_found", "code": "TENANT_NOT_FOUND"},
        )
    rows = await db.fetch(
        request,
        "SELECT flag_name, flag_value FROM feature_flags WHERE tenant_id = $1",
        DEFAULT_TENANT,
    )
    return {
        DEFAULT_TENANT: {
            r["flag_name"]: bool(r["flag_value"]) for r in rows
        }
    }


@app.post("/api/v1/admin/feature_flag")
async def set_feature_flag(body: dict, request: Request, user: dict = Depends(_get_current_user)):
    """功能开关写 DB（orchestrator 写 tenants.yaml，存储差见 UNCERTAIN #13），并记审计。

    兼容两种请求体（与 orchestrator app/api/admin.py:120-134 同口径）：
    - 后端格式: { tenant_id, flag_name, flag_value }
    - 前端格式: { tenant_id, flag_key, enabled, reason, actor_id }
      （gray-release 的 useToggleFeatureFlag 发的是后者，旧版只认 flag_name ⇒ 线上 422）
    """
    _require_platform_ops(user)
    flag_name = str(body.get("flag_name") or body.get("flag_key") or "").strip()
    if not flag_name:
        raise HTTPException(status_code=422, detail="flag_name is required")
    flag_value = bool(
        body["flag_value"] if "flag_value" in body else body.get("enabled", False)
    )
    tenant_id = str(body.get("tenant_id") or DEFAULT_TENANT).strip() or DEFAULT_TENANT
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
    return {
        "tenant_id": tenant_id,
        "flag_name": flag_name,
        "old_value": old_value,
        "new_value": flag_value,
        "flag_value": flag_value,
    }


@app.get("/api/v1/admin/tenants")
async def list_tenants(user: dict = Depends(_get_current_user)):
    _require_platform_ops(user)
    # Worker 单租户形态：tenants.yaml 不可移植，固定返回默认租户（UNCERTAIN #13）。
    # 形状按前端消费契约（tenant-list.tsx:41-49 读 display_name/is_active，不读 name）。
    # ⚠️ 内容**永远 1 条**：这是部署形态决定的，不为"看起来一致"伪造多条（报告 §4.3）。
    return {
        "tenants": [
            {
                "tenant_id": DEFAULT_TENANT,
                "display_name": DEFAULT_TENANT,
                "is_active": True,
            }
        ]
    }


@app.post("/api/v1/admin/tenants/reload")
async def reload_tenants(request: Request, user: dict = Depends(_get_current_user)):
    """租户重载：Worker 无 yaml，仅记审计 no-op（语义差见 docs/CLEANUP_LOG.md）。

    形状按前端消费契约返回**重载后的启用租户清单**（reload-button.tsx:56-66 直接
    `active_tenants.map(...)`）；单租户部署永远 1 条，同样不伪造多条。
    locale/region 用 worker 侧既有口径（见 list_capability_customers 的 zh-CN/CN）。
    """
    _require_platform_ops(user)
    await db.execute(
        request,
        """INSERT INTO feature_flag_audit (action, actor_id, tenant_id, resource_type, reason)
             VALUES ('tenants_reload', $1, $2, 'tenants', 'worker 单租户无 yaml，no-op 记账')""",
        str(user["id"]), DEFAULT_TENANT,
    )
    return {
        "reloaded_count": 1,
        "active_tenants": [
            {
                "tenant_id": DEFAULT_TENANT,
                "display_name": DEFAULT_TENANT,
                "locale": "zh-CN",
                "region": "CN",
                "is_active": True,
            }
        ],
    }


@app.get("/api/v1/admin/audit-log")
async def get_audit_log(
    request: Request,
    page: int = 1,
    page_size: int = 20,
    user: dict = Depends(_get_current_user),
):
    """审计日志（源=feature_flag_audit 表；orchestrator 源=deployment_audit.jsonl）。"""
    _require_platform_ops(user)
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
    _require_platform_ops(user)
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

    async def scheduled(self, controller, env, ctx):
        """Cron Triggers 入口（orchestrator APScheduler 迁移，逻辑全在 ws_cron.py）。

        与 fetch 不同：scheduled 事件没有 request（只有 controller/env/ctx），
        故那条链路按 env 直连 Hyperdrive —— 连接参数与 `_acquire` 逐项一致。
        分派看 `controller.cron`，表达式与 wrangler.jsonc 的 triggers.crons 锁死。
        """
        return await ws_cron.run_scheduled(env, controller)


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


async def _next_customer_doc_no(conn, doc_type: str, table: str,
                                customer: dict, col: str = "doc_no") -> str:
    """统一编号：`类型-国家-客户-时间戳`（同秒冲突加后缀）。"""
    for suffix in range(1, 21):
        candidate = build_number(doc_type, customer, suffix=suffix)
        exists = await conn.fetchval(
            f"SELECT 1 FROM {table} WHERE tenant_id=$1 AND {col}=$2 LIMIT 1",
            DEFAULT_TENANT, candidate,
        )
        if not exists:
            return candidate
    return build_number(doc_type, customer) + "-X"


ORDER_NEXT = {
    "pending": ("confirmed", "cancelled"),
    "confirmed": ("producing", "cancelled"),
    "producing": ("shipped",),
    "shipped": ("completed",),
}


def _order_dict(row) -> dict:
    from kaas_common.workstation.order_serializers import row_to_order
    return row_to_order(dict(row))


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
    """管理员可见全部（三层组织的「管理员」层）。

    判定真源 = 共享内核 `kaas_common.workstation.scope`（与 dev 同一份）：
    角色映射后为 system_admin 即管理员 —— 历史角色 `admin` 一并算作管理员
    （dev 的 effective_role 就是这么映射的；此前 worker 只认字面 system_admin，
    导致同一个 legacy admin 在 /customers 与 /orders 上可见范围不同）。
    """
    return is_admin_role(user.get("role"))


def _owner_visible(user: dict, row) -> bool:
    """三层组织可见性：管理员 / 显式共享 / 我的 / **本团队**（判定真源见共享内核）。"""
    d = dict(row)
    return can_view(
        role=user.get("role"),
        owner_id=d.get("owner_id"),
        owner_scope=d.get("owner_scope"),
        team_id=d.get("team_id"),
        viewer_id=user.get("id"),
        viewer_team_id=user.get("team_id"),
    )


def _check_write_access(user: dict, row):
    """写权限：非管理员只能改自己名下的数据（同团队可见 ≠ 同团队可改）。"""
    d = dict(row)
    if not can_write(role=user.get("role"), owner_id=d.get("owner_id"),
                     viewer_id=user.get("id")):
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
        scope_cond = f"(owner_id = ${len(params)} OR owner_scope = 'tenant'"
        # 三层组织：本团队可见（未分组的用户不加这段，行为与之前一致）
        if user.get("team_id") is not None:
            params.append(user["team_id"])
            scope_cond += f" OR team_id = ${len(params)}"
        where.append(scope_cond + ")")
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


# 订单上的贸易条款（迁移 202609260001 加的正列）：报价谈定的条款要一路传到订单
# 与后续单证，否则信用证审单会出现"单证与合同不一致"的不符点。
_ORDER_TERM_FIELDS = (
    "incoterm", "payment_terms", "port_of_loading", "port_of_destination",
    "shipping_marks", "country_of_origin",
)


def _customer_name_snapshot(body: dict, quote, customer: dict) -> Optional[str]:
    """订单上的客户名快照（与 dev `orders.create_order` 同序）。

    显式传入 > 报价上冻结的名字 > 客户档案当前名 —— 报价优先于档案，
    是因为客户改名之后，**历史订单上的买方名字不该跟着变**（单据要可追溯）。
    """
    name = body.get("customer_name")
    if not name and quote is not None:
        name = quote.get("customer_name")
    return name or customer.get("name")



@app.post("/api/v1/orders", status_code=201)
async def create_order_api(
    request: Request, body: dict, user: dict = Depends(_get_current_user)
):
    """新建订单：**手动新建**（必选业务客户）或**由报价转订单**（落 quote_id）。

    两条路径共用 main 的客户闸门（`_doc_customer`），差别只在父对象：

    | 路径 | 入参 | 落库 |
    |---|---|---|
    | 手动新建 / 导入历史订单 | `customer_id` 必填，`quote_order_id` 可选 | 有报价就写 `quote_id`，没有就只归客户（客户页 `direct` 分组） |
    | 报价转订单 | `quote_order_id`（别名 `quote_id`） | 客户 / 币种 / 金额 / 行项 / 贸易条款从报价继承，写 `orders.quote_id` |

    为什么必须落 `orders.quote_id`：客户页的包含关系树（报价 → 订单 → 单证）
    读的就是这一列；旧 `order_quote_refs` 已改名留档、不再读 ——
    「历史订单全都不在报价下」正是当年只写 refs、缺这一列造成的。
    为什么手动新建也要选客户：约束 `ck_orders_has_customer` 要求新行必须有
    `customer_id`，且客户页按客户聚合订单，没客户的订单等于无处可查。
    """
    items_in = list(body.get("items") or [])
    currency = (body.get("currency") or "").strip().upper()
    # 归属范围走共享内核枚举（与 dev 一致）：非法值 422，不静默退化成 private
    owner_scope = validate_enum("owner_scope", body.get("owner_scope") or "private")

    # 报价来源：dev 用 quote_order_id；任务书/部分调用方写 quote_id —— 同一个对象。
    quote_ref = body.get("quote_order_id")
    if quote_ref in (None, ""):
        quote_ref = body.get("quote_id")

    # 取号在事务内、拿到客户之后：统一编号需要国家 + 客户段
    async with _acquire(request) as conn:
        async with conn.transaction():
            quote = None
            if quote_ref not in (None, ""):
                quote = await _order_source_quote(
                    conn,
                    _as_bigint(quote_ref, field="quote_order_id",
                               code="INVALID_QUOTE_ID"),
                    user,
                )

            raw_customer = body.get("customer_id")
            if raw_customer in (None, "") and quote is not None:
                # 转订单继承报价的客户：客户是报价阶段定下来的，不该让用户再选一次
                raw_customer = quote.get("customer_id")
            customer = await _doc_customer(conn, raw_customer, user, required=True)
            order_no = await _next_customer_doc_no(
                conn, "order", "orders", customer, "order_no")

            if not currency:
                currency = (quote or {}).get("currency") or "USD"
            validate_enum("currency", currency)

            def _term(field: str):
                """贸易条款：本次传入优先，否则从报价继承（报价谈定就不能丢）。"""
                value = body.get(field)
                if value is None and quote is not None:
                    value = quote.get(field)
                return value

            items = items_in
            if not items and quote is not None:
                # 未给行项 → 复制报价行项：否则订单金额与报价对不上，
                # 后面开单证还得手工重录（容易与合同不一致）
                rows = await conn.fetch(
                    "SELECT sku_id, product_name, spec_snapshot, qty, qty_unit,"
                    " unit_price, currency, line_amount, sort_order"
                    " FROM quote_order_items WHERE tenant_id=$1 AND quote_order_id=$2"
                    " ORDER BY sort_order, id",
                    DEFAULT_TENANT, quote["id"],
                )
                # spec_snapshot 是 jsonb：raw conn 取回来可能是字符串，
                # 必须按表解码后再 json.dumps，否则会被二次编码
                items = [row_to_dict(r, "quote_order_items") for r in rows]

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

            row = await conn.fetchrow(
                """INSERT INTO orders
                       (tenant_id, order_no, customer_id, customer_name, status, currency,
                        total_amount, order_date, delivery_date, notes, quote_id,
                        created_by, owner_id, owner_scope, team_id,
                        incoterm, payment_terms, port_of_loading, port_of_destination,
                        shipping_marks, country_of_origin)
                   VALUES ($1,$2,$3,$4,'pending',$5,$6,$7,$8,$9,$10,$11,$11,$12,$13,
                           $14,$15,$16,$17,$18,$19)
                   RETURNING *""",
                DEFAULT_TENANT, order_no, customer["id"],
                # 客户名快照：显式传入 > 报价上冻结的名字（开单当时）> 客户档案当前名。
                # 报价快照优先于客户档案，是因为客户改名后订单上的历史名字不该跟着变。
                _customer_name_snapshot(body, quote, customer),
                currency, total or None, parse_date(body.get("order_date")),
                parse_date(body.get("delivery_date")), body.get("notes"),
                quote["id"] if quote is not None else None,
                str(user["id"]), owner_scope,
                # 单据与客户同团队：管理员替别家团队开单时不能把单据留在自己团队
                customer.get("team_id"),
                _term("incoterm"), _term("payment_terms"), _term("port_of_loading"),
                _term("port_of_destination"), _term("shipping_marks"),
                _term("country_of_origin"),
            )
            order_id = row["id"]
            # 2026-10-18：客户阶段读时由「开启中的订单」推导，不再在这里回写客户阶段。
            for idx, it in enumerate(items):
                await conn.execute(
                    """INSERT INTO order_items
                           (tenant_id, order_id, sku_id, product_name, spec_snapshot,
                            qty, qty_unit, unit_price, currency, line_amount, sort_order)
                       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)""",
                    DEFAULT_TENANT, order_id, it.get("sku_id"), it.get("product_name"),
                    _json.dumps(it["spec_snapshot"])
                    if it.get("spec_snapshot") is not None else None,
                    it.get("qty") if it.get("qty") is not None else 1, it.get("qty_unit"),
                    it.get("unit_price"), (it.get("currency") or currency),
                    computed_lines[idx], it.get("sort_order") or idx,
                )

            if quote is not None:
                # 报价来源关系**不再写 `order_quote_refs`**（该表已随迁移 202610110014
                # 改名 `order_quote_refs_legacy` 留档、只读不写）：`orders.quote_id` 一落，
                # 触发器 `trg_orders_links` 就自动派生 `entity_links` 边 —— 任何写入路径
                # 都绕不过，应用层再手写一份只会制造"两套真相"。
                # 转化即视为接单（dev orders.create_order 同口径）
                await conn.execute(
                    "UPDATE quote_orders SET status='accepted', updated_at=now()"
                    " WHERE tenant_id=$1 AND id=$2",
                    DEFAULT_TENANT, quote["id"],
                )

    # 手工报价台账（quotations 表）转单的事件：仅当调用方给了 quotation_id
    # （那是台账 id，不是 quote_orders.id —— 两者是不同对象，不要混用）
    quotation_id = body.get("quotation_id")
    if quotation_id is not None:
        await _record_business_event(
            request,
            "quotation.converted",
            {
                "quotation_id": str(quotation_id),
                "order_id": str(order_id),
                "customer_id": str(customer["id"]),
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
        " status, owner_id, owner_scope, team_id)"
        " VALUES ($1,$2,$3,$4,$5,$6,'CNY',$7,0,'unpaid',$8,$9,$10)",
        DEFAULT_TENANT, o["id"], o.get("currency") or "USD", total,
        float(rate) if rate is not None else None, o.get("fx_rate_date"), base,
        o.get("owner_id"), o.get("owner_scope") or "private", o.get("team_id")
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
        DEFAULT_TENANT, order_id, target, now
    )
    # 2026-10-18：客户阶段 = 读时按「开启中的订单」推导，订单状态变化后无需回写。
    if target == "confirmed" and o["status"] == "pending":
        rate, rate_date = await _lock_fx_rate(request, o.get("currency") or "USD")
        await db.execute(
            request,
            "UPDATE orders SET fx_rate=$3, fx_rate_date=$4 WHERE tenant_id=$1 AND id=$2",
            DEFAULT_TENANT, order_id,
            float(rate) if rate is not None else None, rate_date
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
        " amount, currency, due_date, notes, status, owner_id, owner_scope, team_id)"
        " VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9,$10,$11) RETURNING *",
        DEFAULT_TENANT, order_id, stype, ratio, amount,
        o.get("currency") or "USD", parse_date(body.get("due_date")),
        body.get("notes") or None, str(user["id"]), o.get("owner_scope") or "private",
        o.get("team_id"),
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
            float(actual_rate) if actual_rate is not None else None, gl, now
        )
        await db.execute(
            request,
            "UPDATE receivables SET received_amount=received_amount+$3,"
            " exchange_gain_loss=COALESCE(exchange_gain_loss,0)+$4,"
            " status=CASE WHEN received_amount+$3>=total_amount THEN 'paid'"
            " ELSE 'partial' END, updated_at=$5 WHERE tenant_id=$1 AND order_id=$2",
            DEFAULT_TENANT, s["order_id"], amt,
            gl if gl is not None else Decimal("0"), now
        )
        # 客户阶段由**订单状态**推导：收款不改客户阶段；确认订单（status=confirmed）时才推导为 won
    else:
        await db.execute(
            request,
            "UPDATE payment_schedules SET due_date=COALESCE($3, due_date),"
            " notes=COALESCE($4, notes), updated_at=$5 WHERE tenant_id=$1 AND id=$2",
            DEFAULT_TENANT, schedule_id, parse_date(body.get("due_date")),
            body.get("notes"), now
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

# ── 单证渲染数据装配（从共享内核 import，消除镜像漂移）──
from kaas_common.trade_doc.payload_shared import (  # noqa: E402
    TRADE_TERM_FIELDS, DOC_NO_FIELDS, item_from_source,
    buyer_block, trade_terms_of, build_render_data as _build_render_data,
    append_audit, protected_custom_fields,
)


def _reject_protected_custom(custom) -> None:
    """手工内容（custom）不得覆盖受保护字段：**金额与行项**只能来自上游快照或系统计算。

    与 orchestrator 同一口径（判定取自共享内核）。背景：装配顺序是
    「上游 → 主体 → 默认条款 → custom 最后覆盖」，custom 能盖掉任何键；
    对外单据的金额若可被手填内容改写，单证与订单就对不上（银行/海关按此项审单）。
    """
    blocked = protected_custom_fields(custom)
    if blocked:
        raise HTTPException(status_code=422, detail={
            "error": "validation", "code": "CUSTOM_FIELD_PROTECTED",
            "fields": blocked,
            "detail": "以下字段只能来自上游快照或系统计算，不接受手工覆盖："
                      + "、".join(blocked),
        })

# 单证装配助手（投影 / 上游快照 / 企业主体区块）—— main 与 ws_docs_ext 共用的唯一实现。
# 历史事故：e5ab56e 删除本文件里的 11KB 镜像实现后调用点没改，运行期 NameError
# （POST/GET/PATCH/render-data 全 500，静态 import 检查发现不了）。详见 doc_payload.py。
import doc_payload as _dp  # noqa: E402

# 边表写入语句来自共享内核（与 orchestrator 同一份字符串，避免两端各写一条而漂移）
from kaas_common.workstation.entity_links import LINK_INSERT_SQL  # noqa: E402


@app.get("/api/v1/trade-docs")
async def list_trade_docs(request: Request, doc_type: str = None, status: str = None,
                          order_id: int = None, page: int = 1, page_size: int = 20,
                          user: dict = Depends(_get_current_user)):
    """单证列表（分页 + doc_type/status/order 筛选）。"""
    where = ["tenant_id = $1"]
    params: list = [DEFAULT_TENANT]
    idx = 2
    if doc_type:
        where.append(f"doc_type = ${idx}"); params.append(doc_type); idx += 1
    if status:
        where.append(f"status = ${idx}"); params.append(status); idx += 1
    if order_id:
        where.append(f"order_id = ${idx}"); params.append(order_id); idx += 1
    where_sql = " AND ".join(where)
    async with _acquire(request) as conn:
        total = await conn.fetchval(f"SELECT COUNT(*) FROM trade_docs WHERE {where_sql}", *params)
        rows = await conn.fetch(
            f"SELECT * FROM trade_docs WHERE {where_sql} ORDER BY created_at DESC, id DESC LIMIT ${idx} OFFSET ${idx+1}",
            *params, page_size, (max(1, page) - 1) * page_size,
        )
        items = []
        for r in rows:
            item = _row_to_dict(r, "trade_docs")
            if r["quote_id"] is not None:
                later = await conn.fetchval(
                    "SELECT 1 FROM trade_docs WHERE tenant_id=$1 AND quote_id=$2"
                    " AND id>$3 LIMIT 1", DEFAULT_TENANT, r["quote_id"], r["id"])
            elif r["order_id"] is not None:
                later = await conn.fetchval(
                    "SELECT 1 FROM trade_docs WHERE tenant_id=$1 AND order_id=$2"
                    " AND id>$3 LIMIT 1", DEFAULT_TENANT, r["order_id"], r["id"])
            else:
                later = None
            item["doc_no_editable"] = not bool(later)
            items.append(item)
    return {
        "items": items,
        "total": total, "page": page, "page_size": page_size,
    }


# ── 单证关系（边表 entity_links）─────────────────────────────────────────────
# 为什么 Worker 也要读/写这张表：`trade_docs` 只有 `order_id` / `quote_id` 两列，
# **询盘来源**与**单证派生源**没有列可挂 —— 触发器（trg_trade_docs_links）只能派生
# 列能表达的关系。这两类关系原先落在 `trade_doc_inquiry_refs` / `trade_doc_doc_refs`，
# 随迁移 202610110014 退场，统一进 `entity_links`（语义与校验见共享内核
# `kaas_common.workstation.entity_links`）。旧表只读不写，新写入一律走下面这两个函数。

async def _insert_doc_links(conn, tenant: str, doc_id: int, targets) -> None:
    """把若干 (dst_type, dst_id, rel_type) 关系写进边表（幂等：重复建立=成功）。

    与 orchestrator `_insert_links` 同一口径；`meta` 为 NULL（Worker 只写询盘来源，
    该关系没有额外属性）—— 若将来要写"派生自哪张单证"，原 `ref_type` 字面量
    （`derived_from`，内核词表里没有）应放进 `meta.origin_ref_type`，见 orchestrator
    的 `_link_ref_type`：读取时才还原得回旧字段值。
    """
    for dst_type, dst_id, rel_type in targets:
        if not dst_id:
            continue          # 空父对象不写边（与旧 refs 表"没有就不写行"一致）
        await conn.execute(
            LINK_INSERT_SQL,
            tenant, "trade_doc", doc_id, dst_type, dst_id, rel_type, None, None,
        )


def _link_ref_type(rel_type, meta) -> str:
    """边 → 旧 refs 的 `ref_type` 字面量（与 orchestrator `_link_ref_type` 同义）。"""
    if isinstance(meta, str):          # jsonb 未解码时可能是字符串
        try:
            meta = _json.loads(meta)
        except ValueError:
            meta = None
    if isinstance(meta, dict) and meta.get("origin_ref_type"):
        return meta["origin_ref_type"]
    return rel_type


async def _doc_upstream_links(conn, doc: dict) -> dict:
    """单证详情用的上游 refs（字段名与旧 refs 表读取**逐字相同**，前端契约不变）。

    优先级：**列**（主归属，权威）> 边表（历史行：迁移 012 刻意跳过了
    `customer_id IS NULL` 的行，它们的报价归属只在边表里，只读列会让关系消失）。
    """
    rows = await conn.fetch(
        "SELECT dst_type, dst_id, rel_type, meta FROM entity_links"
        " WHERE tenant_id=$1 AND src_type='trade_doc' AND src_id=$2"
        "   AND deleted_at IS NULL ORDER BY id",
        DEFAULT_TENANT, doc["id"],
    )
    refs = {"orders": [], "quotes": [], "inquiries": []}
    for r in rows:
        ref_type = _link_ref_type(r["rel_type"], r["meta"])
        if r["dst_type"] == "order":
            refs["orders"].append({"order_id": r["dst_id"], "ref_type": ref_type})
        elif r["dst_type"] == "quote":
            refs["quotes"].append({"quote_order_id": r["dst_id"], "ref_type": ref_type})
        elif r["dst_type"] == "inquiry":
            refs["inquiries"].append({"inquiry_id": r["dst_id"], "ref_type": ref_type})
    # 列有值时以列为准：边表可能还留着被软删以外的历史边，行的归属只有一个
    for key, col, id_key in (("orders", "order_id", "order_id"),
                             ("quotes", "quote_id", "quote_order_id")):
        col_value = doc.get(col)
        if col_value is None:
            continue
        current = next((r for r in refs[key] if r[id_key] == col_value), None)
        refs[key] = [{id_key: col_value,
                      "ref_type": current["ref_type"] if current else "generated_from"}]
    return refs


async def _doc_quote_id(conn, doc: dict):
    """本单证的报价来源：列优先、边表兜底（旧实现读 `trade_doc_quote_refs` LIMIT 1）。"""
    if doc.get("quote_id") is not None:
        return doc["quote_id"]
    row = await conn.fetchrow(
        "SELECT dst_id FROM entity_links"
        " WHERE tenant_id=$1 AND src_type='trade_doc' AND src_id=$2"
        "   AND dst_type='quote' AND deleted_at IS NULL ORDER BY id LIMIT 1",
        DEFAULT_TENANT, doc["id"],
    )
    return row["dst_id"] if row is not None else None


@app.post("/api/v1/trade-docs", status_code=201)
async def create_trade_doc(request: Request, body: dict,
                           user: dict = Depends(_get_current_user)):
    """生成单证（上游快照入 raw_payload 冻结 + refs 溯源，与 dev trade_docs 对齐）。

    **归属规则**（迁移 011 之后新行必须满足）：
    - `customer_id` 必填 —— 缺则 422 `CUSTOMER_REQUIRED`；给了就必须存在、
      未软删、属本团队（否则 404 `CUSTOMER_NOT_FOUND`）。
    - 父对象**可选**：`order_id` 写 `trade_docs.order_id`（PI/CI/PL/BL 的正常路径）；
      只给报价时写 `trade_docs.quote_id`（报价工作台"生成单证"就是这个形态，
      此时报价还没转订单 —— 单证不能因为没订单就从客户页消失）；
      两者都**不给**就只归客户（手动新建 / 导入历史单据的正规路径，读侧进 `direct`）。
    - 两者**同时**给 → 422 `PARENT_CONFLICT`：约束 `ck_doc_single_parent` 要求
      二选一，静默丢掉一个就等于悄悄改了用户的意图。
    - 客户未显式给时从上游快照继承（继承来的同样过闸门 ——
      否则一张别家团队的报价单可以顺着继承把单证建到别家客户名下）。
    """
    doc_type = (body.get("doc_type") or "").strip()
    if doc_type not in DOC_TYPE_SET:
        raise HTTPException(status_code=422, detail={"error": "bad_doc_type"})
    currency = (body.get("currency") or "USD").strip().upper() or "USD"
    validate_enum("currency", currency)

    order_id = _as_bigint(body.get("order_id"), field="order_id",
                          code="INVALID_ORDER_ID")
    # `quote_order_id` 是 dev/前端既有的入参名（报价工作台就用它），
    # `quote_id` 是迁移 010 的列名/任务书叫法 —— 指向同一个对象，取任意一个。
    quote_ref = body.get("quote_id")
    if quote_ref in (None, ""):
        quote_ref = body.get("quote_order_id")
    quote_id = _as_bigint(quote_ref, field="quote_id", code="INVALID_QUOTE_ID")
    inquiry_id = _as_bigint(body.get("inquiry_id"), field="inquiry_id",
                            code="INVALID_INQUIRY_ID")
    if order_id is not None and quote_id is not None:
        raise HTTPException(status_code=422, detail={
            "error": "validation", "code": "PARENT_CONFLICT",
            "detail": ("单证只能挂一个父对象：order_id 与 quote_id 不能同时给"
                       "（约束 ck_doc_single_parent 要求二选一）"),
        })

    async with _acquire(request) as conn:
        async with conn.transaction():
            # 上游快照仍走 platform/db：读的是已提交数据，与本事务的写入无关
            # （快照助手只认 `db` 的 (request, sql, ...) 形状，见 doc_payload.py）。
            payload = {"sources": {}, "custom": body.get("raw_payload") or {}}
            total_amount = None
            customer_id = body.get("customer_id")
            parent_customer_id = None
            if order_id:
                payload["sources"]["order"] = await _dp.order_snapshot(
                    db, request, order_id)
                total_amount = payload["sources"]["order"]["total_amount"]
                parent_customer_id = payload["sources"]["order"].get("customer_id")
                if customer_id in (None, ""):
                    customer_id = parent_customer_id
            if quote_id:
                payload["sources"]["quote"] = await _dp.quote_snapshot(
                    db, request, quote_id)
                if total_amount is None:
                    total_amount = payload["sources"]["quote"]["total_amount"]
                parent_customer_id = (parent_customer_id
                                      or payload["sources"]["quote"].get("customer_id"))
                if customer_id in (None, ""):
                    customer_id = parent_customer_id
            if inquiry_id:
                payload["sources"]["inquiry"] = await _dp.inquiry_snapshot(
                    db, request, inquiry_id)

            # 客户闸门放在**所有继承之后**：手工传的、快照继承来的都要过同一道闸门
            _reject_protected_custom(payload.get("custom"))
            customer = await _doc_customer(conn, customer_id, user, required=True)

            # 一致性：显式客户与父对象的客户必须同一个 —— 否则这张单会
            # 「挂在 A 客户名下、却指向 B 客户的订单」，客户页的树就错位了
            if (parent_customer_id is not None
                    and str(parent_customer_id) != str(customer["id"])):
                raise HTTPException(status_code=422, detail={
                    "error": "validation", "code": "CUSTOMER_MISMATCH",
                    "detail": ("所选客户与上游单据的客户不一致："
                               f"上游属于客户 {parent_customer_id}，"
                               f"请求给的是客户 {customer['id']}"),
                })

            if doc_type == "quotation" and quote_id is not None:
                # 报价单与报价是 1:1（生成报价时已自动产出一张）。
                # 重复"生成"应当拿到同一张，而不是开出第二张 ——
                # 否则客户页会出现两行报价单，两张都可能被当成正式报价单用。
                # 位置放在客户闸门**之后**：否则拿别家团队的 quote_id
                # 就能把对方的报价单读出来（越权读）。
                existing = await conn.fetchrow(
                    "SELECT * FROM trade_docs WHERE tenant_id=$1"
                    " AND doc_type='quotation' AND quote_id=$2 ORDER BY id LIMIT 1",
                    DEFAULT_TENANT, quote_id,
                )
                if existing is not None:
                    return _dp.doc_dict(existing)

            doc_no = await _next_customer_doc_no(
                conn, doc_type, "trade_docs", customer)

            d = await conn.fetchrow(
                "INSERT INTO trade_docs (tenant_id, doc_no, doc_type, order_id,"
                " quote_id, customer_id, status, currency, total_amount,"
                " raw_payload, team_id)"
                " VALUES ($1,$2,$3,$4,$5,$6,'draft',$7,$8,$9,$10) RETURNING *",
                DEFAULT_TENANT, doc_no, doc_type, order_id, quote_id,
                customer["id"], currency, total_amount, _json.dumps(payload),
                # 单据与客户同团队（管理员替别家团队开单时不能留在自己团队）
                customer.get("team_id"),
            )
            # 订单 / 报价关系只写列（上面 INSERT 已完成）：触发器 `trg_trade_docs_links`
            # 自动派生 `entity_links` 边。旧 refs 表已随 202610110014 改名 `_legacy` 留档，
            # 这里不再写 —— 原先那个 for 循环（三张 refs 表）正是"两套真相"的来源。
            # 列表达不了的关系（询盘、派生源）显式写边表：
            await _insert_doc_links(conn, DEFAULT_TENANT, d["id"], (
                ("inquiry", inquiry_id, "generated_from"),
            ))

            # 同一询盘只留一张生效报价：本报价生成后续单证 → 其余报价转 closed
            if quote_id is not None and doc_type != "quotation":
                await conn.execute(
                    "UPDATE quote_orders q SET status='closed', updated_at=now()"
                    " WHERE q.tenant_id=$1 AND q.id<>$2 AND q.status<>'closed'"
                    " AND q.inquiry_id = ("
                    "   SELECT inquiry_id FROM quote_orders"
                    "   WHERE tenant_id=$1 AND id=$2)",
                    DEFAULT_TENANT, quote_id,
                )

    # 事件在事务提交后写（平台 db 是独立连接；放进事务里既不在同一事务，
    # 又会在回滚后留下"单据不存在、事件还在"的脏流水）
    await _record_business_event(
        request, "shipment.documented",
        {"doc_id": d["id"], "doc_no": doc_no, "doc_type": doc_type,
         "order_id": order_id, "quote_id": quote_id, "actor_id": user["id"]},
        from_ws="trade_docs", to_ws="trade_docs",
    )
    return _dp.doc_dict(d)


@app.get("/api/v1/trade-docs/{doc_id}")
async def get_trade_doc(doc_id: int, request: Request,
                        user: dict = Depends(_get_current_user)):
    d = await db.fetchrow(request, "SELECT * FROM trade_docs WHERE tenant_id=$1 AND id=$2",
                          DEFAULT_TENANT, doc_id, table="trade_docs")
    if not d:
        raise HTTPException(status_code=404, detail={"error": "not_found", "code": "DOC_NOT_FOUND"})
    # 上游 refs 一律来自**列 + 边表**（旧 `trade_doc_*_refs` 已改名留档、不再读）
    async with _acquire(request) as conn:
        refs = await _doc_upstream_links(conn, d)
        if d["quote_id"] is not None:
            later = await conn.fetchval(
                "SELECT 1 FROM trade_docs WHERE tenant_id=$1 AND quote_id=$2"
                " AND id>$3 LIMIT 1", DEFAULT_TENANT, d["quote_id"], doc_id)
        elif d["order_id"] is not None:
            later = await conn.fetchval(
                "SELECT 1 FROM trade_docs WHERE tenant_id=$1 AND order_id=$2"
                " AND id>$3 LIMIT 1", DEFAULT_TENANT, d["order_id"], doc_id)
        else:
            later = None
    return {**_dp.doc_dict(d), "refs": refs,
            "doc_no_editable": not bool(later)}


@app.patch("/api/v1/trade-docs/{doc_id}")
async def update_trade_doc(doc_id: int, request: Request, body: dict,
                           user: dict = Depends(_get_current_user)):
    d = await db.fetchrow(request, "SELECT * FROM trade_docs WHERE tenant_id=$1 AND id=$2",
                          DEFAULT_TENANT, doc_id, table="trade_docs")
    if not d:
        raise HTTPException(status_code=404, detail={"error": "not_found", "code": "DOC_NOT_FOUND"})
    d = _dp.doc_dict(d)
    new_doc_no = None
    requested_no = body.get("doc_no")
    if requested_no is not None and requested_no != d["doc_no"]:
        try:
            new_doc_no = normalize_number(requested_no)
        except NumberError as exc:
            raise HTTPException(status_code=422, detail={
                "error": "validation", "code": "INVALID_DOC_NO",
                "detail": str(exc),
            })
        if d.get("quote_id") is not None:
            later = await db.fetchval(
                request,
                "SELECT 1 FROM trade_docs WHERE tenant_id=$1 AND quote_id=$2"
                " AND id>$3 LIMIT 1",
                DEFAULT_TENANT, d["quote_id"], doc_id,
            )
        elif d.get("order_id") is not None:
            later = await db.fetchval(
                request,
                "SELECT 1 FROM trade_docs WHERE tenant_id=$1 AND order_id=$2"
                " AND id>$3 LIMIT 1",
                DEFAULT_TENANT, d["order_id"], doc_id,
            )
        else:
            later = None
        if later:
            raise HTTPException(status_code=409, detail={
                "error": "conflict", "code": "DOC_NO_LOCKED",
                "detail": "同一链条上已生成更晚的单证，本单编号已锁定",
            })
        taken = await db.fetchval(
            request,
            "SELECT 1 FROM trade_docs WHERE tenant_id=$1 AND doc_no=$2"
            " AND id<>$3 LIMIT 1",
            DEFAULT_TENANT, new_doc_no, doc_id,
        )
        if taken:
            raise HTTPException(status_code=409, detail={
                "error": "conflict", "code": "DOC_NO_TAKEN",
                "detail": f"单证编号「{new_doc_no}」已被占用，请换一个",
            })
    new_status = (body.get("status") or d["status"]).strip()
    allowed = DOC_NEXT.get(d["status"], ())
    if new_status != d["status"] and new_status not in allowed:
        raise HTTPException(status_code=409, detail={
            "error": "conflict", "code": "ILLEGAL_TRANSITION",
            "field": "status", "from": d["status"], "to": new_status,
            "allowed": list(allowed),
        })
    # P0 引用完整性（HARDENING_PLAN §D，与 dev trade_docs.update_trade_doc 同口径）：
    # 作废前必扫引用方 —— 下游 issued 单证还引用着本单证时不允许静默作废
    # （导出会引用已废单据，信用证审单是不符点）。清单随 409 返回。
    if new_status == "void" and d["status"] != "void":
        broken = await db.fetch(
            request,
            "SELECT d.id, d.doc_no, d.doc_type, d.status, l.rel_type"
            " FROM entity_links l"
            " JOIN trade_docs d ON d.tenant_id = l.tenant_id AND d.id = l.src_id"
            " WHERE l.tenant_id=$1 AND l.dst_type='trade_doc' AND l.dst_id=$2"
            " AND l.src_type='trade_doc' AND l.deleted_at IS NULL"
            " AND d.status='issued' ORDER BY d.id",
            DEFAULT_TENANT, doc_id,
        )
        if broken:
            raise HTTPException(status_code=409, detail={
                "error": "conflict", "code": "DOC_REF_BROKEN",
                "detail": "以下已签发单证仍引用本单证，请先作废/改版它们",
                "broken_refs": broken,
            })
    now = datetime.now(timezone.utc)
    raw_payload = body.get("raw_payload")
    if raw_payload is not None and d["status"] != "draft":
        raise HTTPException(status_code=409, detail={
            "error": "conflict", "code": "PAYLOAD_LOCKED",
            "detail": "issued 后单证内容锁定，不可修改",
        })
    if raw_payload is not None:
        new_custom = (raw_payload or {}).get("custom") or {}
        _reject_protected_custom(new_custom)
        # 审计留痕（谁在什么时候改了什么）：从**库里的旧 payload** 续写；
        # 客户端自带的 `_audit` 一律丢弃 —— 否则调用方能伪造或清空自己的审计。
        raw_payload = append_audit(
            raw_payload,
            previous_payload=d.get("raw_payload") or {},
            actor_id=str(user["id"]),
            before_custom=(d.get("raw_payload") or {}).get("custom") or {},
            after_custom=new_custom,
            at=now.isoformat(),
        )
    if new_status == "issued" and d["status"] == "draft":
        await db.execute(
            request,
            "UPDATE trade_docs SET status=$3, issued_at=$4, issued_by=$5,"
            " raw_payload=COALESCE($6, raw_payload), updated_at=$7,"
            " doc_no=COALESCE($8, doc_no)"
            " WHERE tenant_id=$1 AND id=$2",
            DEFAULT_TENANT, doc_id, new_status, now, user["id"],
            _json.dumps(raw_payload) if raw_payload is not None else None, now,
            new_doc_no,
        )
    else:
        await db.execute(
            request,
            "UPDATE trade_docs SET status=$3, raw_payload=COALESCE($4, raw_payload),"
            " updated_at=$5, doc_no=COALESCE($6, doc_no)"
            " WHERE tenant_id=$1 AND id=$2",
            DEFAULT_TENANT, doc_id, new_status,
            _json.dumps(raw_payload) if raw_payload is not None else None, now,
            new_doc_no,
        )
    d2 = await db.fetchrow(request, "SELECT * FROM trade_docs WHERE tenant_id=$1 AND id=$2",
                           DEFAULT_TENANT, doc_id, table="trade_docs")
    return _dp.doc_dict(d2)


# ── 企业主体信息（卖方抬头）────────────────────────────────────────────────
# 为什么需要：对外单据第一行是卖方信头（英文公司名/地址/联系方式），
# PI/合同/汇票还要收款银行与 SWIFT。没有它，每张单据抬头都是空白、每次都要手填。
# 保存一次，所有单据自动带入。

_COMPANY_FIELDS = ("name_en", "name_zh", "address_en", "address_zh", "phone", "email",
                   "website", "bank_name", "bank_account", "swift_code", "logo_url",
                   "default_incoterm", "default_payment_terms", "default_country_of_origin")


async def _require_team_admin(request: Request, user: dict) -> None:
    """企业抬头/公章写入权限：团队管理员或平台管理员（用户 2026-10-18 口径）。"""
    from kaas_common.workstation.scope import is_admin_role
    from kaas_common.workstation.teams import is_team_admin
    if is_admin_role(user.get("role")):
        return
    team_id = user.get("team_id")
    if team_id is None:
        raise HTTPException(status_code=403, detail={
            "error": "forbidden", "code": "TEAM_ADMIN_REQUIRED",
            "detail": "仅团队管理员可修改企业抬头/收款信息/公章",
        })
    row = await db.fetchrow(
        request, "SELECT created_by FROM teams WHERE id=$1", team_id, table="teams",
    )
    if row is None or not is_team_admin(
        row.get("created_by"), user.get("id"), user.get("role"),
    ):
        raise HTTPException(status_code=403, detail={
            "error": "forbidden", "code": "TEAM_ADMIN_REQUIRED",
            "detail": "仅团队管理员可修改企业抬头/收款信息/公章",
        })



@app.get("/api/v1/tenant/company-profile")
async def get_company_profile(request: Request, user: dict = Depends(_get_current_user)):
    row = await db.fetchrow(
        request, "SELECT * FROM tenant_company_profile WHERE tenant_id=$1",
        DEFAULT_TENANT, table="tenant_company_profile",
    )
    # 未配置时返回空结构而不是 404：前端表单可直接绑定，不会把页面变成错误页
    if not row:
        return {**{f: None for f in _COMPANY_FIELDS}, "configured": False}
    r = row
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
    # 权限：团队管理员（或平台管理员）才能改企业抬头
    await _require_team_admin(request, user)
    # SWIFT 编码：8/11 位字母数字（用户 2026-10-18 要求）
    from kaas_common.workstation.company_rules import SwiftError, normalize_swift
    try:
        swift_code = normalize_swift(body.get("swift_code"))
    except SwiftError as exc:
        raise HTTPException(status_code=422, detail={
            "error": "validation", "code": "INVALID_SWIFT",
            "detail": str(exc),
        })
    # 逐字段覆盖（含 NULL）：允许把填错的字段清空，而不是"擦不掉"
    values = [
        swift_code if f == "swift_code"
        else (body.get(f) if f != "name_en" else name_en)
        for f in _COMPANY_FIELDS
    ]
    cols = ", ".join(_COMPANY_FIELDS)
    placeholders = ", ".join(f"${i + 2}" for i in range(len(_COMPANY_FIELDS)))
    updates = ", ".join(f"{f}=EXCLUDED.{f}" for f in _COMPANY_FIELDS)
    await db.execute(
        request,
        f"INSERT INTO tenant_company_profile (tenant_id, {cols}) VALUES ($1, {placeholders})"
        f" ON CONFLICT (tenant_id) DO UPDATE SET {updates}, updated_at=now()",
        DEFAULT_TENANT, *values
    )
    return await get_company_profile(request, user)


# ── 默认公章带入（单据没显式给 company_stamp 时的回落）────────────────────────
# 判定（字段名/覆盖优先级/空值处理）在**共享内核**：G1 只允许一份 ——
# `kaas_common/files/seal.py`（与 orchestrator 同一份，sync-shared.ps1 镜像到
# worker/src/kaas_common）。表/列以 `ws_seals.py` 为准：`tenant_company_seals.png_bytes`
# + `is_default`。请求期才读库（`db.fetchrow(request, ...)`），import 期不读绑定/环境。
#
# 覆盖优先级：
#   1. 单据 `custom` 显式含 `company_stamp`（含空串）⇒ 不覆盖；
#   2. 否则租户默认章（`is_default`）转 `data:` URI 填入；
#   3. 都没有 ⇒ 不注入、不伪造空图。
# 本文件只保留"怎么取到默认章那一行"（本侧走请求期 db.fetchrow）。
from kaas_common.files.seal import apply_default_seal  # noqa: E402


def _seal_tenant_of(user) -> str:
    """公章**写入侧**的租户口径（与 `ws_seals._tenant_of` 一致）：账号 tenant_id，缺省 DEFAULT_TENANT。"""
    tid = (user or {}).get("tenant_id")
    return tid if isinstance(tid, str) and tid else DEFAULT_TENANT


async def _apply_default_seal(request: Request, user: dict, data: dict, custom) -> dict:
    """装配层最后一步：只在单据**没**显式给 `company_stamp` 时才查库（省无谓查询）。"""
    if isinstance(custom, dict) and "company_stamp" in custom:
        return data
    row = await db.fetchrow(
        request,
        "SELECT png_bytes, mime FROM tenant_company_seals"
        " WHERE tenant_id=$1 AND is_default ORDER BY id LIMIT 1",
        _seal_tenant_of(user),
    )
    return apply_default_seal(data, custom, row)


# ── 产品基础信息带入（一次维护、重复使用）────────────────────────────────────
# 判定（填哪些字段/覆盖优先级/空值处理）在**共享内核**：G1 只允许一份 ——
# `kaas_common/trade_doc/product_defaults.py`（sync-shared.ps1 镜像同一份）。
# 本文件只保留"怎么取到产品档案"（本侧走请求期 `db.fetchrow`），并做**注册表校验**：
# 注册表（代码里的 ProductSpec）才是"有哪些产品"的唯一来源，info 只是它的补充。
# 租户口径用 DEFAULT_TENANT：产品档案的**写入侧**（ws_files.py 的 profile 端点）就是
# 这个口径 —— 读侧跟着写入侧走，才不会"写给 default、只查 tenant-x"而读不到。
from kaas_common.trade_doc.product_defaults import (  # noqa: E402
    apply_product_defaults, product_key_of,
)


async def _product_info_of(request: Request, product_key: str, user: dict = None):
    """产品档案 `info`；产品不在注册表 / 没维护过 / 无权看 → None。

    团队谓词（2026-10-12，task-6）：按 `product_info_access`（共享内核
    `kaas_common/workstation/product_scope.py`）判定可见性 ——
    本团队行可读 / 别团队行 404 / 历史 `team_id IS NULL` 仅管理员。
    与 orchestrator 的 `trade_docs.py` 同款谓词同源，不另写一套。
    """
    from kaas_common.export_quote.products import has as _has_product  # 惰性：不拖累模块加载
    if not _has_product(product_key):
        return None
    row = await db.fetchrow(
        request,
        "SELECT info, team_id FROM product_profiles WHERE tenant_id=$1 AND product_key=$2",
        DEFAULT_TENANT, product_key, table="product_profiles",
    )
    if row is None:
        return None
    # 团队可见性判定（复用共享内核，与 orchestrator/files.py 同源）
    if user is not None:
        from kaas_common.workstation.product_scope import product_info_access
        decision = product_info_access(
            role=user.get("role"),
            viewer_team_id=user.get("team_id"),
            row_team_id=row.get("team_id"),
        )
        if not decision.allowed:
            return None
    info = row["info"]
    # Workers 环境的 asyncpg 会把 jsonb 返回成 str（`product_profiles` 目前**未**登记进
    # dbjson.JSONB_COLS，`table=` 解码对它不生效）—— 两种形状都收，避免"字段在、
    # 值是字符串"导致本功能静默不生效。
    if isinstance(info, str):
        try:
            info = _json.loads(info)
        except (TypeError, ValueError):
            return None
    return dict(info) if isinstance(info, dict) else None


async def _apply_product_defaults(request: Request, doc_type: str, data: dict, custom,
                                  user: dict = None) -> dict:
    """装配层：单据**显式关联了产品**才查档案（没关联 → 一次查询都不发，回归旧行为）。"""
    key = product_key_of(custom)
    if not key:
        return data
    info = await _product_info_of(request, key, user=user)
    return apply_product_defaults(data, custom, doc_type, info)


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
    doc = _dp.doc_dict(d)

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
            buyer = _dp.buyer_block_of(customer, contact)

    data = _build_render_data(
        doc_type=doc["doc_type"], doc_no=doc["doc_no"],
        # doc_status 是共享内核的**必填**关键字参数（无默认值）：漏传就是
        # TypeError → render-data 生产 500。orchestrator 传的是 d.status。
        doc_status=doc.get("status"),
        currency=doc.get("currency") or "USD",
        total_amount=doc.get("total_amount"),
        created_at=doc.get("created_at"), issued_at=doc.get("issued_at"),
        seller=_dp.seller_block(profile), buyer=buyer,
        bank_info=_dp.seller_block(profile),
        sources=sources,
        trade_terms={f: upstream.get(f) for f in TRADE_TERM_FIELDS
                     if _dp.clean(upstream.get(f)) is not None},
        custom=custom,
        defaults={
            "incoterm": profile_dict.get("default_incoterm"),
            "payment_terms": profile_dict.get("default_payment_terms"),
            "country_of_origin": profile_dict.get("default_country_of_origin"),
        },
    )
    # 单证引用产品图：把 `{file_id}` 解析成图片源（装配层做，渲染器一行不改）
    import ws_files as _ws_files  # 模块在文件末尾导入，函数内惰性引用
    data = await _ws_files.resolve_photo_refs(request, data, user=user)
    # 单据没显式给 company_stamp → 自动带出租户默认公章（同样转 data URI）
    data = await _apply_default_seal(request, user, data, custom)
    # 单据关联了产品 → 把产品档案的基础信息补进仍为空的行项（见共享内核 product_defaults）
    data = await _apply_product_defaults(request, doc["doc_type"], data, custom, user=user)
    return {
        "doc": doc,
        "data": data,
        # 企业主体未配置时明确告知，避免用户对着空白抬头单据猜原因
        "company_profile_configured": bool(profile_dict.get("name_en")),
    }


import chain  # noqa: E402,F401

# ── 报价工位（/api/v1/export-quote/* · /api/v1/quotes · /api/v1/quote-profiles）──
# 与 chain 同一挂载方式：复用本模块的 app / _get_current_user / db 连接封装。
# 位置放在 chain 之后，保持"先核心工位链、后业务工位"的挂载顺序。
import quote_api  # noqa: E402,F401

# ── 汇率 / 实际采购成本 / 外部单证上传 ──
import ws_extras  # noqa: E402,F401

# ── 产品定义配置化 + 报价工位权限矩阵 / 公司公章 ──
# 与 orchestrator 的 tenant_products.py / workstation_products.py / company_seals.py 对齐。
# 为什么必须补：这三个接口族此前只在 orchestrator 落地，前端页面一上生产就 404。
import ws_products  # noqa: E402,F401
import ws_seals  # noqa: E402,F401

# ── 客户 / 订单 / 报价 / 单证 四域的剩余缺口 ──
# 依据「前端实际调用 → 生产路由」对照确定（scripts/route-parity.py 是路由面的棘轮）。
# 单证枚举（单证页下拉）、自有出运台账（/shipments 页）—— 线上会 404 的真实缺口。
import ws_enums  # noqa: E402,F401
import ws_shipments  # noqa: E402,F401
import ws_quote_ext  # noqa: E402,F401
import ws_option_overrides  # noqa: E402,F401
import ws_crm_ext  # noqa: E402,F401
import ws_docs_ext  # noqa: E402,F401

# ── 团队（三层组织）管理 ──
# 团队是生产端"公司级隔离"的那一层（Worker 是单租户部署，账号之间没有 tenant 隔离）。
import ws_teams  # noqa: E402,F401

# ── 工位订阅：开通/撤销 + 未开通拦截 ──
# 授权边界是"这个团队/个人开通了哪些工位"，不以租户鉴权（见 docs/TEAMS_AND_VISIBILITY.md）。
import ws_workstations  # noqa: E402,F401

# ── 平台账号治理（列表/停用/恢复，无物理删除）──
# 与 orchestrator `app/api/admin_accounts.py` 同路径同契约（route-parity 强制）。
import ws_admin_accounts  # noqa: E402,F401

# ── 属性沉淀提案（平台运营审核：列表/推荐/approve·reject·merge）──
# 前端 admin/spec-proposals 页面在调，过去生产 404（route-parity 缺口清单遗留项）。
import ws_admin_proposals  # noqa: E402,F401

# ── 业务客户往来记录（报价/订单/单证 包含关系树）──
import ws_customer_records  # noqa: E402,F401

# ── 文件域 + 产品媒体（产品图/盖章回传/PDF 归档）──
# 契约真源：orchestrator `app/api/files.py`；本文件是生产镜像（本地新加路由必须同步，
# 否则线上 404 —— 见 docs/ROUTE_PARITY_2026-10-10.md）。
# 字节落点：R2 binding（`FILES`，见 wrangler.jsonc）优先，异常自动回退 inline 并如实记录
# `file_objects.storage`，不让用户的上传因为存储配置问题直接失败。
import ws_files  # noqa: E402,F401
import tax_archives  # noqa: E402,F401

# ── Cloudflare Cron 定时任务（APScheduler 迁移 · README §8 已知问题 #5）──
# orchestrator 里那两个 APScheduler 任务（每 15 分钟 replied→询盘扫描、每日 events 归档）
# 在生产从未执行过（orchestrator 不常驻）。这里用 CF Cron 重建：
#   · 表达式在 wrangler.jsonc 的 triggers.crons（UTC）；
#   · 逻辑全在 ws_cron.py（纯 asyncpg，连接口径同本文件 _acquire）；
#   · 由上面的 `Default.scheduled` 按 controller.cron 分派。
# 注意：ws_cron 在「文件末尾」import，是 sibling 路由模块的同一挂载约定；scheduled
# 方法体内是调用期引用，不受 import 顺序影响。
import ws_cron  # noqa: E402,F401
