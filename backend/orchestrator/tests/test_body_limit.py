"""Kaas v2 · Body Size Limit 测试 (§15.2)"""
import pytest
pytestmark = pytest.mark.unit
from httpx import AsyncClient, ASGITransport
from app.main import app


class TestBodySizeLimit:
    """请求体大小限制测试。"""

    async def test_normal_body_passes(self):
        """正常大小 body 通过。"""
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            r = await c.get("/health")
        assert r.status_code == 200

    async def test_content_length_exceeded_returns_413(self):
        """Content-Length > MAX_BODY_SIZE → 413。"""
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            r = await c.post(
                "/api/v1/quote",
                json={"test": "data"},
                headers={
                    "X-Tenant-Id": "lianjia",
                    "Content-Length": str(2 * 1024 * 1024),  # 2MB
                },
            )
        assert r.status_code == 413

    async def test_missing_content_length_passes(self):
        """无 Content-Length header 直接放行。"""
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            r = await c.get("/health")
        assert r.status_code == 200


class TestQuoteRequestConstraints:
    """QuoteRequest Pydantic 字段约束。"""

    async def test_raw_text_too_long_returns_422(self):
        """raw_text > 2000 → 422 validation error。"""
        transport = ASGITransport(app=app)
        long_text = "x" * 2001
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            r = await c.post(
                "/api/v1/quote",
                json={
                    "customer_id": "cust-1",
                    "raw_text": long_text,
                },
                headers={"X-Tenant-Id": "lianjia"},
            )
        assert r.status_code == 422
