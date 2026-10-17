"""空库快径（E1 · UNCERTAIN #20）—— `bootstrap_if_empty` 的判定分支。

历史迁移写于 `create_all` 时代、链序自相矛盾（`f82ac951b473` 无条件 create 36 张、
30 张重复），逐处修补是无底洞。裁决：空库跳过历史链（create_all + stamp head）、
存量库走老链（冻结）。

本测试**不连库**（判定是纯分支逻辑）：
- 空库（无表）→ create_all + stamp head，返回 True（调用方跳过 run_migrations）；
- 有 `alembic_version`（存量库）→ False，走老链；
- 有业务表但无版本记录（半初始化库）→ False，照走老链（不吞真实状态）。
"""
from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from app.db.migration_bootstrap import bootstrap_if_empty

pytestmark = pytest.mark.unit


def _connection_with_tables(tables: list[str]) -> tuple[MagicMock, MagicMock]:
    conn = MagicMock()
    inspector = MagicMock()
    inspector.get_table_names.return_value = tables
    return conn, inspector


def test_空库走快径_create_all加stamp返回True():
    conn, inspector = _connection_with_tables([])
    metadata = MagicMock()
    with patch("app.db.migration_bootstrap.sa_inspect", return_value=inspector):
        result = bootstrap_if_empty(conn, metadata, "head-rev")

    assert result is True
    metadata.create_all.assert_called_once_with(bind=conn)
    # stamp：建 alembic_version 并写 head
    sqls = [str(c.args[0]) for c in conn.execute.call_args_list]
    assert any("CREATE TABLE alembic_version" in s for s in sqls)
    assert any("INSERT INTO alembic_version" in s for s in sqls)


def test_存量库有版本记录_走老链():
    conn, inspector = _connection_with_tables(["alembic_version", "users"])
    metadata = MagicMock()
    with patch("app.db.migration_bootstrap.sa_inspect", return_value=inspector):
        result = bootstrap_if_empty(conn, metadata, "head-rev")
    assert result is False
    metadata.create_all.assert_not_called()
    conn.execute.assert_not_called()


def test_半初始化库有业务表无版本_不吞状态照走老链():
    conn, inspector = _connection_with_tables(["users", "teams"])
    metadata = MagicMock()
    with patch("app.db.migration_bootstrap.sa_inspect", return_value=inspector):
        result = bootstrap_if_empty(conn, metadata, "head-rev")
    assert result is False
    metadata.create_all.assert_not_called()
    conn.execute.assert_not_called()
