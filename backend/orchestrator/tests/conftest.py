"""Kaas v2 · 测试 fixtures。

提供: async test client / mock OSS / 租户 config 覆盖 / test DB 会话。
"""
import os
import sys
from unittest.mock import MagicMock, patch

if sys.platform == "win32":
    import asyncio
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

import pytest
from httpx import AsyncClient, ASGITransport
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker

from app.main import app

TEST_DATABASE_URL = os.environ.get(
    "TEST_DATABASE_URL",
    "postgresql+asyncpg://kaas:kaas_dev@localhost:5432/kaas_v2_test",
)


@pytest.fixture(autouse=True)
def _override_tenant_config(monkeypatch):
    """注入测试用租户配置（§3.7.15 schema 对齐）。"""

    def _mock_load(tenant_id):
        tenants = {
            "liankai": {
                "display_name": "联凯五金",
                "locale": "zh-CN",
                "region": "cn-east-1",
                "status": "active",
                "enabled": True,
                "feature_flags": {"use_v2": True, "sampling_rate": 0.5},
                "product_categories": ["牛栏网"],
            },
            "client_b": {
                "display_name": "客户 B",
                "locale": "zh-CN",
                "region": "cn-east-1",
                "status": "active",
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


# ─── T1 · 测试数据库 fixtures ───

_DB_INITIALIZED = False


@pytest.fixture
async def db_engine():
    """Per-test 测试数据库引擎，首次运行时自动 Alembic migration + create_all。"""
    global _DB_INITIALIZED
    from app.db.base import Base

    engine = create_async_engine(TEST_DATABASE_URL, echo=False)

    if not _DB_INITIALIZED:
        from alembic.config import Config
        from alembic.command import upgrade
        old_url = os.environ.get("DATABASE_URL")
        os.environ["DATABASE_URL"] = TEST_DATABASE_URL
        try:
            alembic_cfg = Config("alembic.ini")
            upgrade(alembic_cfg, "head")
        finally:
            if old_url is not None:
                os.environ["DATABASE_URL"] = old_url
            else:
                os.environ.pop("DATABASE_URL", None)

        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        _DB_INITIALIZED = True

    yield engine
    await engine.dispose()


@pytest.fixture
async def db_session(db_engine):
    """Per-test DB 会话，事务隔离 + rollback（不污染数据）。"""
    _async_session = async_sessionmaker(
        db_engine, class_=AsyncSession, expire_on_commit=False,
    )
    async with _async_session() as session:
        async with session.begin() as trans:
            yield session
            await trans.rollback()


@pytest.fixture
async def client(db_session):
    """带测试 DB 依赖注入的 async HTTP client。"""
    from app.db.session import get_db_session

    async def override_get_db():
        yield db_session

    app.dependency_overrides[get_db_session] = override_get_db

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c

    app.dependency_overrides.clear()


# ─── Unit-test client (无 DB 依赖) ───


@pytest.fixture
async def async_client():
    """Async HTTP client 无 DB override（纯 unit test 用）。"""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


# ─── 测试辅助：标准 event payload ───


def make_event_body(
    event_type: str = "chat.turn",
    schema_version: int = 1,
    event_source: str = "frontend",
    payload: dict | None = None,
    **kwargs,
) -> dict:
    """创建符合 §3.7.8 标准的 event 请求 body。"""
    defaults: dict = {
        "event_type": event_type,
        "schema_version": schema_version,
        "event_source": event_source,
    }
    if event_type == "chat.turn":
        defaults.setdefault("payload", {
            "session_id": kwargs.pop("session_id", "sess-test"),
            "raw_text": kwargs.pop("raw_text", "测试消息"),
            "agent_id": kwargs.pop("agent_id", "agent-1"),
            "customer_id": kwargs.pop("customer_id", "cust-1"),
            "response_text": kwargs.pop("response_text", "响应"),
            "llm_model": kwargs.pop("llm_model", "test-model"),
            "llm_tokens_in": kwargs.pop("llm_tokens_in", 10),
            "llm_tokens_out": kwargs.pop("llm_tokens_out", 5),
        })
    elif event_type == "quote.request":
        defaults.setdefault("payload", {
            "session_id": kwargs.pop("session_id", "sess-test"),
            "customer_id": kwargs.pop("customer_id", "cust-1"),
            "product_category": kwargs.pop("product_category", "牛栏网"),
            "product_spec": kwargs.pop("product_spec", {"mesh": "50x50"}),
            "quantity": kwargs.pop("quantity", 100),
        })
    elif payload is not None:
        defaults["payload"] = payload
    else:
        defaults["payload"] = {}
    return defaults
