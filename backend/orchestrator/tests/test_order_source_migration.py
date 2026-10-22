"""迁移 202610220004：订单来源与确认痕迹（设计 §3.2 / §3.3 / §5.1 · 2026-10-22）。

不连库：直接加载迁移模块并替换模块级 `op`，逐条断言 DDL 形状与回填 SQL。
真实 upgrade 由部署链路 / `test_kaas_common_db` 的存量库路径覆盖。
"""
from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

MIGRATION_PATH = (
    Path(__file__).resolve().parents[1]
    / "alembic" / "versions" / "202610220004_order_source_and_confirm.py"
)


class _FakeOp:
    def __init__(self):
        self.calls: list[tuple] = []

    def add_column(self, table, column):
        self.calls.append(("add_column", table, column.name, column.nullable,
                           str(column.server_default.arg) if column.server_default else None))

    def create_foreign_key(self, name, source, referent, local_cols, remote_cols, **kw):
        self.calls.append(("create_foreign_key", name, source, referent,
                           tuple(local_cols), tuple(remote_cols), kw.get("ondelete")))

    def create_index(self, name, table, columns, **kwargs):
        self.calls.append(("create_index", name, table, tuple(columns)))

    def create_check_constraint(self, name, table, condition, **kwargs):
        self.calls.append(("create_check_constraint", name, table, str(condition)))

    def drop_constraint(self, name, table, type=None, **kwargs):
        self.calls.append(("drop_constraint", name, table, type))

    def drop_index(self, name, table=None, **kwargs):
        self.calls.append(("drop_index", name, table))

    def drop_column(self, table, name, **kwargs):
        self.calls.append(("drop_column", table, name))

    def execute(self, statement):
        self.calls.append(("execute", str(statement)))


def _load_migration():
    spec = importlib.util.spec_from_file_location(
        "migration_202610220004", MIGRATION_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_revision_chain_is_appended_to_current_head():
    module = _load_migration()
    assert module.revision == "202610220004"
    assert module.down_revision == "202610220003"


def test_upgrade_adds_source_and_confirm_columns():
    module = _load_migration()
    fake = _FakeOp()
    module.op = fake

    module.upgrade()

    added = {c[2]: c for c in fake.calls if c[0] == "add_column"}
    assert set(added) == {
        "source_type", "source_channel", "inquiry_id",
        "confirmed_at", "confirmed_by", "confirmed_source",
    }
    # 订单默认是「直接下单」——存量单没有询盘，硬塞 inquiry 会撞 CHECK。
    assert added["source_type"][3] is False
    assert added["source_type"][4] == "direct"
    # 渠道/询盘/确认痕迹都可空：历史单的真实渠道无从得知，不伪造。
    for column in ("source_channel", "inquiry_id", "confirmed_at",
                   "confirmed_by", "confirmed_source"):
        assert added[column][3] is True, f"{column} 应为可空"


def test_upgrade_links_inquiry_with_set_null_fk_and_index():
    module = _load_migration()
    fake = _FakeOp()
    module.op = fake

    module.upgrade()

    fk = next(c for c in fake.calls if c[0] == "create_foreign_key")
    assert fk[1] == "fk_orders_inquiry_id"
    assert fk[2] == "orders" and fk[3] == "cust_inquiries"
    assert fk[4] == ("inquiry_id",) and fk[5] == ("id",)
    # 询盘被硬删时订单必须留存（历史凭证不能跟着消失），故 SET NULL。
    assert fk[6] == "SET NULL"

    index = next(c for c in fake.calls if c[0] == "create_index")
    assert index[1] == "idx_orders_inquiry"
    assert index[3] == ("tenant_id", "inquiry_id")


def test_upgrade_backfills_existing_quote_chain_orders():
    """存量「报价→订单」关系是既成事实，回填成 inquiry 来源，不靠人再录一遍。"""
    module = _load_migration()
    fake = _FakeOp()
    module.op = fake

    module.upgrade()

    executed = [c[1] for c in fake.calls if c[0] == "execute"]
    backfill = next(sql for sql in executed if "UPDATE orders" in sql)
    assert "source_type = 'inquiry'" in backfill
    assert "inquiry_id  = q.inquiry_id" in backfill
    assert "FROM quote_orders q" in backfill
    assert "o.quote_id = q.id" in backfill
    assert "q.inquiry_id IS NOT NULL" in backfill

    # 触发器列清单必须包含 inquiry_id，否则改 inquiry_id 不派生边。
    trigger = next(sql for sql in executed if "CREATE TRIGGER trg_orders_links" in sql)
    assert "UPDATE OF quote_id, inquiry_id" in trigger

    # 函数体要补 inquiry 边的软删与插入。
    fn = next(sql for sql in executed if "sync_order_links" in sql and "CREATE OR REPLACE" in sql)
    assert "OLD.inquiry_id IS DISTINCT FROM NEW.inquiry_id" in fn
    assert "'inquiry'" in fn

    # 'quote' 不是渠道而是来源类型，与 source_type 重复表达 → 归并 other。
    channel_fix = next(sql for sql in executed if "cust_inquiries" in sql)
    assert "channel = 'other'" in channel_fix
    assert "channel = 'quote'" in channel_fix


def test_upgrade_creates_three_check_constraints():
    module = _load_migration()
    fake = _FakeOp()
    module.op = fake

    module.upgrade()

    checks = {c[1]: c[3] for c in fake.calls if c[0] == "create_check_constraint"}
    assert set(checks) == {
        "ck_orders_source_type", "ck_orders_source_inquiry", "ck_orders_confirm_source",
    }
    # 设计 §3.3 R1：询盘转化单必须挂询盘，DB 层兜底。
    assert "source_type <> 'inquiry' OR inquiry_id IS NOT NULL" in checks["ck_orders_source_inquiry"]
    assert "source_type IN ('inquiry','direct')" in checks["ck_orders_source_type"]
    assert "confirmed_source IS NULL OR confirmed_source IN ('manual','deposit_receipt')" in (
        checks["ck_orders_confirm_source"])


def test_upgrade_orders_columns_before_backfill_before_constraints():
    """先加列 → 再回填 → 最后建 CHECK；顺序错了回填会撞约束。"""
    module = _load_migration()
    fake = _FakeOp()
    module.op = fake

    module.upgrade()

    kinds = [c[0] for c in fake.calls]
    last_add = max(i for i, k in enumerate(kinds) if k == "add_column")
    first_exec = min(i for i, k in enumerate(kinds) if k == "execute")
    first_check = min(i for i, k in enumerate(kinds) if k == "create_check_constraint")
    assert last_add < first_exec < first_check


def test_downgrade_removes_only_new_objects():
    module = _load_migration()
    fake = _FakeOp()
    module.op = fake

    module.downgrade()

    dropped_checks = {c[1] for c in fake.calls if c[0] == "drop_constraint"}
    assert dropped_checks == {
        "ck_orders_confirm_source", "ck_orders_source_inquiry", "ck_orders_source_type",
        # 外键也是 drop_constraint：先摘关联再删列，否则 drop_column 被依赖挡住。
        "fk_orders_inquiry_id",
    }
    dropped = {c[2] for c in fake.calls if c[0] == "drop_column"}
    assert dropped == {
        "confirmed_source", "confirmed_by", "confirmed_at",
        "inquiry_id", "source_channel", "source_type",
    }
    # 回填是单向的（原值已不可区分），downgrade 不得反向改订单/询盘的**数据**；
    # 允许的 execute 只涉及 entity_links 软删与触发器回退（DDL，不动行）。
    for sql in [c[1] for c in fake.calls if c[0] == "execute"]:
        assert "UPDATE orders" not in sql, f"downgrade 不得改 orders: {sql}"
        assert "UPDATE cust_inquiries" not in sql, f"downgrade 不得改 cust_inquiries: {sql}"


def test_orm_models_carry_new_structure():
    """create_all 空库快径依赖 ORM metadata ⇒ 新列/约束必须在模型里。"""
    from app.db import workstation_links  # noqa: F401
    from app.db.base import Base

    orders = Base.metadata.tables["orders"]
    for column in ("source_type", "source_channel", "inquiry_id",
                   "confirmed_at", "confirmed_by", "confirmed_source"):
        assert column in orders.columns, f"orders 缺列 {column}"
    assert orders.columns["source_type"].nullable is False

    names = {c.name for c in orders.constraints if c.name}
    assert "ck_orders_source_inquiry" in names
    assert "ck_orders_source_type" in names
    assert "ck_orders_confirm_source" in names

    indexes = {i.name for i in orders.indexes}
    assert "idx_orders_inquiry" in indexes
