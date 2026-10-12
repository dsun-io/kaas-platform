"""`_effective_product` 的团队谓词（task-5 / P13）。

背景：`_effective_product` 原来只查 Python 注册表（`products.get`），现在改为
走 `TenantProductLoader`（租户级 `tenant_products` 优先，回退 Python 定义），
使 tenant_products 平行账本能进规格空间与算价。顺序固定
「产品定义 → 并入买家自加档位 → 套团队覆盖」，不打乱。

本文件钉住三条语义：

| 情形 | 期望 | 依据 |
|---|---|---|
| 有 tenant_products 行（spec 不同于注册表） | 返回**该行的 spec**（不是注册表的） | P13 目标 |
| 无 tenant_products 行 | 回退 Python 注册表定义 | 既有语义不变 |
| 团队 B 的行不污染 A | A 拿到 A 的行（或注册表），拿不到 B 的行 | Q6 + §1.5 |

⚠️ 这些用例**不需要 Postgres**：用假 DB session + 假 `TenantProduct` ORM 行。
"""
from __future__ import annotations

import pytest

from app.api.export_quote import _effective_product
from app.core.auth import AuthContext
from app.services.export_quote.tenant_products import spec_from_dict

pytestmark = pytest.mark.unit

TENANT = "default"
TEAM_A = 11
TEAM_B = 22
PRODUCT_KEY = "field_fence"   # 注册表里真实存在的产品


# ── 假 DB session + 假 TenantProduct 行 ────────────────────────────────────

class _FakeResult:
    def __init__(self, rows):
        self._rows = rows

    def scalars(self):
        return self

    def all(self):
        return self._rows

    def first(self):
        return self._rows[0] if self._rows else None


class _FakeRow:
    def __init__(self, team_id, spec):
        self.team_id = team_id
        self.spec = spec
        self.is_active = True
        # 下游 pricing_table.load_option_extensions 会读这些字段
        self.product_spec_json = {}
        self.source = "test"


class _FakeDBSession:
    """假 DB session：按 SQL 里的表名分发结果。

    `TenantProduct` 行来自 `rows`；`TeamOptionOverride` / `customer_cost_items`
    等下游查询一律返回空（避免 AttributeError）。
    """

    def __init__(self, rows):
        self._rows = list(rows)

    async def execute(self, stmt):
        sql = str(stmt)
        if "tenant_products" in sql:
            return _FakeResult(self._rows)
        return _FakeResult([])   # 下游 pricing_table / team_overrides 一律空


def _spec_dict(key=PRODUCT_KEY, name="牛栏网"):
    """一个最小可被 `spec_from_dict` 解析的 spec dict（与注册表 spec 不同）。"""
    return {"key": key, "name": name, "category_code": "cattle_fence"}


def _auth(team_id=TEAM_A, role="user"):
    return AuthContext(user_id=1, account_type="internal", role=role,
                       tenant_id=TENANT, team_id=team_id)


# ── 1. 有 tenant_products 行 ⇒ 返回该行 spec（不是注册表的）─────────────────

@pytest.mark.asyncio
async def test_tenant_products行优先_返回该行spec():
    """tenant_products 里有行（spec 不同于注册表）⇒ `_effective_product` 返回该 spec。"""
    db = _FakeDBSession([_FakeRow(TEAM_A, _spec_dict(name="A 家自定义"))])
    spec = await _effective_product(db, _auth(team_id=TEAM_A), PRODUCT_KEY)
    assert spec is not None
    assert spec.name == "A 家自定义"


# ── 2. 无 tenant_products 行 ⇒ 回退注册表定义 ────────────────────────────────

@pytest.mark.asyncio
async def test_无行时回退注册表定义():
    """tenant_products 里没有可见行 ⇒ 回退 Python 注册表定义。"""
    db = _FakeDBSession([])
    spec = await _effective_product(db, _auth(team_id=TEAM_A), PRODUCT_KEY)
    assert spec is not None
    from app.services.export_quote.products import get as get_product
    assert spec.name == get_product(PRODUCT_KEY).name


# ── 3. 团队 B 的行不污染 A ──────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_团队B的行不污染A():
    """团队 B 的 tenant_products 行对 A 不可见 ⇒ A 拿到注册表定义（不是 B 的行）。"""
    db = _FakeDBSession([_FakeRow(TEAM_B, _spec_dict(name="B 家自定义"))])
    spec = await _effective_product(db, _auth(team_id=TEAM_A), PRODUCT_KEY)
    assert spec is not None
    from app.services.export_quote.products import get as get_product
    assert spec.name == get_product(PRODUCT_KEY).name   # 回退注册表，不是 B 的行


@pytest.mark.asyncio
async def test_团队A的行不污染B():
    """团队 A 的 tenant_products 行对 B 不可见 ⇒ B 拿到注册表定义（不是 A 的行）。"""
    db = _FakeDBSession([_FakeRow(TEAM_A, _spec_dict(name="A 家自定义"))])
    spec = await _effective_product(db, _auth(team_id=TEAM_B), PRODUCT_KEY)
    assert spec is not None
    from app.services.export_quote.products import get as get_product
    assert spec.name == get_product(PRODUCT_KEY).name


# ── 4. 产品不存在仍返回 None ─────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_产品不存在返回None():
    """产品不在注册表也不在 tenant_products ⇒ 返回 None（不抛异常）。"""
    db = _FakeDBSession([])
    spec = await _effective_product(db, _auth(team_id=TEAM_A), "nonexistent_product")
    assert spec is None


# ── 5. 空 product_key 返回 None ─────────────────────────────────────────────

@pytest.mark.asyncio
async def test_空product_key返回None():
    """product_key 为空 ⇒ 直接返回 None，不查库。"""
    db = _FakeDBSession([])
    spec = await _effective_product(db, _auth(team_id=TEAM_A), "")
    assert spec is None


# ── 6. 历史 NULL 行仅管理员可见 ─────────────────────────────────────────────

@pytest.mark.asyncio
async def test_历史NULL行管理员可见():
    """历史 `team_id IS NULL` 行：管理员可以看到（D3/D4 兜底）。"""
    db = _FakeDBSession([_FakeRow(None, _spec_dict(name="历史 NULL"))])
    spec = await _effective_product(db, _auth(team_id=TEAM_A, role="system_admin"), PRODUCT_KEY)
    assert spec is not None
    assert spec.name == "历史 NULL"


@pytest.mark.asyncio
async def test_历史NULL行非管理员不可见():
    """历史 `team_id IS NULL` 行：非管理员看不到，回退注册表定义。"""
    db = _FakeDBSession([_FakeRow(None, _spec_dict(name="历史 NULL"))])
    spec = await _effective_product(db, _auth(team_id=TEAM_A, role="user"), PRODUCT_KEY)
    assert spec is not None
    from app.services.export_quote.products import get as get_product
    assert spec.name == get_product(PRODUCT_KEY).name
