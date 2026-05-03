"""Kaas v2 · 测试 fixtures。

提供: async test client / mock OSS / 租户 config 覆盖 / test DB 清理。
"""
import os
from unittest.mock import MagicMock, patch

import pytest
from httpx import AsyncClient, ASGITransport
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession

from app.db.base import Base
from app.main import app

TEST_DATABASE_URL = os.environ.get(
    "TEST_DATABASE_URL",
    "postgresql+asyncpg://kaas:kaas_dev@localhost:5432/kaas_dev",
)


@pytest.fixture(autouse=True)
def _override_tenant_config(monkeypatch):
    """注入测试用租户配置，避免依赖 tenants.yaml 文件。
    必须 patch 所有 import load_tenant_config 的模块。"""

    def _mock_load(tenant_id):
        tenants = {
            "liankai": {
                "display_name": "联凯五金",
                "enabled": True,
                "feature_flags": {"use_v2": True, "sampling_rate": 0.5},
                "product_categories": ["牛栏网"],
            },
            "client_b": {
                "display_name": "客户 B",
                "enabled": True,
                "feature_flags": {"use_v2": False, "sampling_rate": 0.1},
                "product_categories": ["石笼网"],
            },
            "disabled_tenant": {
                "display_name": "已禁用",
                "enabled": False,
                "feature_flags": {},
            },
        }
        tenant = tenants.get(tenant_id)
        if tenant and not tenant.get("enabled", True):
            return None
        return tenant

    monkeypatch.setattr("app.middleware.tenant.load_tenant_config", _mock_load)
    monkeypatch.setattr("app.middleware.sampling.load_tenant_config", _mock_load)
    monkeypatch.setattr("app.middleware.route_version.load_tenant_config", _mock_load)


@pytest.fixture
def minio_mock():
    """Mock MinIO 客户端，避免测试依赖真实 OSS。"""
    with patch("app.api.oss_presign._get_minio_client") as mock:
        client = MagicMock()
        client.bucket_exists.return_value = True
        client.presigned_put_object.return_value = (
            "http://mock-minio:9000/bucket/obj?signature=mock"
        )
        mock.return_value = client
        yield mock


@pytest.fixture
def minio_archive_mock():
    """Mock MinIO 客户端（archive job 专用）。"""
    with patch("app.jobs.archive._get_minio_client") as mock:
        client = MagicMock()
        client.bucket_exists.return_value = True
        mock.return_value = client
        yield mock


@pytest.fixture(scope="session")
def test_engine():
    """创建测试数据库引擎（session 级别，复用）。"""
    engine = create_async_engine(TEST_DATABASE_URL, echo=False)
    yield engine


_ENGINE_AVAILABLE = None


@pytest.fixture(autouse=True)
async def _cleanup_db(test_engine):
    """每次测试后清理 events 表数据（保留表结构）。
    如果数据库不可用则静默跳过（archive 等 mock 测试不需要 DB）。
    """
    global _ENGINE_AVAILABLE
    yield
    if _ENGINE_AVAILABLE is False:
        return
    try:
        async with test_engine.begin() as conn:
            for table in reversed(Base.metadata.sorted_tables):
                try:
                    await conn.execute(text(f"DELETE FROM {table.name}"))
                except Exception:
                    pass  # 表可能由 W2+ 迁移创建，当前 W1 不存在
        _ENGINE_AVAILABLE = True
    except Exception:
        _ENGINE_AVAILABLE = False


@pytest.fixture
async def async_client():
    """创建异步 HTTP 测试客户端。"""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield client
