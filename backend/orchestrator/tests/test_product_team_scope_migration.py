"""迁移 `202610110019` 的**离线 DDL** 断言（无需数据库、无 skip）。

为什么能无库验证
================

`alembic upgrade <prev>:<rev> --sql` 是**离线模式**：只渲染 SQL、不连库
（本机没有 Postgres，这条通路是 task-5 实测出来的，见
`docs/PRODUCT_MODULE_IMPL_PLAN.md` §1.4 的 L0）。本文件把它**程序化**成单测：
只要迁移脚本能被解析、链接正确、渲染出的 DDL 含我们承诺的约束，就通过；
一旦有人改坏迁移（丢约束 / 改错连接 / 动了不该动的主键），立刻红。

它在钉三类东西
==============

1. **该有的必须有**（§8.1 裁决后的 P5）：
   - 三张表加 `team_id`（**可空** —— 历史容忍 NULL，D3/D4）
   - `team_id` 的外键指向 `teams`（`ON DELETE SET NULL`）
   - `uq_tenant_products_key` 改成按团队（`COALESCE(team_id, 0)`，Q7 允许重名）
   - `uq_file_primary` 重建含团队（Q1=B：两个团队各自能有主图）
2. **"折叠 NULL" 必须表达出来**：唯一键里用 `COALESCE(team_id, 0)` 而不是裸列 ——
   裸 NULL 在唯一索引里互不相等，挡不住"一个产品多行无归属基础信息"。
3. **故意不做的必须仍然没做**（这条同样重要）：
   `product_profiles` 主键与 `uq_tenant_ws_product` **不许**在本迁移里改 ——
   它们的调用方用 `ON CONFLICT` 精确锁定了这两组列
   （`files.py:283` / `ws_files.py:319` / `ws_products.py:347`），
   只改库不改代码会让那些 INSERT 直接报
   `no unique or exclusion constraint matching the ON CONFLICT specification`。
   它们必须在 P9 与两端代码**同批**改 —— 本用例就是防止有人在这里"顺手"改掉。

⚠️ `NOT NULL` 也不许出现：裁决是"**新写入**强制、**历史容忍 NULL**"，
库上写 `NOT NULL` 会与历史行冲突（且会被迫给历史行编一个 team，裁决不允许）。
"""
from __future__ import annotations

import io
import os
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config

pytestmark = pytest.mark.unit

#: 迁移的上下界（本迁移的 down_revision / revision）
PREV_REV = "202610110018"
THIS_REV = "202610110019"

_ORCH = Path(__file__).resolve().parent.parent
_ALEMBIC_INI = _ORCH / "alembic.ini"
#: 离线模式其实不连库，但 env.py 需要一个**可解析**的 URL（它会 make_url）
_DUMMY_URL = "postgresql+asyncpg://kaas:kaas_dev@localhost:5432/kaas_v2_test"


def _offline_sql(base: str, head: str, *, downgrade: bool = False) -> str:
    """渲染 `base -> head`（或反向 `head -> base`）的 SQL（离线，不连库）。

    ⚠️ 反向必须用 `command.downgrade`：用 `upgrade` 传一个"从新到旧"的区间
    只会渲染出 BEGIN/COMMIT（空迁移），**看着像通过**（我第一版就是这么错的）。
    """
    cfg = Config(str(_ALEMBIC_INI))
    cfg.set_main_option("script_location", str(_ORCH / "alembic"))
    cfg.set_main_option("sqlalchemy.url", _DUMMY_URL)
    buf = io.StringIO()
    cfg.output_buffer = buf  # alembic 离线模式的输出落点
    old = os.environ.get("DATABASE_URL")
    os.environ["DATABASE_URL"] = _DUMMY_URL   # env.py:82-85 环境变量优先
    try:
        if downgrade:
            command.downgrade(cfg, f"{base}:{head}", sql=True)
        else:
            command.upgrade(cfg, f"{base}:{head}", sql=True)
    finally:
        if old is None:
            os.environ.pop("DATABASE_URL", None)
        else:
            os.environ["DATABASE_URL"] = old
    return buf.getvalue()


@pytest.fixture(scope="module")
def ddl() -> str:
    return _offline_sql(PREV_REV, THIS_REV)


@pytest.fixture(scope="module")
def down_ddl() -> str:
    return _offline_sql(THIS_REV, PREV_REV, downgrade=True)


def _flat(sql: str) -> str:
    """把 DDL 压成单行空白归一形态，便于做"包含"断言（不受换行/缩进影响）。"""
    return " ".join(sql.split())


# ── 0. 迁移链与脚本本身 ─────────────────────────────────────────────────────

class TestMigrationIsLinkedAndParsable:
    def test_revision与down_revision正确(self):
        import importlib.util

        path = _ORCH / "alembic" / "versions" / "202610110019_product_team_scope.py"
        spec = importlib.util.spec_from_file_location("mig_019", path)
        mod = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(mod)
        assert mod.revision == THIS_REV
        assert mod.down_revision == PREV_REV

    def test_能离线渲染出SQL而不是空(self, ddl):
        assert f"Running upgrade {PREV_REV} -> {THIS_REV}" in ddl
        assert len(ddl) > 500, ddl[:200]

    def test_离线渲染不需要数据库(self, ddl):
        # 若它偷偷连了库，本机没有 Postgres ⇒ 上面早就抛异常了；
        # 这里再确认输出的是纯 DDL 文本
        assert "ALTER TABLE" in ddl or "CREATE" in ddl


# ── 1. 该有的必须有 ─────────────────────────────────────────────────────────

class TestRequiredChanges:
    def test_三张表都加了team_id_且可空(self, ddl):
        flat = _flat(ddl)
        for table in ("product_profiles", "tenant_products", "tenant_workstation_products"):
            stmt = f"ALTER TABLE {table} ADD COLUMN team_id BIGINT"
            assert stmt in flat, stmt
        # 裁决：历史容忍 NULL ⇒ 迁移里**不许**出现 team_id 的 NOT NULL
        assert "team_id BIGINT NOT NULL" not in flat
        assert "ALTER COLUMN team_id SET NOT NULL" not in flat

    def test_team_id_都有指向teams的外键且SET_NULL(self, ddl):
        flat = _flat(ddl)
        for table in ("product_profiles", "tenant_products", "tenant_workstation_products"):
            fk = f"ALTER TABLE {table} ADD CONSTRAINT fk_{table}_team FOREIGN KEY(team_id) REFERENCES teams (id) ON DELETE SET NULL"
            assert fk in flat, fk

    def test_三张表都有team索引(self, ddl):
        flat = _flat(ddl)
        for table in ("product_profiles", "tenant_products", "tenant_workstation_products"):
            idx = f"CREATE INDEX idx_{table}_team ON {table} (team_id)"
            assert idx in flat, idx

    def test_租户产品唯一键改按团队并折叠NULL(self, ddl):
        flat = _flat(ddl)
        assert "DROP INDEX uq_tenant_products_key" in flat
        # 关键：必须含 COALESCE 折叠，而不是裸 team_id
        assert ("CREATE UNIQUE INDEX uq_tenant_products_key ON tenant_products "
                "(tenant_id, COALESCE(team_id, 0), product_key)") in flat, flat[-400:]

    def test_产品主图唯一键重建含团队并保留部分索引条件(self, ddl):
        flat = _flat(ddl)
        assert "DROP INDEX uq_file_primary" in flat
        assert ("CREATE UNIQUE INDEX uq_file_primary ON file_objects "
                "(tenant_id, COALESCE(team_id, 0), owner_type, owner_id, kind) "
                "WHERE is_primary AND is_current") in flat, flat[-400:]


# ── 2. "折叠 NULL" 的表达（而不是裸列）─────────────────────────────────────

class TestNullCollapsing:
    def test_两个唯一键都用COALESCE而不是裸team_id(self, ddl):
        flat = _flat(ddl)
        assert "(tenant_id, COALESCE(team_id, 0), product_key)" in flat
        assert "(tenant_id, COALESCE(team_id, 0), owner_type, owner_id, kind)" in flat
        # 反面：裸 team_id 进唯一键会让多行 NULL 并存（挡不住重复）
        assert "ON tenant_products (tenant_id, team_id, product_key)" not in flat
        assert "ON file_objects (tenant_id, team_id, owner_type" not in flat


# ── 3. P9 补做的两处唯一键（**不再是"故意不做"**）──────────────────────────

class TestP9UniqueKeyConvergence:
    """首版 019 把这两处**故意留给 P9**（理由：调用方用 `ON CONFLICT` 锁定了列，
    只改库不改代码会让 INSERT 直接报 "no unique or exclusion constraint matching …"）。
    P9 已把库与两端代码**同批**改完 ⇒ 本类断言它们**现在必须做到**。

    两端是否真的对齐，另有一条跨文件用例
    （`test_team_scope_unique_keys_consistency.py`）把索引键与三处冲突目标逐元素比对。
    """

    def test_product_profiles主键换成按团队的唯一索引(self, ddl):
        flat = _flat(ddl)
        assert "ALTER TABLE product_profiles DROP CONSTRAINT product_profiles_pkey" in flat, flat
        assert ("CREATE UNIQUE INDEX uq_product_profiles_scope ON product_profiles "
                "(tenant_id, COALESCE(team_id, 0), product_key)") in flat, flat

    def test_uq_tenant_ws_product改成按团队(self, ddl):
        flat = _flat(ddl)
        assert "DROP INDEX uq_tenant_ws_product" in flat, flat
        assert ("CREATE UNIQUE INDEX uq_tenant_ws_product ON tenant_workstation_products "
                "(tenant_id, COALESCE(team_id, 0), workstation, product_key)") in flat, flat

    def test_两处新索引都折叠NULL_而不是裸team_id(self, ddl):
        flat = _flat(ddl)
        assert "CREATE UNIQUE INDEX uq_product_profiles_scope ON product_profiles (tenant_id, team_id" not in flat
        assert "CREATE UNIQUE INDEX uq_tenant_ws_product ON tenant_workstation_products (tenant_id, team_id" not in flat

    def test_团队字段仍不许是NOT_NULL(self, ddl):
        """裁决：**新写入**强制、**历史容忍 NULL** ⇒ 库上不能 NOT NULL（理由见迁移 docstring）。"""
        flat = _flat(ddl)
        assert "team_id BIGINT NOT NULL" not in flat
        assert "ALTER COLUMN team_id SET NOT NULL" not in flat

    def test_主键换掉后不能再出现旧形态主键(self, ddl):
        flat = _flat(ddl)
        # 只许 DROP（换掉），不许再 CREATE 出 (tenant_id, product_key) 的主键
        assert "ADD CONSTRAINT product_profiles_pkey" not in flat
        assert "PRIMARY KEY (tenant_id, product_key)" not in flat


# ── 4. downgrade 也必须能离线渲染（回滚不通的迁移等于没有回滚）──────────────

class TestDowngradeRenders:
    def test_downgrade反向渲染成功(self, down_ddl):
        assert f"Running downgrade {THIS_REV} -> {PREV_REV}" in down_ddl
        flat = _flat(down_ddl)
        # 把四个唯一键/主键还原成迁移前的定义
        assert ("CREATE UNIQUE INDEX uq_tenant_products_key ON tenant_products "
                "(tenant_id, product_key)") in flat
        assert ("CREATE UNIQUE INDEX uq_file_primary ON file_objects "
                "(tenant_id, owner_type, owner_id, kind) "
                "WHERE is_primary AND is_current") in flat
        assert ("CREATE UNIQUE INDEX uq_tenant_ws_product ON tenant_workstation_products "
                "(tenant_id, workstation, product_key)") in flat
        assert "ADD CONSTRAINT product_profiles_pkey PRIMARY KEY (tenant_id, product_key)" in flat
        # 撤掉 team_id 三件套
        for table in ("product_profiles", "tenant_products", "tenant_workstation_products"):
            assert f"ALTER TABLE {table} DROP COLUMN team_id" in flat, table

    def test_downgrade把两处P9唯一键也还原了(self, down_ddl):
        """P9 补做的两处必须**成对**可回滚（换掉的不还回去 = 回滚不完整）。"""
        flat = _flat(down_ddl)
        assert "ADD CONSTRAINT product_profiles_pkey PRIMARY KEY (tenant_id, product_key)" in flat
        assert ("CREATE UNIQUE INDEX uq_tenant_ws_product ON tenant_workstation_products "
                "(tenant_id, workstation, product_key)") in flat
        # 新形态的唯一索引在 downgrade 里必须先被丢掉
        assert "DROP INDEX uq_product_profiles_scope" in flat
        assert "DROP INDEX uq_tenant_ws_product" in flat

