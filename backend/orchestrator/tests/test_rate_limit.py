"""Kaas v2 · Rate Limiter 测试 (§15.1)"""
import os
import pytest
pytestmark = pytest.mark.unit
from app.middleware.rate_limit import limiter, get_rate_limit_key


class TestRateLimitKey:
    def test_key_includes_tenant_id(self):
        """rate limit key 包含 X-Tenant-Id。"""
        from unittest.mock import MagicMock
        req = MagicMock()
        req.headers = {"X-Tenant-Id": "liankai"}
        req.client.host = "127.0.0.1"
        key = get_rate_limit_key(req)
        assert "liankai" in key
        assert "127.0.0.1" in key

    def test_key_defaults_to_unknown(self):
        """无 tenant_id → 'unknown'。"""
        from unittest.mock import MagicMock
        req = MagicMock()
        req.headers = {}
        req.client.host = "10.0.0.1"
        key = get_rate_limit_key(req)
        assert key.startswith("unknown:")


class TestRateLimiterConfig:
    def test_default_limit_set(self):
        """limiter 有默认限制。"""
        assert limiter._default_limits is not None

    def test_storage_uri(self):
        """默认使用 memory storage。"""
        assert "memory" in (limiter._storage_uri or "")
