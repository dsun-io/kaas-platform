"""schema 完备性（方案 B 阶段二 S2）

worker 独有/历史遗留的 8 张表原先只存在于生产库（无迁移、无 ORM 模型），
空库快径 `metadata.create_all()` 建不出来 ⇒ 新环境相关接口必 500。
本测试钉住「这些表已在 metadata 里」，防止被误删。
"""
from __future__ import annotations

import pytest

from app.db.base import Base

pytestmark = pytest.mark.unit

LEGACY_TABLES = {
    "entity_links",
    "feature_flag_audit",
    "feature_flags",
    "file_objects",
    "product_profiles",
    "subscription_bundles",
    "subscriptions",
    "trade_doc_files",
}


def _metadata():
    # 与 alembic/env.py 同一份模型清单：必须显式 import 才会进 metadata
    from app.db import (  # noqa: F401
        actual_cost,
        external_docs,
        legacy_models,
        market_models,
        models,
        tax_models,
        workstation_links,
        workstation_models,
    )

    return Base.metadata


def test_legacy_tables_registered_in_metadata() -> None:
    tables = set(_metadata().tables)
    assert LEGACY_TABLES <= tables, f"缺表: {sorted(LEGACY_TABLES - tables)}"


def test_file_objects_key_columns_match_production_contract() -> None:
    columns = {c.name for c in _metadata().tables["file_objects"].columns}
    required = {
        "id",
        "tenant_id",
        "team_id",
        "owner_type",
        "owner_id",
        "kind",
        "media_kind",
        "name",
        "storage",
        "object_key",
        "content",
        "sha256",
        "version",
        "supersedes_id",
        "is_current",
        "is_primary",
        "sort_order",
    }
    assert required <= columns, f"缺列: {sorted(required - columns)}"


def test_product_profiles_has_no_primary_key() -> None:
    # 生产库该表无主键（唯一性靠函数唯一索引），DDL 必须保持一致
    table = _metadata().tables["product_profiles"]
    assert len(table.primary_key.columns) == 0
    assert "uq_product_profiles_scope" in {ix.name for ix in table.indexes}
