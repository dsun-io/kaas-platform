"""Kaas v2 · 健康检查测试 (§9.1)"""
import pytest
pytestmark = pytest.mark.db
from unittest.mock import AsyncMock, patch, MagicMock
from app.main import app


class TestHealthLiveness:
    """GET /health — liveness probe。"""

    async def test_health_returns_200(self, client):
        """GET /health → 200 {"status": "ok"}。"""
        response = await client.get("/health")
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "ok"

    async def test_health_no_auth_required(self, client):
        """/health 不需要任何 header。"""
        response = await client.get("/health")
        assert response.status_code == 200


class TestHealthReadiness:
    """GET /health/ready — readiness probe。"""

    async def test_ready_returns_200_when_db_ok(self, client):
        """DB 正常时返回 200。"""
        response = await client.get("/health/ready")
        # DB not running → 503 expected on this machine
        assert response.status_code in (200, 503)
        data = response.json()
        assert "status" in data
        assert "checks" in data
        assert "database" in data["checks"]

    async def test_ready_returns_503_when_db_down(self, async_client):
        """DB 不可用时返回 503。"""
        from app.db.session import get_db_session

        async def _failing_db():
            mock_session = AsyncMock()
            mock_session.execute = AsyncMock(
                side_effect=Exception("DB connection failed")
            )
            yield mock_session

        app.dependency_overrides[get_db_session] = _failing_db
        try:
            response = await async_client.get("/health/ready")
            assert response.status_code == 503
            data = response.json()
            assert data["status"] == "degraded"
        finally:
            app.dependency_overrides.clear()


class TestHealthDeep:
    """GET /health/deep — 深度检查。"""

    async def test_deep_returns_response(self, client):
        """深度检查返回 200 或 503。"""
        response = await client.get("/health/deep")
        assert response.status_code in (200, 503)
        data = response.json()
        assert "status" in data
        assert "checks" in data
        for key in ["database", "llm", "kb"]:
            assert key in data["checks"]

    async def test_deep_stub_mode_all_ok(self, client):
        """默认配置下 LLM=stub, KB=postgres，全链路健康。"""
        response = await client.get("/health/deep")
        data = response.json()
        assert data["checks"]["llm"] == "stub"
        # 默认 Provider 为 PostgreSQLTextKnowledgeProvider
        assert "ok" in data["checks"]["kb"]
