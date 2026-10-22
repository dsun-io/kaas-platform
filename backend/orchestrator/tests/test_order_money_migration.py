"""迁移 202610220001：订单金额 / 实收登记 / 询盘多产品（设计 §13.3 · 2026-10-22）。

不连库：直接加载迁移模块并替换模块级 `op`，逐条断言 DDL 形状。
真实 upgrade 由部署链路 / `test_kaas_common_db` 的存量库路径覆盖。
"""
from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

MIGRATION_PATH = (
    Path(__file__).resolve().parents[1]
    / "alembic" / "versions" / "202610220001_order_amount_receipts.py"
)


class _FakeOp:
    def __init__(self):
        self.calls: list[tuple] = []

    def add_column(self, table, column):
        self.calls.append(("add_column", table, column.name, column.nullable,
                           str(column.server_default.arg) if column.server_default else None))

    def create_table(self, name, *columns, **kwargs):
        self.calls.append(("create_table", name, [c.name for c in columns]))

    def create_index(self, name, table, columns, **kwargs):
        self.calls.append(("create_index", name, table, tuple(columns)))

    def drop_table(self, name, **kwargs):
        self.calls.append(("drop_table", name))

    def drop_column(self, table, name, **kwargs):
        self.calls.append(("drop_column", table, name))

    def drop_index(self, name, table=None, **kwargs):
        self.calls.append(("drop_index", name, table))


def _load_migration():
    spec = importlib.util.spec_from_file_location(
        "migration_202610220001", MIGRATION_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_revision_chain_is_appended_to_current_head():
    module = _load_migration()
    assert module.revision == "202610220001"
    assert module.down_revision == "202610210002"


def test_upgrade_adds_columns_and_payment_receipts_without_touching_history():
    module = _load_migration()
    fake = _FakeOp()
    module.op = fake

    module.upgrade()

    kinds = [c[0] for c in fake.calls]
    assert kinds == [
        "add_column", "add_column", "create_table", "create_index", "create_index",
    ]

    added = {c[1]: c for c in fake.calls if c[0] == "add_column"}
    # 询盘多产品行：NOT NULL DEFAULT '[]'::jsonb（只加列，不回填、不改历史列）
    assert added["cust_inquiries"][2] == "items"
    assert added["cust_inquiries"][3] is False
    assert "[]" in added["cust_inquiries"][4]
    # 订单金额构成：可空 jsonb（历史订单没有明细）
    assert added["orders"][2] == "amount_breakdown"
    assert added["orders"][3] is True

    table = next(c for c in fake.calls if c[0] == "create_table")
    assert table[1] == "payment_receipts"
    for column in ("id", "tenant_id", "order_id", "schedule_id", "amount",
                   "currency", "received_date", "fx_rate", "file_id", "notes",
                   "created_by", "owner_id", "owner_scope", "team_id", "created_at"):
        assert column in table[2], f"payment_receipts 缺列 {column}"


def test_downgrade_removes_only_new_objects():
    module = _load_migration()
    fake = _FakeOp()
    module.op = fake

    module.downgrade()

    assert [c[0] for c in fake.calls] == [
        "drop_index", "drop_index", "drop_table", "drop_column", "drop_column",
    ]
    assert fake.calls[2][1] == "payment_receipts"
    dropped = {(c[1], c[2]) for c in fake.calls if c[0] == "drop_column"}
    assert dropped == {("orders", "amount_breakdown"), ("cust_inquiries", "items")}


def test_orm_models_carry_new_structure():
    """create_all 空库快径依赖 ORM metadata ⇒ 新列/新表必须在模型里。"""
    from app.db import workstation_links, workstation_models  # noqa: F401
    from app.db.base import Base

    assert "items" in Base.metadata.tables["cust_inquiries"].columns
    assert "amount_breakdown" in Base.metadata.tables["orders"].columns
    receipts = Base.metadata.tables["payment_receipts"]
    for column in ("order_id", "schedule_id", "amount", "received_date",
                   "fx_rate", "file_id", "owner_scope", "team_id"):
        assert column in receipts.columns
