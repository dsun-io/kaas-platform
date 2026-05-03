"""Kaas v2 · 请求上下文中间件测试 (§8.2)"""
import pytest
pytestmark = pytest.mark.unit


class TestRequestContext:
    """RequestContextMiddleware 测试。"""

    async def test_auto_generates_request_id(self, async_client):
        """无 X-Request-Id header → 自动生成 + 返回。"""
        response = await async_client.get("/health")
        assert response.status_code == 200
        assert "x-request-id" in response.headers
        rid = response.headers["x-request-id"]
        assert len(rid) == 8

    async def test_passthrough_request_id(self, async_client):
        """有 X-Request-Id header → 透传。"""
        response = await async_client.get(
            "/health",
            headers={"X-Request-Id": "my-custom-id-123"},
        )
        assert response.status_code == 200
        assert response.headers["x-request-id"] == "my-custom-id-123"

    async def test_elapsed_ms_header_exists(self, async_client):
        """X-Elapsed-Ms header 存在且 > 0。"""
        response = await async_client.get("/health")
        assert "x-elapsed-ms" in response.headers
        elapsed = float(response.headers["x-elapsed-ms"])
        assert elapsed > 0

    async def test_elapsed_ms_is_reasonable(self, async_client):
        """elapsed_ms 在合理范围内 (< 5000ms for /health)。"""
        response = await async_client.get("/health")
        elapsed = float(response.headers["x-elapsed-ms"])
        assert elapsed < 5000.0
