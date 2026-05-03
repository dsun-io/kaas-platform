"""Kaas v2 · CORS + 安全头测试 (§14)"""
import pytest
pytestmark = pytest.mark.unit


class TestCORS:
    """CORS 预检 + Access-Control headers。"""

    async def test_options_preflight_returns_200(self, async_client):
        """OPTIONS 预检 → 200 + Access-Control-Allow-Origin。"""
        response = await async_client.options(
            "/health",
            headers={
                "Origin": "http://localhost:3000",
                "Access-Control-Request-Method": "GET",
            },
        )
        assert response.status_code == 200
        assert "access-control-allow-origin" in response.headers

    async def test_options_preflight_returns_allow_methods(self, async_client):
        """预检返回允许的方法列表。"""
        response = await async_client.options(
            "/health",
            headers={
                "Origin": "http://localhost:3000",
                "Access-Control-Request-Method": "POST",
            },
        )
        assert response.status_code == 200
        assert "access-control-allow-methods" in response.headers


class TestSecurityHeaders:
    """安全响应头测试。"""

    async def test_x_content_type_options(self, async_client):
        """X-Content-Type-Options: nosniff。"""
        response = await async_client.get("/health")
        assert response.headers.get("x-content-type-options") == "nosniff"

    async def test_x_frame_options(self, async_client):
        """X-Frame-Options: DENY。"""
        response = await async_client.get("/health")
        assert response.headers.get("x-frame-options") == "DENY"

    async def test_x_xss_protection(self, async_client):
        """X-XSS-Protection: 1; mode=block。"""
        response = await async_client.get("/health")
        assert response.headers.get("x-xss-protection") == "1; mode=block"

    async def test_referrer_policy(self, async_client):
        """Referrer-Policy: strict-origin-when-cross-origin。"""
        response = await async_client.get("/health")
        assert response.headers.get("referrer-policy") == "strict-origin-when-cross-origin"
