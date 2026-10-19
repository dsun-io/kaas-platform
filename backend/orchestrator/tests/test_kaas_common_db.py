"""`kaas_common.db`（运行时事务适配层）单测 —— 方案 B 阶段二 S1

用假连接验证事务语义，不依赖数据库：
- 最外层事务 正常=COMMIT / 异常=ROLLBACK 且异常继续上抛；
- 嵌套事务自动降级为 SAVEPOINT，内层回滚不影响外层；
- execute/fetch/fetchrow/fetchval 原样委托参数与返回值；
- Record → dict 转换（含 None / 空列表）。
"""
from __future__ import annotations

from typing import Any

import pytest

from kaas_common.db import Session, row_as_dict, rows_as_dicts

pytestmark = pytest.mark.unit


class _FakeTransaction:
    """模拟 asyncpg Transaction：嵌套时记录 savepoint，退出记录 commit/rollback。"""

    def __init__(self, conn: "_FakeConnection", *, isolation: str | None, readonly: bool) -> None:
        self._conn = conn
        self._isolation = isolation
        self._readonly = readonly
        self._savepoint = False

    async def __aenter__(self) -> "_FakeTransaction":
        self._savepoint = self._conn.depth > 0
        self._conn.depth += 1
        self._conn.log.append(
            (
                "begin_savepoint" if self._savepoint else "begin",
                self._isolation,
                self._readonly,
            )
        )
        return self

    async def __aexit__(self, exc_type, exc, tb) -> bool:
        self._conn.depth -= 1
        if exc_type is not None:
            self._conn.log.append("rollback_savepoint" if self._savepoint else "rollback")
        else:
            self._conn.log.append("release_savepoint" if self._savepoint else "commit")
        return False  # 异常继续上抛


class _FakeConnection:
    def __init__(self) -> None:
        self.depth = 0
        self.log: list[Any] = []
        self.calls: list[tuple] = []
        self.rows: list[dict[str, Any]] = [{"id": 1, "name": "a"}, {"id": 2, "name": "b"}]
        self.row: dict[str, Any] | None = {"id": 7}
        self.value: Any = 42
        self.status = "INSERT 0 1"

    def transaction(self, *, isolation: str | None = None, readonly: bool = False) -> _FakeTransaction:
        return _FakeTransaction(self, isolation=isolation, readonly=readonly)

    async def execute(self, query: str, *args: Any) -> str:
        self.calls.append(("execute", query, args))
        return self.status

    async def fetch(self, query: str, *args: Any) -> list[dict[str, Any]]:
        self.calls.append(("fetch", query, args))
        return self.rows

    async def fetchrow(self, query: str, *args: Any) -> dict[str, Any] | None:
        self.calls.append(("fetchrow", query, args))
        return self.row

    async def fetchval(self, query: str, *args: Any, column: int = 0) -> Any:
        self.calls.append(("fetchval", query, args, column))
        return self.value


async def test_transaction_commits_on_success() -> None:
    conn = _FakeConnection()
    session = Session(conn)

    async with session.transaction() as scoped:
        assert scoped is session

    assert conn.log == [("begin", None, False), "commit"]


async def test_transaction_rolls_back_and_propagates() -> None:
    conn = _FakeConnection()
    session = Session(conn)

    with pytest.raises(RuntimeError, match="boom"):
        async with session.transaction():
            raise RuntimeError("boom")

    assert conn.log == [("begin", None, False), "rollback"]


async def test_nested_transaction_uses_savepoint_and_keeps_outer_alive() -> None:
    conn = _FakeConnection()
    session = Session(conn)

    async with session.transaction(isolation="serializable", readonly=True):
        with pytest.raises(ValueError):
            async with session.transaction():
                raise ValueError("inner")

    assert conn.log == [
        ("begin", "serializable", True),
        ("begin_savepoint", None, False),
        "rollback_savepoint",  # 内层异常只回滚 savepoint
        "commit",  # 外层正常提交
    ]


async def test_query_helpers_delegate_arguments_and_values() -> None:
    conn = _FakeConnection()
    session = Session(conn)

    assert await session.execute("UPDATE t SET a=$1", 1) == "INSERT 0 1"
    assert await session.fetch("SELECT * FROM t WHERE id=$1", 1) == conn.rows
    assert await session.fetchrow("SELECT * FROM t WHERE id=$1", 7) == conn.row
    assert await session.fetchval("SELECT count(*) FROM t", column=0) == 42

    assert conn.calls == [
        ("execute", "UPDATE t SET a=$1", (1,)),
        ("fetch", "SELECT * FROM t WHERE id=$1", (1,)),
        ("fetchrow", "SELECT * FROM t WHERE id=$1", (7,)),
        ("fetchval", "SELECT count(*) FROM t", (), 0),
    ]

    assert session.connection is conn


def test_rows_as_dicts_and_row_as_dict() -> None:
    rows = [{"id": 1}, {"id": 2}]
    assert rows_as_dicts(rows) == [{"id": 1}, {"id": 2}]
    assert rows_as_dicts(None) == []
    assert rows_as_dicts([]) == []
    assert row_as_dict({"id": 3}) == {"id": 3}
    assert row_as_dict(None) is None
