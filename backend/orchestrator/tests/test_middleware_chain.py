"""Kaas v2 · 中间件链测试 (§13)

测试场景:
- 缺 X-Tenant-Id → 400
- 错误 route_version → 400
- 正常请求 → trace_id header 注入
- sampling header 按 feature_flag 设置
- 禁用租户 → 403
"""
import pytest


class TestTenantMiddleware:
    """TenantContext 中间件测试（最内层）。"""

    async def test_missing_tenant_id_returns_400(self, async_client):
        """缺 X-Tenant-Id 返回 400。"""
        response = await async_client.post(
            "/api/v1/events",
            json={"event_type": "chat.turn", "payload": {}},
        )
        assert response.status_code == 400
        data = response.json()
        assert data["error"] == "missing_tenant"

    async def test_disabled_tenant_returns_403(self, async_client):
        """禁用租户返回 403。"""
        response = await async_client.post(
            "/api/v1/events",
            json={"event_type": "chat.turn", "payload": {}},
            headers={"X-Tenant-Id": "disabled_tenant"},
        )
        assert response.status_code == 403
        data = response.json()
        assert data["error"] == "invalid_tenant"

    async def test_unknown_tenant_returns_403(self, async_client):
        """未知租户返回 403。"""
        response = await async_client.post(
            "/api/v1/events",
            json={"event_type": "chat.turn", "payload": {}},
            headers={"X-Tenant-Id": "nonexistent"},
        )
        assert response.status_code == 403

    async def test_valid_tenant_proceeds(self, async_client):
        """有效租户通过中间件（后续因为无效 event_type 返回 400 但已过租户检查）。"""
        response = await async_client.post(
            "/api/v1/events",
            json={"event_type": "invalid.type", "payload": {}},
            headers={"X-Tenant-Id": "liankai"},
        )
        # 通过租户检查，到达路由层才因 event_type 无效而 400
        assert response.status_code == 400
        data = response.json()
        assert data["error"] == "invalid_event_type"


class TestRouteVersionMiddleware:
    """RouteVersion 中间件测试。"""

    async def test_missing_route_version_falls_back_to_tenant_flag(self, async_client):
        """缺 X-Route-Version 时回退到租户 feature_flag。liankai 的 use_v2=true。"""
        response = await async_client.post(
            "/api/v1/events",
            json={"event_type": "chat.turn", "payload": {}},
            headers={"X-Tenant-Id": "liankai"},
        )
        assert response.status_code == 201
        assert response.headers["X-Route-Version"] == "v2"

    async def test_client_b_use_v2_false_fallback(self, async_client):
        """client_b 的 use_v2=false，缺 header 时回退到 v1。"""
        response = await async_client.post(
            "/api/v1/events",
            json={"event_type": "chat.turn", "payload": {}},
            headers={"X-Tenant-Id": "client_b"},
        )
        assert response.status_code == 201
        assert response.headers["X-Route-Version"] == "v1"

    async def test_invalid_route_version_returns_400(self, async_client):
        """X-Route-Version 无效值返回 400。"""
        response = await async_client.post(
            "/api/v1/events",
            json={"event_type": "chat.turn", "payload": {}},
            headers={"X-Tenant-Id": "liankai", "X-Route-Version": "v3"},
        )
        assert response.status_code == 400
        data = response.json()
        assert data["error"] == "invalid_route_version"

    async def test_explicit_v1_header_overrides_tenant_flag(self, async_client):
        """显式 X-Route-Version: v1 覆盖租户 use_v2=true。"""
        response = await async_client.post(
            "/api/v1/events",
            json={"event_type": "chat.turn", "payload": {}},
            headers={
                "X-Tenant-Id": "liankai",
                "X-Route-Version": "v1",
            },
        )
        assert response.status_code == 201
        assert response.headers["X-Route-Version"] == "v1"


class TestTraceMiddleware:
    """Trace 中间件测试（外层）。"""

    async def test_trace_id_injected_in_response(self, async_client):
        """正常请求后 response header 包含 X-Trace-Id。"""
        response = await async_client.post(
            "/api/v1/events",
            json={"event_type": "chat.turn", "payload": {}},
            headers={"X-Tenant-Id": "liankai"},
        )
        assert response.status_code == 201
        trace_id = response.headers.get("X-Trace-Id")
        assert trace_id is not None
        assert len(trace_id) == 32  # UUID v4 hex = 32 chars


class TestSamplingMiddleware:
    """Sampling 中间件测试（最外层）。"""

    async def test_sampling_header_set(self, async_client):
        """响应 header 包含 X-Sampled 标识。"""
        response = await async_client.post(
            "/api/v1/events",
            json={"event_type": "chat.turn", "payload": {}},
            headers={"X-Tenant-Id": "liankai"},
        )
        assert response.status_code == 201
        assert "X-Sampled" in response.headers

    async def test_admin_path_always_sampled(self, async_client):
        """管理 API 路径的 X-Sampled 始终为 true。"""
        response = await async_client.get(
            "/api/v1/admin/tenants",
            headers={"X-Tenant-Id": "liankai"},
        )
        assert response.status_code == 200
        assert response.headers["X-Sampled"] == "true"


class TestMiddlewareChainOrder:
    """中间件链顺序集成测试。"""

    async def test_full_chain_happy_path(self, async_client):
        """完整链: 所有 header 正确的请求成功返回。"""
        response = await async_client.post(
            "/api/v1/events",
            json={
                "event_type": "chat.turn",
                "schema_version": "1.0",
                "payload": {"session_id": "s1", "raw_text": "测试", "agent_id": "a1",
                            "customer_id": "c1", "response_text": "", "llm_model": "",
                            "llm_tokens_in": 0, "llm_tokens_out": 0},
                "source": "test",
            },
            headers={
                "X-Tenant-Id": "liankai",
                "X-Route-Version": "v2",
            },
        )
        assert response.status_code == 201
        body = response.json()
        assert body["tenant_id"] == "liankai"
        assert body["event_type"] == "chat.turn"
        assert "id" in body
        # 验证所有中间件 header
        assert "X-Trace-Id" in response.headers
        assert "X-Route-Version" in response.headers
        assert "X-Sampled" in response.headers
