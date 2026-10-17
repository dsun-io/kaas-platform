"""Kaas v2 · 中间件链测试 (§3.7.11 / §3.7.12 / §3.7.17)

测试场景:
- 缺 X-Tenant-Id → 401
- 错误 route_version (X-Use-V2) → fallback
- 正常请求 → trace_id header 注入
- sampling header 5 档策略
- 禁用租户 → 403
- 中间件注册顺序验证
"""
import json

import pytest
pytestmark = pytest.mark.db
from starlette.requests import Request
from starlette.responses import Response

from tests.conftest import error_code, make_event_body


def _tenant_request(path: str, tenant_id: str | None) -> Request:
    """构造最小 Starlette Request（只带可选的 X-Tenant-Id）。"""
    headers = []
    if tenant_id is not None:
        headers.append((b"x-tenant-id", tenant_id.encode()))
    return Request({
        "type": "http", "method": "POST", "path": path,
        "raw_path": path.encode(), "query_string": b"",
        "headers": headers, "scheme": "http",
        "server": ("test", 80), "client": ("test", 1234),
    })


async def _run_tenant_middleware(path: str = "/api/v1/events",
                                 tenant_id: str | None = None):
    """直接调 `TenantContextMiddleware.dispatch`（不经过鉴权中间件）。

    为什么不再走整条 app 链：2026-10-11 口径改为「tenant 恒 default、隔离靠团队」，
    `AuthContextMiddleware` 为**所有**已认证请求注入 request.state.tenant_id，
    于是 `TenantContextMiddleware` 必然走「已注入 → 放行」分支 —— 它自己的
    X-Tenant-Id 校验在集成层已不可达。直接调用 dispatch 才能继续钉住这段
    防御逻辑（缺头 401 / 禁用或未知 403 / 有效租户注入 state）。
    """
    from app.main import app
    from app.middleware.tenant import TenantContextMiddleware

    middleware = TenantContextMiddleware(app=app)
    request = _tenant_request(path, tenant_id)

    async def _call_next(_request):
        return Response(status_code=204)

    response = await middleware.dispatch(request, _call_next)
    return response, request


def _body(response) -> dict:
    """JSONResponse（Starlette 0.52 没有 .json() 方法）→ dict。"""
    return json.loads(response.body)


class TestTenantMiddleware:
    """TenantContext 中间件测试（§3.7.12）—— 直接调 dispatch（见上方说明）。"""

    async def test_missing_tenant_id_returns_401(self):
        """缺 X-Tenant-Id 返回 401 tenant_unauthorized。"""
        response, _ = await _run_tenant_middleware()
        assert response.status_code == 401
        assert _body(response)["error"] == "tenant_unauthorized"

    async def test_disabled_tenant_returns_403(self):
        """禁用租户返回 403 invalid_tenant。"""
        response, _ = await _run_tenant_middleware(tenant_id="disabled_tenant")
        assert response.status_code == 403
        assert _body(response)["error"] == "invalid_tenant"

    async def test_unknown_tenant_returns_403(self):
        """未知租户返回 403 invalid_tenant。"""
        response, _ = await _run_tenant_middleware(tenant_id="nonexistent")
        assert response.status_code == 403
        assert _body(response)["error"] == "invalid_tenant"

    async def test_valid_tenant_proceeds(self):
        """有效租户：放行并注入 tenant_id / tenant_config。"""
        response, request = await _run_tenant_middleware(tenant_id="lianjia")
        assert response.status_code == 204
        assert request.state.tenant_id == "lianjia"
        assert request.state.tenant_config is not None

    async def test_valid_tenant_proceeds_to_route(self, client):
        """有效租户 + 合法公司头 → 走到路由：无效 event_type 仍 400。"""
        response = await client.post(
            "/api/v1/events",
            json={"event_type": "invalid.type", "schema_version": 1, "payload": {}, "event_source": "orchestrator"},
            headers={"X-Tenant-Id": "lianjia"},
        )
        assert response.status_code == 400
        assert error_code(response) == "event_type_unknown"


class TestRouteVersionMiddleware:
    """RouteVersion 中间件测试（§3.7.17）。"""

    async def test_missing_header_falls_back_to_tenant_flag(self, client):
        """缺 X-Use-V2 时回退到租户 feature_flag。lianjia 的 use_v2=true。"""
        body = make_event_body("audit.access")
        response = await client.post(
            "/api/v1/events", json=body,
            headers={"X-Tenant-Id": "lianjia"},
        )
        assert response.status_code == 200
        assert response.headers["X-Route-Version"] == "v2"

    async def test_client_b_use_v2_false_fallback(self, client):
        """client_b 的 use_v2=false，缺 header 时回退到 v1。"""
        body = make_event_body("audit.access")
        response = await client.post(
            "/api/v1/events", json=body,
            headers={"X-Tenant-Id": "client_b"},
        )
        assert response.status_code == 200
        assert response.headers["X-Route-Version"] == "v1"

    async def test_explicit_v2_true_header(self, client):
        """X-Use-V2: true 显式设为 v2。"""
        body = make_event_body("audit.access")
        response = await client.post(
            "/api/v1/events", json=body,
            headers={"X-Tenant-Id": "lianjia", "X-Use-V2": "true"},
        )
        assert response.status_code == 200
        assert response.headers["X-Route-Version"] == "v2"

    async def test_explicit_v2_false_overrides_tenant_flag(self, client):
        """X-Use-V2: false 覆盖租户 use_v2=true。"""
        body = make_event_body("audit.access")
        response = await client.post(
            "/api/v1/events", json=body,
            headers={"X-Tenant-Id": "lianjia", "X-Use-V2": "false"},
        )
        assert response.status_code == 200
        assert response.headers["X-Route-Version"] == "v1"


class TestTraceMiddleware:
    """Trace 中间件测试。"""

    async def test_trace_id_injected_in_response(self, client):
        """正常请求后 response header 包含 X-Trace-Id。"""
        body = make_event_body("audit.access")
        response = await client.post(
            "/api/v1/events", json=body,
            headers={"X-Tenant-Id": "lianjia"},
        )
        assert response.status_code == 200
        trace_id = response.headers.get("X-Trace-Id")
        assert trace_id is not None
        assert len(trace_id) == 32


class TestSamplingMiddleware:
    """Sampling 中间件测试（§3.7.11 5档策略）。"""

    async def test_sampling_header_set(self, client):
        """响应 header 包含 X-Sampled 标识。"""
        body = make_event_body("audit.access")
        response = await client.post(
            "/api/v1/events", json=body,
            headers={"X-Tenant-Id": "lianjia"},
        )
        assert response.status_code == 200
        assert "X-Sampled" in response.headers

    async def test_admin_path_always_sampled(self, client):
        """管理 API 路径的 X-Sampled 始终为 true。"""
        response = await client.get(
            "/api/v1/admin/tenants",
            headers={"X-Tenant-Id": "lianjia"},
        )
        assert response.status_code == 200
        assert response.headers["X-Sampled"] == "true"


class TestMiddlewareChainOrder:
    """中间件链顺序集成测试。"""

    async def test_full_chain_happy_path(self, client):
        """完整链: 所有 header 正确的请求成功返回。"""
        body = make_event_body("audit.access", event_source="orchestrator")
        response = await client.post(
            "/api/v1/events", json=body,
            headers={"X-Tenant-Id": "lianjia", "X-Use-V2": "true"},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["tenant_id"] == "lianjia"
        assert data["event_type"] == "audit.access"
        assert "id" in data
        assert "X-Trace-Id" in response.headers
        assert "X-Route-Version" in response.headers
        assert "X-Sampled" in response.headers


class TestSamplingBoundary:
    """采样中间件边界值测试（T4/T12 合并）。"""

    @staticmethod
    def _patch_sampling_config(monkeypatch, sampling_rate: float):
        """注入一个临时租户，指定 sampling_rate。"""

        def _mock_load(tenant_id):
            tenants = {
                "lianjia": {
                    "display_name": "联佳丝网",
                    "enabled": True,
                    "feature_flags": {"use_v2": True, "sampling_rate": sampling_rate},
                    "product_categories": ["牛栏网"],
                },
                "client_b": {
                    "display_name": "客户 B",
                    "enabled": True,
                    "feature_flags": {"use_v2": False, "sampling_rate": sampling_rate},
                    "product_categories": ["石笼网"],
                },
                "disabled_tenant": {
                    "display_name": "已禁用",
                    "enabled": False,
                    "feature_flags": {},
                },
            }
            tenant = tenants.get(tenant_id)
            if tenant and not tenant.get("enabled", True):
                return None
            return tenant

        monkeypatch.setattr("app.middleware.tenant.load_tenant_config", _mock_load)
        monkeypatch.setattr("app.middleware.sampling.load_tenant_config", _mock_load)
        monkeypatch.setattr("app.middleware.route_version.load_tenant_config", _mock_load)

    async def test_sampling_rate_zero_never_samples(self, client, monkeypatch):
        """sampling_rate=0.0 时非管理/非错误路径始终不采样。"""
        self._patch_sampling_config(monkeypatch, sampling_rate=0.0)
        body = make_event_body("audit.access")
        response = await client.post(
            "/api/v1/events", json=body,
            headers={"X-Tenant-Id": "lianjia", "X-Use-V2": "true"},
        )
        assert response.status_code == 200
        assert response.headers["X-Sampled"] == "false"

    async def test_sampling_rate_one_always_samples(self, client, monkeypatch):
        """sampling_rate=1.0 时非管理/非错误路径始终采样。"""
        self._patch_sampling_config(monkeypatch, sampling_rate=1.0)
        body = make_event_body("audit.access")
        response = await client.post(
            "/api/v1/events", json=body,
            headers={"X-Tenant-Id": "lianjia", "X-Use-V2": "true"},
        )
        assert response.status_code == 200
        assert response.headers["X-Sampled"] == "true"

    async def test_error_response_always_sampled(self, client, monkeypatch):
        """即使 sampling_rate=0.0，错误响应也被强制采样。"""
        self._patch_sampling_config(monkeypatch, sampling_rate=0.0)
        response = await client.post(
            "/api/v1/events",
            json={"event_type": "custom.invalid", "schema_version": 1, "payload": {}, "event_source": "orchestrator"},
            headers={"X-Tenant-Id": "lianjia"},
        )
        assert response.status_code == 400
        assert response.headers["X-Sampled"] == "true"

    async def test_disabled_tenant_on_protected_path_skipped(self):
        """禁用租户访问需要租户上下文的路径返回 403（直接测中间件，见类头说明）。"""
        response, _ = await _run_tenant_middleware(tenant_id="disabled_tenant")
        assert response.status_code == 403
        assert _body(response)["error"] == "invalid_tenant"

    async def test_invalid_tenant_returns_403_not_500(self):
        """无效租户 ID 返回 403 不是 500。"""
        response, _ = await _run_tenant_middleware(tenant_id="this_tenant_does_not_exist")
        assert response.status_code == 403
        assert _body(response)["error"] == "invalid_tenant"

    async def test_missing_tenant_id_returns_401(self):
        """缺少 X-Tenant-Id 返回 401 不是 500。"""
        response, _ = await _run_tenant_middleware()
        assert response.status_code == 401
        assert _body(response)["error"] == "tenant_unauthorized"

    async def test_missing_tenant_id_on_admin_returns_401(self):
        """管理端点缺 X-Tenant-Id 也返回 401。"""
        response, _ = await _run_tenant_middleware(path="/api/v1/admin/tenants")
        assert response.status_code == 401
        assert _body(response)["error"] == "tenant_unauthorized"

    async def test_admin_path_sampled_true_even_at_zero_rate(self, client, monkeypatch):
        """管理路径即使 sampling_rate=0.0 也始终采样。"""
        self._patch_sampling_config(monkeypatch, sampling_rate=0.0)
        response = await client.get(
            "/api/v1/admin/tenants",
            headers={"X-Tenant-Id": "lianjia"},
        )
        assert response.status_code == 200
        assert response.headers["X-Sampled"] == "true"
