"""P2 引擎 RPC（内核纯算入口）：门面供数 → Python 纯算，内核**不连库**。

设计 = docs/P2_COUPLING_ENGINE_2026-10-24.md §6（契约草案）/ §8（首个切片）+
docs/ARCH_AUTH_DB_SPLIT_2026-10-24.md §3.4 / §10。

铁纪律（AGENTS.md + ADR-008）：
- 本模块**只做接线**：验内部 JWT → 把 payload 的 request 交给与旧路径**同一个**
  pydantic 模型 → 调 quote_api 里**同一个**算子（calculate/verify/formulas/spec/
  explain 五个 action 各自的"自取数 handler + 供数 RPC"共用同一份实现；explain 是
  直接复用既有 async handler + 请求级产品定义注入，见 quote_api.explain_from_datasets）。
  不新增任何业务判定，连**角色闸门**（verify 的管理员判定）也是调用
  quote_api._require_internal_admin —— 禁止在新入口另写一份（docs §8.5.2 的教训）。
- 数据一律来自 payload["datasets"]（门面已按旧 SQL 谓词/排序查好）；本模块**禁止**
  使用 main._acquire / platform.db / asyncpg（tests 里用「零 DB 调用」用例锁死）。
- 鉴权沿用 mintInternalJwt 口径（HS256 / 同一把 JWT_SECRET / TTL 60s），另加 claim
  kaas_internal="engine" —— 普通用户会话 JWT 与内部 JWT 同一把 secret，不加这个 claim
  就无法区分，任何用户 JWT 都能被打到 /internal/engine/*（纵深防御，成本为零）。
- 响应信封 {status, body}：body 是该端点**原本**会返回的响应体（4xx 也要逐字保留
  {"detail": ...}），门面按 status 原样回放。HTTP 恒 200（除鉴权/形状错误）。
"""
from __future__ import annotations

import inspect

from fastapi import HTTPException, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError

import main as _main
import quote_api as _quote

app = _main.app

# ── 内部令牌口径（与 backend/ts-worker/src/proxy.ts mintEngineJwt 逐字对应）──
INTERNAL_ENGINE_CLAIM = "kaas_internal"
INTERNAL_ENGINE_VALUE = "engine"

# 内部令牌必须携带的角色快照 claims（role/account_type/team_id/is_tenant_admin/tenant_id）：
# 判定依据必须受签名保护，不能来自 payload（见 _engine_actor）。


def _unauthorized(message: str) -> HTTPException:
    return HTTPException(status_code=401, detail={
        "error": "unauthorized", "message": message})


def _engine_actor(request: Request) -> dict:
    """验内部 JWT 并从 claims 重建 actor dict（**不查 users 表**）。

    与 main._get_current_user 的区别只有一个：用户行不再查库 —— 角色快照由门面
    在铸令牌时写入 claims（见 src/proxy.ts mintEngineJwt）。
    """
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        raise _unauthorized("Authentication required")
    # _decode_token 已校验签名与 exp（非法/过期统一 401 同既有信封）
    payload = _main._decode_token(auth[7:], request)
    if payload.get(INTERNAL_ENGINE_CLAIM) != INTERNAL_ENGINE_VALUE:
        raise _unauthorized("Invalid internal token")
    try:
        user = {
            "id": int(payload["sub"]),
            "tenant_id": str(payload.get("tenant_id") or _main.DEFAULT_TENANT),
            "team_id": payload.get("team_id"),
            "role": payload.get("role"),
            "account_type": payload.get("account_type"),
            "is_tenant_admin": bool(payload.get("is_tenant_admin")),
        }
    except (KeyError, TypeError, ValueError):
        raise _unauthorized("Invalid internal token")
    if payload.get("role") is None or payload.get("account_type") is None:
        # 门面铸令牌漏字段 = 契约违约，不猜默认值（宁可 401 暴露问题）
        raise _unauthorized("Invalid internal token")
    return user


def _payload_invalid(message: str) -> HTTPException:
    return HTTPException(status_code=400, detail={
        "error": "engine_rpc_payload_invalid", "message": message})


def _envelope(result) -> dict:
    return {"status": 200, "body": result}


def _error_envelope(exc: HTTPException) -> dict:
    """把业务 HTTPException 原样装进信封：门面按 status + {"detail": detail} 回放。"""
    return {"status": exc.status_code, "body": {"detail": exc.detail}}


# ── 通用 payload 信封（§6.3）→ 各 action 的内核算子 ─────────────────────────


def _payload(request: Request, body: dict) -> tuple:
    """验内部 JWT + 交叉核对 actor + 取出 (user, request, datasets)。

    401（令牌）/ 400 engine_rpc_payload_invalid（**实现 bug**，不是用户输入错误）
    直接抛 HTTPException、**不装信封**：门面据此区分「RPC 不可用」与「业务 4xx」。
    签名里的身份才是真身份，payload 自报的 actor 只用于交叉核对。
    """
    user = _engine_actor(request)
    body = body if isinstance(body, dict) else {}
    actor = body.get("actor")
    if not isinstance(actor, dict):
        raise _payload_invalid("actor 必须是对象")
    if str(actor.get("id")) != str(user["id"]) or actor.get("team_id") != user["team_id"]:
        raise _payload_invalid("actor 与内部令牌不一致")
    datasets = body.get("datasets")
    if not isinstance(datasets, dict):
        raise _payload_invalid("datasets 必须是对象")
    request_body = body.get("request")
    if not isinstance(request_body, dict):
        raise _payload_invalid("request 必须是对象")
    return user, request_body, datasets


async def _dispatch(fn, *args) -> dict:
    """调内核算子并把结果装进 {status, body} 信封（4xx/422 逐字保留）。

    算子是**同步纯函数**（calculate/verify/formulas/spec）或**协程**（explain 复用
    既有 async handler —— 见 quote_api.explain_from_datasets 的说明）。
    """
    try:
        result = fn(*args)
        if inspect.isawaitable(result):
            result = await result
        return _envelope(result)
    except HTTPException as exc:
        # 业务错误（400 engine_error / 403 / 409 …）必须逐字回放：门面侧不重建
        # pydantic/FastAPI 的错误体。
        return _error_envelope(exc)
    except RequestValidationError as exc:
        # 请求体/query 校验失败（同一份 pydantic 模型）：与旧路径 FastAPI 的 422
        # 信封逐字一致 —— 同一份错误 + 框架自己的 jsonable_encoder。
        return {"status": 422, "body": {"detail": jsonable_encoder(exc.errors())}}


def _request_str(request_body: dict, key: str) -> str:
    value = request_body.get(key)
    if not isinstance(value, str) or not value:
        raise _payload_invalid("request." + key + " 必须是非空字符串")
    return value


@app.post("/api/v1/internal/engine/quote/calculate")
async def engine_quote_calculate(request: Request, body: dict):
    """算价 RPC：payload.request + payload.datasets → 与 /export-quote/calculate 同结果。

    payload 形状见 docs/P2_COUPLING_ENGINE_2026-10-24.md §6.3；
    datasets 由门面按**旧 SQL 谓词与 ORDER BY** 查好（契约 §6.3 三条硬规则）。
    """
    user, request_body, datasets = _payload(request, body)
    return await _dispatch(_quote.calculate_from_datasets, request_body, datasets, user)


@app.post("/api/v1/internal/engine/quote/verify")
async def engine_quote_verify(request: Request, body: dict):
    """核验 RPC：→ 与 POST /export-quote/verify 同结果（**含同一份管理员闸门**）。"""
    user, request_body, datasets = _payload(request, body)
    return await _dispatch(_quote.verify_from_datasets, request_body, datasets, user)


@app.post("/api/v1/internal/engine/quote/formulas")
async def engine_quote_formulas(request: Request, body: dict):
    """计算说明书 RPC：→ 与 GET /export-quote/products/{key}/formulas 同结果。

    request = {"product_key": str, "query": {原始 query 字符串}}：GET 端点没有
    请求体，query 参数的解析/校验仍在内核（与旧路径同一份 pydantic 口径）。
    """
    user, request_body, datasets = _payload(request, body)
    product_key = _request_str(request_body, "product_key")
    params = request_body.get("query")
    if params is None:
        params = {}
    if not isinstance(params, dict):
        raise _payload_invalid("request.query 必须是对象")
    return await _dispatch(_quote.formulas_from_datasets, product_key, params, datasets, user)


@app.post("/api/v1/internal/engine/quote/spec")
async def engine_quote_spec(request: Request, body: dict):
    """产品定义 RPC：→ 与 GET /export-quote/products/{key}/spec 同结果。"""
    user, request_body, datasets = _payload(request, body)
    product_key = _request_str(request_body, "product_key")
    return await _dispatch(_quote.spec_from_datasets, product_key, datasets, user)


@app.post("/api/v1/internal/engine/quote/explain")
async def engine_quote_explain(request: Request, body: dict):
    """逐步代入（计算说明书）RPC：→ 与 POST /export-quote/products/{key}/explain 同结果。

    request = {"product_key": str, "body": <该端点原始请求体，逐字>}：
    产品 key 在路径上，正文是"给一组规格取值"的 pydantic 模型（同一份 _ExplainIn）。
    """
    user, request_body, datasets = _payload(request, body)
    product_key = _request_str(request_body, "product_key")
    explain_body = request_body.get("body")
    if not isinstance(explain_body, dict):
        raise _payload_invalid("request.body 必须是对象")
    return await _dispatch(
        _quote.explain_from_datasets, product_key, explain_body, datasets, user, request)
