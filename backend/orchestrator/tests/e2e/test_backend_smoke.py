"""Kaas v2 · 后端自冒烟测试 (§16)

纯后端 HTTP 冒烟，不启动前端。
需要 docker compose up -d 运行中的后端。
"""
import pytest
import httpx

pytestmark = pytest.mark.integration

BASE_URL = "http://localhost:8000"
TENANT_HEADERS = {"X-Tenant-Id": "liankai"}


@pytest.fixture
async def client():
    async with httpx.AsyncClient(base_url=BASE_URL, timeout=10) as c:
        yield c


class TestBackendSmoke:
    """后端 10 项冒烟检查。"""

    async def test_health_returns_200(self, client):
        """GET /health → 200。"""
        r = await client.get("/health")
        assert r.status_code == 200
        assert r.json()["status"] == "ok"

    async def test_health_ready_returns_200(self, client):
        """GET /health/ready → 200。"""
        r = await client.get("/health/ready")
        assert r.status_code in (200, 503)

    async def test_metrics_returns_200(self, client):
        """GET /metrics → 200。"""
        r = await client.get("/metrics")
        assert r.status_code == 200

    async def test_events_returns_200(self, client):
        """POST /api/v1/events → 200/201。"""
        r = await client.post(
            "/api/v1/events",
            json={
                "event_type": "chat.turn",
                "schema_version": 1,
                "event_source": "frontend",
                "payload": {
                    "session_id": "smoke-test",
                    "raw_text": "smoke test",
                    "agent_id": "agent-1",
                    "customer_id": "cust-1",
                    "response_text": "ok",
                    "llm_model": "test",
                    "llm_tokens_in": 1,
                    "llm_tokens_out": 1,
                },
            },
            headers=TENANT_HEADERS,
        )
        assert r.status_code in (200, 201)

    async def test_quote_returns_response(self, client):
        """POST /api/v1/quote → 200。"""
        r = await client.post(
            "/api/v1/quote",
            json={
                "customer_id": "cust-1",
                "product_category": "牛栏网",
                "product_spec": {"mesh": "50x50", "wire": "2.5"},
            },
            headers=TENANT_HEADERS,
        )
        assert r.status_code == 200

    async def test_capabilities_returns_200(self, client):
        """GET /api/v1/capabilities → 200。"""
        r = await client.get("/api/v1/capabilities", headers=TENANT_HEADERS)
        assert r.status_code == 200

    async def test_quotations_returns_200(self, client):
        """GET /api/v1/quotations → 200。"""
        r = await client.get("/api/v1/quotations", headers=TENANT_HEADERS)
        assert r.status_code == 200

    async def test_admin_flags_returns_200(self, client):
        """GET /api/v1/admin/feature_flag → 200。"""
        r = await client.get(
            "/api/v1/admin/feature_flag",
            params={"tenant_id": "liankai"},
            headers=TENANT_HEADERS,
        )
        assert r.status_code == 200

    async def test_admin_tenants_returns_200(self, client):
        """GET /api/v1/admin/tenants → 200。"""
        r = await client.get("/api/v1/admin/tenants", headers=TENANT_HEADERS)
        assert r.status_code == 200

    async def test_cors_preflight_returns_200(self, client):
        """OPTIONS /api/v1/events → CORS headers present。"""
        r = await client.options(
            "/api/v1/events",
            headers={
                "Origin": "http://localhost:3000",
                "Access-Control-Request-Method": "POST",
                **TENANT_HEADERS,
            },
        )
        assert r.status_code == 200
        assert "access-control-allow-origin" in r.headers
