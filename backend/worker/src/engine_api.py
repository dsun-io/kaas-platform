"""P2 引擎 RPC（内核纯算入口）：门面供数 → Python 纯算，内核**不连库**。

设计 = docs/P2_COUPLING_ENGINE_2026-10-24.md §6（契约草案）/ §8（首个切片）+
docs/ARCH_AUTH_DB_SPLIT_2026-10-24.md §3.4 / §10。

铁纪律（AGENTS.md + ADR-008）：
- 本模块**只做接线**：验内部 JWT → 把 payload 的 request 交给与旧路径**同一个**
  pydantic 模型 → 调内核里**同一个**算子。已落地两组：
  · quotes 域（calculate/verify/formulas/spec/explain）→ quote_api 的 *_from_datasets；
  · trade-docs 域（render-data）→ main.render_data_from_datasets（装配 = 旧 handler
    同一份 _render_bundle_pure；见 main.py 的「P2 第三个切片」注释）。
  不新增任何业务判定，连**角色/可见性闸门**（verify 的管理员判定、render-data 的
  _require_doc_visible）也是调用既有那一份 —— 禁止在新入口另写一份（docs §8.5.2 的教训）。
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
import logging
from types import SimpleNamespace

from fastapi import HTTPException, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError

import main as _main
import quote_api as _quote
import ws_docs_hardening as _docs_hardening

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

# ═══════════════════════════════════════════════════════════════════════════════
# 第三个切片：GET /api/v1/trade-docs/{doc_id}/render-data（7 张表的装配链）
# ═══════════════════════════════════════════════════════════════════════════════
# 设计 = docs/P2_COUPLING_ENGINE_2026-10-24.md §6.3/§9 第 2 项。
# 契约要点（与 quotes 域不同）：
# - datasets 由门面按 main._render_dataset_plan 的**最小集合**供数；条件取数（有无客户/
#   照片/公章/产品档案）由门面按**数据形状**决定，判定本身仍在内核同一份纯装配里；
# - 图片/公章是短期签名直链 ⇒ 需要「原请求的 host/proto」参与签名：门面放在
#   payload.request.request_context（host / x_forwarded_proto）；
# - 签名不可用（无 JWT_SECRET）⇒ 明确 503，绝不静默返回与旧路径不同的图片（已登记边界）。

#: 签名直链的 host 白名单（host 参与签名 ⇒ 不能让任意 Host 进 payload）
_TRUSTED_HOSTS = frozenset({
    "kaas.powervoy.com", "api.kaas.powervoy.com",
    # dev / 测试宿主（TestClient 的默认 host 是 testserver；生产不可达）
    "localhost", "127.0.0.1", "testserver",
})
_TRUSTED_HOST_SUFFIXES = (".kaas.powervoy.com",)
#: 白名单外回落的默认 host（生产门面域名）
_DEFAULT_ASSET_HOST = "kaas.powervoy.com"


class _UrlRequestView:
    """只提供 _public_base / _asset_url / _jwt_secret 需要的请求视图（签名 URL 用）。

    为什么需要：签名直链的 host 必须是**用户实际访问的门面域名**，而 RPC 的请求
    是 Service Binding 打到内核的（host 是内核）—— 不能直接拿它去签名。
    """

    def __init__(self, request: Request, host: str, proto: str):
        self.headers = {"host": host, "x-forwarded-proto": proto}
        self.url = SimpleNamespace(scheme=proto)
        self.scope = dict(getattr(request, "scope", {}) or {})


def _host_allowed(host: str) -> bool:
    name = host.strip().lower()
    if ":" in name:                     # 带端口（dev 的 localhost:8787）
        name = name.rsplit(":", 1)[0]
    if not name:
        return False
    if name in _TRUSTED_HOSTS:
        return True
    return any(name.endswith(suffix) for suffix in _TRUSTED_HOST_SUFFIXES)


def _engine_url_request(request: Request, request_context) -> _UrlRequestView:
    """payload.request.request_context → 签名用的请求视图（白名单外回落默认 host）。"""
    context = request_context if isinstance(request_context, dict) else {}
    host = str(context.get("host") or "").strip()
    proto = str(context.get("x_forwarded_proto") or "").strip().lower()
    if not host or not _host_allowed(host):
        logger.warning("[engine] render-data host 不在白名单，回落默认 host: %r", host)
        host = _DEFAULT_ASSET_HOST
    if proto not in ("http", "https"):
        proto = "https"
    return _UrlRequestView(request, host, proto)


def _require_asset_signing(url_request: _UrlRequestView) -> None:
    """render-data 的图片/公章是签名直链 ⇒ 没有 JWT_SECRET 就不能保证与旧路径一致。"""
    try:
        _main._jwt_secret(url_request)
    except HTTPException:
        raise HTTPException(status_code=503, detail={
            "error": "engine_rpc_asset_signing_unavailable",
            "message": "render-data 的图片/公章需要签名直链（JWT_SECRET 缺失）；"
                       "请保持 AUTH_DB_SPLIT=off 走旧路径",
        })


def _request_int(request_body: dict, key: str) -> int:
    value = request_body.get(key)
    if isinstance(value, bool) or not isinstance(value, int):
        raise _payload_invalid("request." + key + " 必须是整数")
    return value


logger = logging.getLogger(__name__)

@app.post("/api/v1/internal/engine/trade-docs/render-data")
async def engine_trade_docs_render_data(request: Request, body: dict):
    """单证渲染数据 RPC：7 张表的供数 → 与 GET render-data **同一份**装配（零 DB）。

    request = {"doc_id": int, "request_context": {"host": str, "x_forwarded_proto": str}}；
    datasets 见 main.RENDER_DATASETS（契约 §6.3 + 本切片 facade 段）。
    """
    user, request_body, datasets = _payload(request, body)
    _request_int(request_body, "doc_id")     # 形状/审计用；装配只依赖 datasets
    url_request = _engine_url_request(request, request_body.get("request_context"))
    _require_asset_signing(url_request)
    return await _dispatch(
        _main.render_data_from_datasets, datasets, user, url_request)


# ═══════════════════════════════════════════════════════════════════════════════
# 第四批切片：报价单 列表 / 详情（控制台高频读，纯投影）
# ═══════════════════════════════════════════════════════════════════════════════
# 设计 = docs/P2_COUPLING_ENGINE_2026-10-24.md §6/§8。门面按旧 SQL 谓词/排序/分页供数，
# 内核只做协议校验 + **同一份**纯投影（quote_api._quote_list_payload /
# _quote_detail_payload），并对行级可见性用共享内核 can_view 再判一次（防御纵深）。


@app.post("/api/v1/internal/engine/quotes/list")
async def engine_quotes_list(request: Request, body: dict):
    """报价单列表 RPC：request.query = 旧端点的**原始 query 字符串**（解析/校验在内核）。"""
    user, request_body, datasets = _payload(request, body)
    params = request_body.get("query")
    if params is None:
        params = {}
    if not isinstance(params, dict):
        raise _payload_invalid("request.query 必须是对象")
    return await _dispatch(_quote.quote_list_from_datasets, params, datasets, user)


@app.post("/api/v1/internal/engine/quotes/detail")
async def engine_quotes_detail(request: Request, body: dict):
    """报价单详情 RPC：request.quote_id = 路径上的 id；datasets 见 quote_detail_from_datasets。"""
    user, request_body, datasets = _payload(request, body)
    quote_id = _request_int(request_body, "quote_id")
    return await _dispatch(_quote.quote_detail_from_datasets, quote_id, datasets, user)


# ═══════════════════════════════════════════════════════════════════════════════
# 第五批切片：单证 列表 / 详情（控制台主入口，纯投影）
# ═══════════════════════════════════════════════════════════════════════════════
# 设计 = docs/P2_COUPLING_ENGINE_2026-10-24.md §6/§8。门面按旧 SQL 谓词/排序/分页供数，
# 内核只做协议校验 + **同一份**纯投影（main._trade_doc_list_payload /
# _trade_doc_detail_payload），读闸门复用旧路径同一份判定（403 NO_TEAM / 404 DOC_NOT_FOUND /
# _doc_visible 行级再判一次）。


@app.post("/api/v1/internal/engine/trade-docs/list")
async def engine_trade_docs_list(request: Request, body: dict):
    """单证列表 RPC：request.query = 旧端点的**原始 query 字符串**（解析/校验在内核）。"""
    user, request_body, datasets = _payload(request, body)
    params = request_body.get("query")
    if params is None:
        params = {}
    if not isinstance(params, dict):
        raise _payload_invalid("request.query 必须是对象")
    return await _dispatch(_main.trade_doc_list_from_datasets, params, datasets, user)


@app.post("/api/v1/internal/engine/trade-docs/detail")
async def engine_trade_docs_detail(request: Request, body: dict):
    """单证详情 RPC：request.doc_id = 路径上的 id；datasets 见 trade_doc_detail_from_datasets。"""
    user, request_body, datasets = _payload(request, body)
    doc_id = _request_int(request_body, "doc_id")
    return await _dispatch(_main.trade_doc_detail_from_datasets, doc_id, datasets, user)


# ═══════════════════════════════════════════════════════════════════════════════
# 第六批切片：4 条「需要内核计算」的只读端点（产品目录 / 产品名偏好 / 模板列定义）
# ═══════════════════════════════════════════════════════════════════════════════
# 设计 = docs/P2_COUPLING_ENGINE_2026-10-24.md §6/§8。全部是「取数 + 纯计算」：
# 门面按旧 SQL 供数，内核复用同一份 _quotable_specs_from_rows / _resolve_effective_raw /
# _product_or_404_from_rows / _import_template_payload / _order_template_info_payload。


def _query_object(request_body: dict) -> dict:
    """payload.request.query → dict（原始 query 字符串；缺省 = {}）。"""
    params = request_body.get("query")
    if params is None:
        return {}
    if not isinstance(params, dict):
        raise _payload_invalid("request.query 必须是对象")
    return params


@app.post("/api/v1/internal/engine/quote/products")
async def engine_quote_products(request: Request, body: dict):
    """产品目录 RPC：→ 与 GET /export-quote/products 同结果（同一份产品集合与投影）。"""
    user, _request_body, datasets = _payload(request, body)
    return await _dispatch(_quote.products_from_datasets, datasets, user)


@app.post("/api/v1/internal/engine/quote/product-name-preference")
async def engine_quote_product_name_preference(request: Request, body: dict):
    """产品名偏好 RPC：query = {customer_id, product_key}（原始字符串，解析/校验在内核）。"""
    user, request_body, datasets = _payload(request, body)
    return await _dispatch(
        _quote.quote_name_preference_from_datasets, datasets,
        _query_object(request_body), user)


@app.post("/api/v1/internal/engine/quote/import-template")
async def engine_quote_import_template(request: Request, body: dict):
    """单产品导入模板 RPC（**只接 JSON 分支**；带 format 的产文件分支留旧路径）。"""
    user, request_body, datasets = _payload(request, body)
    product_key = _request_str(request_body, "product_key")
    return await _dispatch(
        _quote.import_template_from_datasets, product_key,
        _query_object(request_body), datasets, user)


@app.post("/api/v1/internal/engine/quote/order-template-info")
async def engine_quote_order_template_info(request: Request, body: dict):
    """整单导入模板列定义 RPC：query = {product_keys}（逗号分隔，原始字符串）。"""
    user, request_body, datasets = _payload(request, body)
    return await _dispatch(
        _quote.order_template_info_from_datasets, datasets,
        _query_object(request_body), user)


# ═══════════════════════════════════════════════════════════════════════════════
# 第七批切片：GET /api/v1/pricing-data（定价数据矩阵，报价工位主视图）
# ═══════════════════════════════════════════════════════════════════════════════


@app.post("/api/v1/internal/engine/quote/pricing-data")
async def engine_quote_pricing_data(request: Request, body: dict):
    """定价数据矩阵 RPC：query = {product_key, scope}（原始字符串，判定/校验在内核）。"""
    user, request_body, datasets = _payload(request, body)
    return await _dispatch(
        _main.pricing_data_from_datasets, datasets, _query_object(request_body), user)


# ═══════════════════════════════════════════════════════════════════════════════
# 第八批切片：GET /trade-docs/{doc_id}/facts + /consistency（单证加固读端点）
# ═══════════════════════════════════════════════════════════════════════════════
# 设计 = docs/P2_COUPLING_ENGINE_2026-10-24.md §6/§8。取数由门面按旧 SQL 逐字做，
# 内核只做协议校验 + **同一份**纯函数（ws_docs_hardening._facts_* / _domain_docs_*）。


@app.post("/api/v1/internal/engine/trade-docs/facts")
async def engine_trade_docs_facts(request: Request, body: dict):
    """事实清单 RPC：request.doc_id = 路径 id；datasets 见 facts_from_datasets。"""
    user, request_body, datasets = _payload(request, body)
    doc_id = _request_int(request_body, "doc_id")
    return await _dispatch(_docs_hardening.facts_from_datasets, doc_id, datasets, user)


@app.post("/api/v1/internal/engine/trade-docs/consistency")
async def engine_trade_docs_consistency(request: Request, body: dict):
    """跨单证一致性 RPC：request.doc_id = 路径 id；datasets 见 consistency_from_datasets。"""
    user, request_body, datasets = _payload(request, body)
    doc_id = _request_int(request_body, "doc_id")
    return await _dispatch(_docs_hardening.consistency_from_datasets, doc_id, datasets, user)
