"""Kaas v2 · 事件插入测试 (§13)

测试场景:
- POST /api/v1/events 写入成功
- event_type 验证（有效/无效）
- 跨租户读取隔离
"""
import pytest


class TestEventInsert:
    """事件写入测试。"""

    async def test_insert_chat_turn_success(self, async_client):
        """写入 chat.turn 事件成功，返回 201。"""
        response = await async_client.post(
            "/api/v1/events",
            json={
                "event_type": "chat.turn",
                "schema_version": "1.0",
                "payload": {
                    "session_id": "sess-001",
                    "raw_text": "我需要牛栏网报价",
                    "agent_id": "agent-1",
                    "customer_id": "cust-1",
                    "response_text": "好的",
                    "llm_model": "deepseek-v4",
                    "llm_tokens_in": 50,
                    "llm_tokens_out": 30,
                },
                "source": "test",
            },
            headers={"X-Tenant-Id": "liankai", "X-Route-Version": "v2"},
        )
        assert response.status_code == 201
        body = response.json()
        assert body["tenant_id"] == "liankai"
        assert body["event_type"] == "chat.turn"
        assert body["trace_id"] is not None

    async def test_insert_quote_request_success(self, async_client):
        """写入 quote.request 事件成功。"""
        response = await async_client.post(
            "/api/v1/events",
            json={
                "event_type": "quote.request",
                "schema_version": "1.0",
                "payload": {
                    "session_id": "sess-002",
                    "customer_id": "cust-1",
                    "product_category": "牛栏网",
                    "product_spec": {"mesh": "50x50", "wire": "2.0"},
                    "quantity": 100,
                },
                "source": "test",
            },
            headers={"X-Tenant-Id": "liankai", "X-Route-Version": "v2"},
        )
        assert response.status_code == 201
        body = response.json()
        assert body["event_type"] == "quote.request"

    async def test_invalid_event_type_rejected(self, async_client):
        """无效 event_type 返回 400。"""
        response = await async_client.post(
            "/api/v1/events",
            json={
                "event_type": "custom.event",
                "schema_version": "1.0",
                "payload": {},
                "source": "test",
            },
            headers={"X-Tenant-Id": "liankai", "X-Route-Version": "v2"},
        )
        assert response.status_code == 400
        data = response.json()
        assert data["error"] == "invalid_event_type"

    async def test_missing_event_type_rejected(self, async_client):
        """缺 event_type 字段返回 400。"""
        response = await async_client.post(
            "/api/v1/events",
            json={"payload": {}, "source": "test"},
            headers={"X-Tenant-Id": "liankai", "X-Route-Version": "v2"},
        )
        assert response.status_code == 400
        assert response.json()["error"] == "invalid_event_type"


class TestTenantIsolation:
    """租户隔离测试。"""

    async def test_different_tenants_produce_different_tenant_ids(self, async_client):
        """不同租户写入的事件包含各自的 tenant_id。"""
        # liankai 写入
        r1 = await async_client.post(
            "/api/v1/events",
            json={
                "event_type": "chat.turn",
                "payload": {
                    "session_id": "iso-1",
                    "raw_text": "liankai test",
                    "agent_id": "a1",
                    "customer_id": "c1",
                    "response_text": "",
                    "llm_model": "",
                    "llm_tokens_in": 0,
                    "llm_tokens_out": 0,
                },
                "source": "isolation_test",
            },
            headers={"X-Tenant-Id": "liankai", "X-Route-Version": "v2"},
        )
        # client_b 写入
        r2 = await async_client.post(
            "/api/v1/events",
            json={
                "event_type": "chat.turn",
                "payload": {
                    "session_id": "iso-2",
                    "raw_text": "client_b test",
                    "agent_id": "a1",
                    "customer_id": "c2",
                    "response_text": "",
                    "llm_model": "",
                    "llm_tokens_in": 0,
                    "llm_tokens_out": 0,
                },
                "source": "isolation_test",
            },
            headers={"X-Tenant-Id": "client_b", "X-Route-Version": "v2"},
        )

        assert r1.status_code == 201
        assert r2.status_code == 201
        body1 = r1.json()
        body2 = r2.json()
        assert body1["tenant_id"] == "liankai"
        assert body2["tenant_id"] == "client_b"
        # 两个不同的事件 ID
        assert body1["id"] != body2["id"]
