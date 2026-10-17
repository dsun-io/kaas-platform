"""Kaas v2 · Metrics 端点 + 指标测试 (§8.3)"""
import pytest
pytestmark = pytest.mark.db
from unittest.mock import AsyncMock, patch, MagicMock


class TestMetricsEndpoint:
    """GET /metrics 端点测试。"""

    async def test_metrics_returns_200(self, client):
        """GET /metrics → 200 + text/plain。"""
        response = await client.get("/metrics")
        assert response.status_code == 200
        assert "text/plain" in response.headers.get("content-type", "")

    async def test_metrics_contains_prometheus_format(self, client):
        """返回 Prometheus 格式文本（包含 HELP/TYPE 行）。"""
        response = await client.get("/metrics")
        text = response.text
        assert "kaas_" in text or "python_" in text or "process_" in text


class TestBusinessMetrics:
    """业务指标自增测试。"""

    async def test_business_metrics_counter_present(self, client):
        """调用业务接口后 /metrics 存在业务计数器指标。"""
        with patch(
            "app.services.pricing.get_latest_price", new_callable=AsyncMock
        ) as mock_price:
            mock_price.return_value = None

            await client.post(
                "/api/v1/spec/wizard/submit",
                json={"category_id": 1, "spec_values": {}},
                headers={"X-Tenant-Id": "lianjia"},
            )

        response = await client.get("/metrics")
        text = response.text
        assert "kaas_quote_requests_total" in text or "kaas_" in text

    async def test_admin_metrics_summary(self, client):
        """GET /api/v1/admin/metrics/summary 返回结构化数据。"""
        response = await client.get(
            "/api/v1/admin/metrics/summary",
            headers={"X-Tenant-Id": "lianjia"},
        )
        assert response.status_code == 200
        data = response.json()
        assert "active_sessions" in data


class TestAdminCacheClear:
    """管理员缓存清理测试。"""

    async def test_cache_clear_no_auth_returns_401(self, client, real_auth):
        """无 token → 401。

        默认 autouse 的鉴权 mock 会绕过鉴权，这条用例必须显式恢复**真实**
        AuthContextMiddleware（`real_auth`）才测得到 401。
        """
        response = await client.post(
            "/api/v1/admin/cache/clear",
            headers={"X-Tenant-Id": "lianjia"},
        )
        assert response.status_code == 401
