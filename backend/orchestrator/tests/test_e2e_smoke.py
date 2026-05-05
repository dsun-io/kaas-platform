"""Kaas v2 · 端到端冒烟测试

验证核心链路:
- GET /health → 200
- POST /api/v1/events → 201 + DB 持久化
- GET /api/v1/admin/tenants → 200
"""
import pytest
pytestmark = pytest.mark.db
from sqlalchemy import select, text
from app.db.models import Event
from tests.conftest import make_event_body


class TestHealthCheck:
    """健康检查端点冒烟测试。"""

    async def test_health_returns_healthy(self, client):
        response = await client.get("/health")
        assert response.status_code == 200
        body = response.json()
        assert body["status"] == "ok"

    async def test_health_no_tenant_header_required(self, client):
        """健康检查不需要 X-Tenant-Id（公共路径豁免）。"""
        response = await client.get("/health")
        assert response.status_code == 200


class TestEventWriteE2E:
    """事件写入端到端测试 — 从 HTTP 到数据库。"""

    async def test_post_event_persists_to_db(self, client, db_session):
        """POST /api/v1/events 返回 201 且 session 内可查询到记录。"""
        body = make_event_body("chat.turn", event_source="orchestrator",
                                session_id="e2e-sess-1", raw_text="端到端测试消息")
        response = await client.post(
            "/api/v1/events", json=body,
            headers={"X-Tenant-Id": "lianjia", "X-Use-V2": "true"},
        )
        assert response.status_code == 201
        data = response.json()
        assert data["tenant_id"] == "lianjia"
        assert data["event_type"] == "chat.turn"
        event_id = data["id"]

        result = await db_session.execute(
            select(Event).where(Event.id == event_id)
        )
        row = result.scalar_one_or_none()
        assert row is not None
        assert row.tenant_id == "lianjia"
        assert row.event_type == "chat.turn"
        assert row.event_source == "orchestrator"

    async def test_post_quote_request_persists_to_db(self, client, db_session):
        """POST /api/v1/events quote.request 类型也成功写入。"""
        body = make_event_body("quote.request", event_source="orchestrator")
        response = await client.post(
            "/api/v1/events", json=body,
            headers={"X-Tenant-Id": "lianjia", "X-Use-V2": "true"},
        )
        assert response.status_code == 201
        data = response.json()
        assert data["event_type"] == "quote.request"

        result = await db_session.execute(
            select(Event).where(Event.event_source == "orchestrator")
        )
        rows = result.scalars().all()
        assert len(rows) >= 1


class TestAdminE2E:
    """管理端点端到端测试。"""

    async def test_list_tenants_returns_200(self, client):
        """GET /api/v1/admin/tenants 返回 200 且包含租户列表。"""
        response = await client.get(
            "/api/v1/admin/tenants",
            headers={"X-Tenant-Id": "lianjia"},
        )
        assert response.status_code == 200
        body = response.json()
        assert "tenants" in body
        assert len(body["tenants"]) >= 2

    async def test_get_specific_tenant_returns_200(self, client):
        """GET /api/v1/admin/tenants/{tenant_id} 返回租户详情。"""
        response = await client.get(
            "/api/v1/admin/tenants/lianjia",
            headers={"X-Tenant-Id": "lianjia"},
        )
        assert response.status_code == 200
        body = response.json()
        assert body["tenant_id"] == "lianjia"

    async def test_unknown_tenant_returns_404(self, client):
        """GET /api/v1/admin/tenants/unknown 返回 404。"""
        response = await client.get(
            "/api/v1/admin/tenants/nonexistent_tenant",
            headers={"X-Tenant-Id": "lianjia"},
        )
        assert response.status_code == 404

    async def test_archive_logs_returns_200(self, client):
        """GET /api/v1/admin/archive-logs 返回 200。"""
        response = await client.get(
            "/api/v1/admin/archive-logs",
            headers={"X-Tenant-Id": "lianjia"},
        )
        assert response.status_code == 200
        body = response.json()
        assert "logs" in body


class TestFullChainE2E:
    """完整链路串联测试。"""

    async def test_health_event_admin_chain(self, client):
        """健康检查 → 写事件 → 查管理端点，三条链路串联无异常。"""
        # Step 1: 健康检查
        h = await client.get("/health")
        assert h.status_code == 200

        # Step 2: 写入事件
        body = make_event_body("chat.turn", event_source="orchestrator")
        r = await client.post(
            "/api/v1/events", json=body,
            headers={"X-Tenant-Id": "lianjia", "X-Use-V2": "true"},
        )
        assert r.status_code == 201
        event = r.json()

        # Step 3: 查管理端点
        a = await client.get(
            "/api/v1/admin/tenants",
            headers={"X-Tenant-Id": "lianjia"},
        )
        assert a.status_code == 200

        # Step 4: 验证一致性
        assert event["tenant_id"] == "lianjia"
        assert "X-Trace-Id" in r.headers
        assert r.headers["X-Route-Version"] == "v2"
