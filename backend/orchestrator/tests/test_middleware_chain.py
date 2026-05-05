"""Kaas v2 · 中间件链测试 (§3.7.11 / §3.7.12 / §3.7.17)

测试场景:
- 缺 X-Tenant-Id → 401
- 错误 route_version (X-Use-V2) → fallback
- 正常请求 → trace_id header 注入
- sampling header 5 档策略
- 禁用租户 → 403
- 中间件注册顺序验证
"""
import pytest
pytestmark = pytest.mark.db
import pytest
from tests.conftest import make_event_body


class TestTenantMiddleware:
    """TenantContext 中间件测试（§3.7.12）。"""

    async def test_missing_tenant_id_returns_401(self, client):
        """缺 X-Tenant-Id 返回 401 tenant_unauthorized。"""
        body = make_event_body("chat.turn")
        response = await client.post("/api/v1/events", json=body)
        assert response.status_code == 401
        data = response.json()
        assert data["error"] == "tenant_unauthorized"

    async def test_disabled_tenant_returns_403(self, client):
        """禁用租户返回 403。"""
        body = make_event_body("chat.turn")
        response = await client.post(
            "/api/v1/events", json=body,
            headers={"X-Tenant-Id": "disabled_tenant"},
        )
        assert response.status_code == 403
        data = response.json()
        assert data["error"] == "invalid_tenant"

    async def test_unknown_tenant_returns_403(self, client):
        """未知租户返回 403。"""
        body = make_event_body("chat.turn")
        response = await client.post(
            "/api/v1/events", json=body,
            headers={"X-Tenant-Id": "nonexistent"},
        )
        assert response.status_code == 403

    async def test_valid_tenant_proceeds(self, client):
        """有效租户通过中间件（后续因为无效 event_type 返回 400 但已过租户检查）。"""
        response = await client.post(
            "/api/v1/events",
            json={"event_type": "invalid.type", "schema_version": 1, "payload": {}, "event_source": "orchestrator"},
            headers={"X-Tenant-Id": "lianjia"},
        )
        assert response.status_code == 400
        data = response.json()
        assert data["error"] == "event_type_unknown"


class TestRouteVersionMiddleware:
    """RouteVersion 中间件测试（§3.7.17）。"""

    async def test_missing_header_falls_back_to_tenant_flag(self, client):
        """缺 X-Use-V2 时回退到租户 feature_flag。lianjia 的 use_v2=true。"""
        body = make_event_body("chat.turn")
        response = await client.post(
            "/api/v1/events", json=body,
            headers={"X-Tenant-Id": "lianjia"},
        )
        assert response.status_code == 201
        assert response.headers["X-Route-Version"] == "v2"

    async def test_client_b_use_v2_false_fallback(self, client):
        """client_b 的 use_v2=false，缺 header 时回退到 v1。"""
        body = make_event_body("chat.turn")
        response = await client.post(
            "/api/v1/events", json=body,
            headers={"X-Tenant-Id": "client_b"},
        )
        assert response.status_code == 201
        assert response.headers["X-Route-Version"] == "v1"

    async def test_explicit_v2_true_header(self, client):
        """X-Use-V2: true 显式设为 v2。"""
        body = make_event_body("chat.turn")
        response = await client.post(
            "/api/v1/events", json=body,
            headers={"X-Tenant-Id": "lianjia", "X-Use-V2": "true"},
        )
        assert response.status_code == 201
        assert response.headers["X-Route-Version"] == "v2"

    async def test_explicit_v2_false_overrides_tenant_flag(self, client):
        """X-Use-V2: false 覆盖租户 use_v2=true。"""
        body = make_event_body("chat.turn")
        response = await client.post(
            "/api/v1/events", json=body,
            headers={"X-Tenant-Id": "lianjia", "X-Use-V2": "false"},
        )
        assert response.status_code == 201
        assert response.headers["X-Route-Version"] == "v1"


class TestTraceMiddleware:
    """Trace 中间件测试。"""

    async def test_trace_id_injected_in_response(self, client):
        """正常请求后 response header 包含 X-Trace-Id。"""
        body = make_event_body("chat.turn")
        response = await client.post(
            "/api/v1/events", json=body,
            headers={"X-Tenant-Id": "lianjia"},
        )
        assert response.status_code == 201
        trace_id = response.headers.get("X-Trace-Id")
        assert trace_id is not None
        assert len(trace_id) == 32


class TestSamplingMiddleware:
    """Sampling 中间件测试（§3.7.11 5档策略）。"""

    async def test_sampling_header_set(self, client):
        """响应 header 包含 X-Sampled 标识。"""
        body = make_event_body("chat.turn")
        response = await client.post(
            "/api/v1/events", json=body,
            headers={"X-Tenant-Id": "lianjia"},
        )
        assert response.status_code == 201
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
        body = make_event_body("chat.turn", event_source="orchestrator")
        response = await client.post(
            "/api/v1/events", json=body,
            headers={"X-Tenant-Id": "lianjia", "X-Use-V2": "true"},
        )
        assert response.status_code == 201
        data = response.json()
        assert data["tenant_id"] == "lianjia"
        assert data["event_type"] == "chat.turn"
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
        body = make_event_body("chat.turn")
        response = await client.post(
            "/api/v1/events", json=body,
            headers={"X-Tenant-Id": "lianjia", "X-Use-V2": "true"},
        )
        assert response.status_code == 201
        assert response.headers["X-Sampled"] == "false"

    async def test_sampling_rate_one_always_samples(self, client, monkeypatch):
        """sampling_rate=1.0 时非管理/非错误路径始终采样。"""
        self._patch_sampling_config(monkeypatch, sampling_rate=1.0)
        body = make_event_body("chat.turn")
        response = await client.post(
            "/api/v1/events", json=body,
            headers={"X-Tenant-Id": "lianjia", "X-Use-V2": "true"},
        )
        assert response.status_code == 201
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

    async def test_disabled_tenant_on_protected_path_skipped(self, client):
        """禁用租户访问需要租户上下文的路径返回 403。"""
        body = make_event_body("chat.turn")
        response = await client.post(
            "/api/v1/events", json=body,
            headers={"X-Tenant-Id": "disabled_tenant"},
        )
        assert response.status_code == 403
        data = response.json()
        assert data["error"] == "invalid_tenant"

    async def test_invalid_tenant_returns_403_not_500(self, client):
        """无效租户 ID 返回 403 不是 500。"""
        body = make_event_body("chat.turn")
        response = await client.post(
            "/api/v1/events", json=body,
            headers={"X-Tenant-Id": "this_tenant_does_not_exist"},
        )
        assert response.status_code == 403
        data = response.json()
        assert data["error"] == "invalid_tenant"

    async def test_missing_tenant_id_returns_401(self, client):
        """缺少 X-Tenant-Id 返回 401 不是 500。"""
        body = make_event_body("chat.turn")
        response = await client.post("/api/v1/events", json=body)
        assert response.status_code == 401
        data = response.json()
        assert data["error"] == "tenant_unauthorized"

    async def test_missing_tenant_id_on_admin_returns_401(self, client):
        """管理端点缺 X-Tenant-Id 也返回 401。"""
        response = await client.get("/api/v1/admin/tenants")
        assert response.status_code == 401
        data = response.json()
        assert data["error"] == "tenant_unauthorized"

    async def test_admin_path_sampled_true_even_at_zero_rate(self, client, monkeypatch):
        """管理路径即使 sampling_rate=0.0 也始终采样。"""
        self._patch_sampling_config(monkeypatch, sampling_rate=0.0)
        response = await client.get(
            "/api/v1/admin/tenants",
            headers={"X-Tenant-Id": "lianjia"},
        )
        assert response.status_code == 200
        assert response.headers["X-Sampled"] == "true"
