"""生产 schema 漂移回归：team 作用面必须与生产 DDL 逐列/逐索引一致。

2026-10-19 本地冒烟（S4 `local_run.py` + 全新空库）发现真实漂移：
`tenant_workstation_products` 在生产有 `team_id`（迁移 202610110019 加的，带 FK + 索引 +
函数唯一键），但 ORM 模型漏了 ⇒ 空库快径建出的表缺列 ⇒ worker 的
`GET /api/v1/export-quote/products` 直接 500（`UndefinedColumnError`）。
同一类问题还可能是「唯一索引形状」漂移（生产是 `COALESCE(team_id,0)` 函数索引，
模型写成裸可空列唯一键会让同一租户存在多行 NULL）。

本文件钉死两件事：
1. team 作用面 12 张表（8 业务表 + users + 3 张产品/档案表）都有 `team_id`；
2. 4 个函数唯一索引的表达式里必须含 `COALESCE(team_id, 0)`。
"""
from __future__ import annotations

import pytest

from app.db.base import Base

# 显式 import 所有模型模块 —— 与 alembic/env.py 同法，确保 metadata 完整
import app.db.models  # noqa: F401,E402
import app.db.legacy_models  # noqa: F401,E402
import app.db.tax_models  # noqa: F401,E402
from app.db import (  # noqa: F401,E402
    workstation_models,
    market_models,
    actual_cost,
    external_docs,
    workstation_links,
)

pytestmark = pytest.mark.unit

# 迁移 202610110001（8 张四域业务表）+ users + 迁移 202610110019（3 张产品/档案表）
_TEAM_TABLES = (
    "users",
    "cust_inquiries",
    "customers",
    "orders",
    "payment_schedules",
    "quote_orders",
    "receivables",
    "shipments",
    "trade_docs",
    "product_profiles",
    "tenant_products",
    "tenant_workstation_products",
)

_FUNC_UNIQUE = {
    "product_profiles": "uq_product_profiles_scope",
    "tenant_products": "uq_tenant_products_key",
    "tenant_workstation_products": "uq_tenant_ws_product",
    "file_objects": "uq_file_primary",
}


def test_team_scoped_tables_have_team_id() -> None:
    missing = [t for t in _TEAM_TABLES if "team_id" not in Base.metadata.tables[t].c]
    assert not missing, f"模型缺 team_id 列（生产有）：{missing}"


def test_functional_unique_indexes_match_production() -> None:
    for table, name in _FUNC_UNIQUE.items():
        tbl = Base.metadata.tables[table]
        idx = next((i for i in tbl.indexes if i.name == name), None)
        assert idx is not None, f"{table} 缺少唯一索引 {name}"
        exprs = [str(e) for e in idx.expressions]
        assert any("COALESCE" in e.upper() for e in exprs), (
            f"{table}.{name} 不是函数唯一索引（生产 DDL 用 COALESCE(team_id,0)）：{exprs}"
        )
        assert idx.unique, f"{table}.{name} 必须是 UNIQUE"


def test_tenant_workstation_products_team_fk_and_index() -> None:
    """2026-10-19 漂移现场：补列之外，FK 与索引也要与生产一致。"""
    tbl = Base.metadata.tables["tenant_workstation_products"]
    fk_targets = {
        fk.target_fullname for fk in tbl.foreign_keys if fk.parent.name == "team_id"
    }
    assert "teams.id" in fk_targets, f"team_id 缺 FK→teams.id：{fk_targets}"
    assert any(i.name == "idx_tenant_workstation_products_team" for i in tbl.indexes), (
        "缺 team_id 索引 idx_tenant_workstation_products_team"
    )
