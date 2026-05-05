"""Kaas v2 · 事件插入测试 (§3.7.8)

测试场景:
- POST /api/v1/events 写入成功（含 schema_version）
- event_type 验证（有效/无效）
- 错误码覆盖: event_type_unknown, schema_version_required, schema_version_unsupported
- 跨租户读取隔离
"""
import pytest
pytestmark = pytest.mark.db
from tests.conftest import make_event_body


class TestEventInsert:
    """事件写入测试。"""

    async def test_insert_chat_turn_success(self, client):
        """写入 chat.turn 事件成功，返回 201。"""
        body = make_event_body("chat.turn", schema_version=1, event_source="orchestrator")
        response = await client.post(
            "/api/v1/events",
            json=body,
            headers={"X-Tenant-Id": "lianjia", "X-Use-V2": "true"},
        )
        assert response.status_code == 201
        data = response.json()
        assert data["tenant_id"] == "lianjia"
        assert data["event_type"] == "chat.turn"
        assert data["id"] is not None

    async def test_insert_quote_request_success(self, client):
        """写入 quote.request 事件成功。"""
        body = make_event_body("quote.request", schema_version=1, event_source="orchestrator")
        response = await client.post(
            "/api/v1/events",
            json=body,
            headers={"X-Tenant-Id": "lianjia", "X-Use-V2": "true"},
        )
        assert response.status_code == 201
        data = response.json()
        assert data["event_type"] == "quote.request"

    async def test_invalid_event_type_rejected(self, client):
        """无效 event_type 返回 400 + event_type_unknown。"""
        response = await client.post(
            "/api/v1/events",
            json={"event_type": "custom.event", "schema_version": 1, "payload": {}, "event_source": "orchestrator"},
            headers={"X-Tenant-Id": "lianjia", "X-Use-V2": "true"},
        )
        assert response.status_code == 400
        data = response.json()
        assert data["error"] == "event_type_unknown"

    async def test_missing_event_type_rejected(self, client):
        """缺 event_type 字段返回 400 + event_type_unknown。"""
        response = await client.post(
            "/api/v1/events",
            json={"schema_version": 1, "payload": {}, "event_source": "orchestrator"},
            headers={"X-Tenant-Id": "lianjia", "X-Use-V2": "true"},
        )
        assert response.status_code == 400
        assert response.json()["error"] == "event_type_unknown"

    async def test_missing_schema_version_rejected(self, client):
        """缺 schema_version 返回 400 + schema_version_required。"""
        body = make_event_body("chat.turn", schema_version=1)
        del body["schema_version"]
        response = await client.post(
            "/api/v1/events",
            json=body,
            headers={"X-Tenant-Id": "lianjia", "X-Use-V2": "true"},
        )
        assert response.status_code == 400
        assert response.json()["error"] == "schema_version_required"


class TestTenantIsolation:
    """租户隔离测试。"""

    async def test_different_tenants_produce_different_tenant_ids(self, client):
        """不同租户写入的事件包含各自的 tenant_id。"""
        body1 = make_event_body("chat.turn", event_source="orchestrator",
                                 session_id="iso-1", raw_text="lianjia test")
        body2 = make_event_body("chat.turn", event_source="orchestrator",
                                 session_id="iso-2", raw_text="client_b test")

        r1 = await client.post(
            "/api/v1/events", json=body1,
            headers={"X-Tenant-Id": "lianjia", "X-Use-V2": "true"},
        )
        r2 = await client.post(
            "/api/v1/events", json=body2,
            headers={"X-Tenant-Id": "client_b", "X-Use-V2": "false"},
        )

        assert r1.status_code == 201
        assert r2.status_code == 201
        body1_resp = r1.json()
        body2_resp = r2.json()
        assert body1_resp["tenant_id"] == "lianjia"
        assert body2_resp["tenant_id"] == "client_b"
        assert body1_resp["id"] != body2_resp["id"]


class TestPayloadValidation:
    """Payload schema 校验测试。"""

    async def test_invalid_schema_version_rejected(self, client):
        """不支持的 schema_version 返回 400。"""
        body = make_event_body("chat.turn", schema_version=99)
        response = await client.post(
            "/api/v1/events", json=body,
            headers={"X-Tenant-Id": "lianjia", "X-Use-V2": "true"},
        )
        assert response.status_code == 400
        assert response.json()["error"] == "schema_version_unsupported"

    async def test_payload_missing_required_field(self, client):
        """payload 缺失必填字段返回 payload_schema_mismatch。"""
        response = await client.post(
            "/api/v1/events",
            json={
                "event_type": "chat.turn",
                "schema_version": 1,
                "payload": {"session_id": "x"},
                "event_source": "orchestrator",
            },
            headers={"X-Tenant-Id": "lianjia", "X-Use-V2": "true"},
        )
        assert response.status_code == 400
        assert response.json()["error"] == "payload_schema_mismatch"
