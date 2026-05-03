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

def _get_test_db_url() -> str:
    """确定测试数据库连接 URL。

    优先级:
    1. TEST_DATABASE_URL 环境变量（显式完整 URL 覆盖）
    2. TEST_DB_HOST 环境变量（仅覆盖 host 部分）
    3. 自动检测：Docker 环境 → postgres:5432
    4. 回退：localhost:5432

    本机开发：/app 目录不存在 /.dockerenv → 走 localhost。
    Docker 内部：/.dockerenv 存在 → 走 postgres:5432。
    CI 环境：设置 TEST_DATABASE_URL 显式指定。
    """
    explicit = os.environ.get("TEST_DATABASE_URL")
    if explicit:
        return explicit

    is_docker = os.path.exists("/.dockerenv") or os.environ.get("KAAS_DOCKER") == "true"
    host = os.environ.get("TEST_DB_HOST", "postgres" if is_docker else "localhost")

    return f"postgresql+asyncpg://kaas:kaas_dev@{host}:5432/kaas_v2_test"


TEST_DATABASE_URL = _get_test_db_url()


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


async def _seed_int_r3_data(engine):
    """为 INT-R3 集成测试种子数据（仅表空时插入）。"""
    from app.db.models import (
        ProductSpec, CustomerCostItem, CustomerSalePriceItem,
        CustomerPricingProfile, CustomerFreightRate,
    )
    from sqlalchemy import select, func
    from sqlalchemy.ext.asyncio import AsyncSession

    async with AsyncSession(engine) as session:
        result = await session.execute(select(func.count()).select_from(ProductSpec))
        if result.scalar() > 0:
            return

        specs = [
            ProductSpec(product_category="牛栏网", product_type="上疏下密", wire_diameter="2.0x1.8", height=1.5, mesh_width=15.0, roll_length=50.0, weight_kg=26.0, spec_hash="nlw_ssxm_20x18_15_15_50"),
            ProductSpec(product_category="牛栏网", product_type="上疏下密", wire_diameter="2.0x1.8", height=1.8, mesh_width=15.0, roll_length=50.0, weight_kg=31.2, spec_hash="nlw_ssxm_20x18_18_15_50"),
            ProductSpec(product_category="牛栏网", product_type="上疏下密", wire_diameter="2.5x2.0", height=1.5, mesh_width=15.0, roll_length=50.0, weight_kg=32.5, spec_hash="nlw_ssxm_25x20_15_15_50"),
            ProductSpec(product_category="牛栏网", product_type="上疏下密", wire_diameter="2.5x2.0", height=1.8, mesh_width=15.0, roll_length=50.0, weight_kg=39.0, spec_hash="nlw_ssxm_25x20_18_15_50"),
            ProductSpec(product_category="牛栏网", product_type="环扣", wire_diameter="2.0x1.8", height=1.5, mesh_width=15.0, roll_length=50.0, weight_kg=24.0, spec_hash="nlw_hk_20x18_15_15_50"),
            ProductSpec(product_category="牛栏网", product_type="环扣", wire_diameter="2.5x2.0", height=1.8, mesh_width=15.0, roll_length=50.0, weight_kg=36.0, spec_hash="nlw_hk_25x20_18_15_50"),
            ProductSpec(product_category="立柱", product_type="直边", height=1.5, bundle_size=10, weight_kg=18.5, spec_hash="post_straight_15_10"),
            ProductSpec(product_category="立柱", product_type="直边", height=1.8, bundle_size=10, weight_kg=22.0, spec_hash="post_straight_18_10"),
            ProductSpec(product_category="立柱", product_type="直边", height=2.0, bundle_size=10, weight_kg=25.0, spec_hash="post_straight_20_10"),
            ProductSpec(product_category="立柱", product_type="花边", height=1.5, bundle_size=10, weight_kg=20.0, spec_hash="post_deco_15_10"),
            ProductSpec(product_category="立柱", product_type="花边", height=1.8, bundle_size=10, weight_kg=24.0, spec_hash="post_deco_18_10"),
        ]
        for s in specs:
            session.add(s)

        for c in [
            CustomerCostItem(tenant_id="liankai", customer_id="liankai", product_category="牛栏网", spec_hash="nlw_ssxm_20x18_15_15_50", cost_type="cost_per_kg", amount=4.82, currency="CNY", unit="kg", source="seed"),
            CustomerCostItem(tenant_id="liankai", customer_id="liankai", product_category="牛栏网", spec_hash="nlw_ssxm_20x18_18_15_50", cost_type="cost_per_kg", amount=4.82, currency="CNY", unit="kg", source="seed"),
            CustomerCostItem(tenant_id="liankai", customer_id="liankai", product_category="牛栏网", spec_hash="nlw_ssxm_25x20_15_15_50", cost_type="cost_per_kg", amount=5.10, currency="CNY", unit="kg", source="seed"),
            CustomerCostItem(tenant_id="client_b", customer_id="client_b", product_category="牛栏网", spec_hash="nlw_ssxm_20x18_15_15_50", cost_type="cost_per_kg", amount=5.50, currency="CNY", unit="kg", source="seed"),
            CustomerCostItem(tenant_id="liankai", customer_id="liankai", product_category="立柱", spec_hash="post_straight_18_10", cost_type="cost_per_bundle", amount=180.0, currency="CNY", unit="捆", source="seed"),
            CustomerCostItem(tenant_id="liankai", customer_id="liankai", product_category="立柱", spec_hash="post_straight_20_10", cost_type="cost_per_bundle", amount=210.0, currency="CNY", unit="捆", source="seed"),
        ]:
            session.add(c)

        session.add(CustomerSalePriceItem(tenant_id="client_b", customer_id="client_b", product_category="牛栏网", spec_hash="nlw_ssxm_20x18_15_15_50", sale_price_type="sale_per_roll", amount=165.0, currency="CNY", unit="卷", source="seed"))

        for p in [
            CustomerPricingProfile(tenant_id="liankai", customer_id="liankai", product_category="牛栏网", profile_name="default", low_margin_rate=1.10, standard_margin_rate=1.15, high_margin_rate=1.20, tax_rate=0.0, source="seed"),
            CustomerPricingProfile(tenant_id="client_b", customer_id="client_b", product_category="牛栏网", profile_name="default", low_margin_rate=1.08, standard_margin_rate=1.12, high_margin_rate=1.18, tax_rate=0.0, source="seed"),
        ]:
            session.add(p)

        for f in [
            CustomerFreightRate(tenant_id="liankai", customer_id="liankai", carrier="顺丰干配", province="四川", formula_type="base_plus_weight", base_fee=180.0, threshold_kg=50, per_kg_after_threshold=1.5, min_weight_kg=10, source="seed"),
            CustomerFreightRate(tenant_id="liankai", customer_id="liankai", carrier="顺丰零担", province="四川", formula_type="per_kg", per_kg_after_threshold=2.0, source="seed"),
            CustomerFreightRate(tenant_id="liankai", customer_id="liankai", carrier="圆通", province="河南", formula_type="base_plus_weight", base_fee=120.0, threshold_kg=30, per_kg_after_threshold=1.2, min_weight_kg=10, source="seed"),
            CustomerFreightRate(tenant_id="client_b", customer_id="client_b", carrier="京东物流", province="四川", formula_type="base_plus_weight", base_fee=200.0, threshold_kg=50, per_kg_after_threshold=1.8, min_weight_kg=10, source="seed"),
        ]:
            session.add(f)

        await session.commit()


@pytest.fixture
async def db_engine():
    """Per-test 测试数据库引擎，首次运行时自动 Alembic migration + create_all + INT-R3 种子数据。"""
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

        await _seed_int_r3_data(engine)
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
