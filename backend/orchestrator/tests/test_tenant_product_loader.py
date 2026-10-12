"""`TenantProductLoader` 的团队谓词（task-4 / 迁移 `202610110019`）。

背景：`tenant_products` 自迁移 `202610110019` 起有可空 `team_id` 列，唯一键收敛为
`(tenant_id, COALESCE(team_id, 0), product_key)` ⇒ 同租户同 key 可能有多行
（不同团队各一行 + 至多一行历史 NULL）。原查询用 `scalar_one_or_none()` 且**不**
按 team 过滤 ⇒ 多行时直接抛 `MultipleResultsFound`。

本文件钉住新的团队收敛口径（与 `kaas_common/workstation/product_scope.py`
的 `is_same_team` / `is_admin_role` 同源，**不另写一套判断**）：

| 情形 | 期望 | 依据 |
|---|---|---|
| 本团队行（`team_id == viewer_team_id`） | 优先返回 | Q1=B / Q6 |
| 别团队行 | **不返回**（跳过，回退 Python 定义或历史 NULL 行） | Q6 + §1.5（不泄露存在性） |
| 历史 `team_id IS NULL` | **仅管理员可见**（非管理员跳过） | D3/D4 |
| 无任何行 | 回退 Python 定义（`products.get`） | 既有语义不变 |

⚠️ 这些用例**不需要 Postgres**：用**假 session factory**（直接吐预设行，
`TenantProduct` ORM 仅在 `_fetch_tenant_product` 的 import 里出现）。
"""
from __future__ import annotations

import pytest

from app.services.export_quote.tenant_products import TenantProductLoader, spec_from_dict

pytestmark = pytest.mark.unit

TENANT = "default"
TEAM_A = 11
TEAM_B = 22
PRODUCT_KEY = "field_fence"   # 注册表里真实存在的产品（fallback 断言用）


# ── 假 session factory ──────────────────────────────────────────────────────

class _FakeRow:
    """最小 TenantProduct 行替身（只有 `_fetch_tenant_product` 会读的字段）。"""

    def __init__(self, team_id, spec):
        self.team_id = team_id
        self.spec = spec
        self.is_active = True


class _FakeResult:
    def __init__(self, rows):
        self._rows = rows

    def scalars(self):
        return self

    def all(self):
        return self._rows


class _FakeSession:
    def __init__(self, rows):
        self._rows = rows

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def execute(self, stmt):
        return _FakeResult(self._rows)


class _FakeSessionFactory:
    def __init__(self, rows):
        self._rows = list(rows)

    def __call__(self):
        return _FakeSession(self._rows)


def _spec_dict(key=PRODUCT_KEY, name="牛栏网"):
    """一个最小可被 `spec_from_dict` 解析的 spec dict（用于断言"取到了本团队行"）。"""
    return {"key": key, "name": name, "category_code": "cattle_fence"}


# ── 测试：同租户两团队同 key + 历史 NULL 行 ─────────────────────────────────

@pytest.mark.asyncio
async def test_本团队行优先_不抛MultipleResultsFound():
    """两团队同 key + 历史 NULL 行并存时，团队 A 拿到 A 的行，不抛异常。"""
    rows = [
        _FakeRow(TEAM_A, _spec_dict(name="A 家的")),
        _FakeRow(TEAM_B, _spec_dict(name="B 家的")),
        _FakeRow(None, _spec_dict(name="历史 NULL")),
    ]
    loader = TenantProductLoader(db_session_factory=_FakeSessionFactory(rows))
    spec = await loader.load(TENANT, PRODUCT_KEY, team_id=TEAM_A, role="user")
    assert spec is not None
    assert spec.name == "A 家的"


@pytest.mark.asyncio
async def test_别团队行不污染_团队B拿不到A的行():
    """团队 B 拿不到 A 的行（跳过，回退到 Python 定义或其它可见行）。"""
    rows = [
        _FakeRow(TEAM_A, _spec_dict(name="A 家的")),
    ]
    loader = TenantProductLoader(db_session_factory=_FakeSessionFactory(rows))
    spec = await loader.load(TENANT, PRODUCT_KEY, team_id=TEAM_B, role="user")
    # 没有任何 B 可见的 tenant_products 行 ⇒ 回退到 Python 注册表定义（field_fence 真实存在）
    assert spec is not None
    # 回退的是**注册表**定义，不是 A 的行
    from app.services.export_quote.products import get as get_product
    assert spec.name == get_product(PRODUCT_KEY).name


@pytest.mark.asyncio
async def test_历史NULL行仅管理员可见_非管理员跳过():
    """历史 `team_id IS NULL` 行：非管理员看不到，回退到 Python 定义。"""
    rows = [
        _FakeRow(None, _spec_dict(name="历史 NULL")),
    ]
    loader = TenantProductLoader(db_session_factory=_FakeSessionFactory(rows))
    spec = await loader.load(TENANT, PRODUCT_KEY, team_id=TEAM_A, role="user")
    assert spec is not None
    from app.services.export_quote.products import get as get_product
    assert spec.name == get_product(PRODUCT_KEY).name   # 回退注册表，不是历史 NULL 行


@pytest.mark.asyncio
async def test_历史NULL行管理员可见():
    """历史 `team_id IS NULL` 行：管理员可以看到（D3/D4 兜底）。"""
    rows = [
        _FakeRow(None, _spec_dict(name="历史 NULL")),
    ]
    loader = TenantProductLoader(db_session_factory=_FakeSessionFactory(rows))
    spec = await loader.load(TENANT, PRODUCT_KEY, team_id=TEAM_A, role="system_admin")
    assert spec is not None
    assert spec.name == "历史 NULL"


@pytest.mark.asyncio
async def test_同团队优先于历史NULL行():
    """本团队行与历史 NULL 行并存时，本团队行优先（历史 NULL 行是兜底，不是覆盖）。"""
    rows = [
        _FakeRow(None, _spec_dict(name="历史 NULL")),
        _FakeRow(TEAM_A, _spec_dict(name="A 家的")),
    ]
    loader = TenantProductLoader(db_session_factory=_FakeSessionFactory(rows))
    spec = await loader.load(TENANT, PRODUCT_KEY, team_id=TEAM_A, role="system_admin")
    assert spec is not None
    assert spec.name == "A 家的"


@pytest.mark.asyncio
async def test_无任何行回退注册表定义():
    """tenant_products 里没有可见行 ⇒ 回退 Python 注册表定义（`products.get`）。"""
    loader = TenantProductLoader(db_session_factory=_FakeSessionFactory([]))
    spec = await loader.load(TENANT, PRODUCT_KEY, team_id=TEAM_A, role="user")
    from app.services.export_quote.products import get as get_product
    assert spec is not None
    assert spec.key == get_product(PRODUCT_KEY).key


@pytest.mark.asyncio
async def test_cache按团队区分_不同团队不串味():
    """缓存 key 必须包含 team_id —— 否则团队 A 缓存后，团队 B 会拿到 A 的缓存。"""
    rows = [
        _FakeRow(TEAM_A, _spec_dict(name="A 家的")),
        _FakeRow(TEAM_B, _spec_dict(name="B 家的")),
    ]
    loader = TenantProductLoader(db_session_factory=_FakeSessionFactory(rows))
    spec_a = await loader.load(TENANT, PRODUCT_KEY, team_id=TEAM_A, role="user")
    spec_b = await loader.load(TENANT, PRODUCT_KEY, team_id=TEAM_B, role="user")
    assert spec_a.name == "A 家的"
    assert spec_b.name == "B 家的"


@pytest.mark.asyncio
async def test_spec_from_dict_形状兼容():
    """`spec_from_dict` 仍能解析最小 spec dict（形状回归）。"""
    spec = spec_from_dict(_spec_dict())
    assert spec.key == PRODUCT_KEY
    assert spec.name == "牛栏网"
