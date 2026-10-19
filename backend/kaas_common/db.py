"""运行时数据访问适配层 · asyncpg 事务包裹执行（方案 B 阶段二 S1）

为什么需要它
------------
方案 B 之后生产运行时只有 asyncpg（不再有 SQLAlchemy Session / Alembic）。
但裸 asyncpg 是**语句级 autocommit**：`await conn.execute(...)` 立即提交，
无法复刻 orchestrator 测试里
`join_transaction_mode="create_savepoint"` 的隔离语义
（应用层 commit 只释放 SAVEPOINT，外层事务由 fixture 回滚）。

本模块提供：
- `Session`：绑定一条 asyncpg 连接的最小会话对象，暴露 fetch/fetchrow/fetchval/execute；
- `Session.transaction()`：**事务包裹执行**。嵌套时由 asyncpg 自动降级为 SAVEPOINT，
  因此测试可以：fixture 持外层 `conn.transaction()` 并在 teardown 回滚，
  应用内 `session.transaction()` 正常退出只 RELEASE SAVEPOINT ⇒ 测试数据不落库；
- `rows_as_dicts` / `row_as_dict`：把 asyncpg Record 转成普通 dict，便于序列化与断言。

边界（不违反 kaas_common 铁律）
------------------------------
本模块**不建立连接、不读环境变量、不做业务判断**：连接由入口层
（uvicorn 入口或 Worker 请求）创建后传入，本方只做事务/取值适配。
本模块也**不 import asyncpg**（用结构化 Protocol 描述连接），
因此共享内核仍然只依赖标准库 + pydantic。
禁止在本目录 import sqlalchemy / alembic / greenlet / psycopg2
——`scripts/check-runtime-deps.py` 会做静态断言。
"""
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator, Mapping, Protocol, Sequence, runtime_checkable

__all__ = ["AsyncConnection", "Session", "rows_as_dicts", "row_as_dict"]


@runtime_checkable
class AsyncConnection(Protocol):
    """asyncpg.Connection 的结构化子集（避免在共享内核里 import asyncpg）。"""

    def transaction(self, *, isolation: str | None = None, readonly: bool = False) -> Any: ...

    async def execute(self, query: str, *args: Any) -> str: ...

    async def fetch(self, query: str, *args: Any) -> Sequence[Mapping[str, Any]]: ...

    async def fetchrow(self, query: str, *args: Any) -> Mapping[str, Any] | None: ...

    async def fetchval(self, query: str, *args: Any, column: int = 0) -> Any: ...


class Session:
    """绑定一条连接的运行时会话（asyncpg 语义；事务嵌套 = SAVEPOINT）。

    用法（生产）：每个请求由入口层拿一条连接，`session = Session(conn)`。
    用法（测试）：fixture 先开外层事务并回滚，端点内部的事务只释放 savepoint。
    """

    __slots__ = ("_conn",)

    def __init__(self, conn: AsyncConnection) -> None:
        self._conn = conn

    @property
    def connection(self) -> AsyncConnection:
        """底层连接（需要直接调用 asyncpg 专有 API 时的逃生口）。"""
        return self._conn

    @asynccontextmanager
    async def transaction(
        self, *, isolation: str | None = None, readonly: bool = False
    ) -> AsyncIterator["Session"]:
        """事务包裹执行。

        - 最外层：BEGIN … COMMIT / ROLLBACK；
        - 已处在外层事务内（含测试 fixture 的 savepoint 模式）：asyncpg 自动开 SAVEPOINT，
          正常退出 = RELEASE，异常 = ROLLBACK TO SAVEPOINT（外层事务不受影响）。
        """
        async with self._conn.transaction(isolation=isolation, readonly=readonly):
            yield self

    async def execute(self, query: str, *args: Any) -> str:
        """执行写语句，返回 asyncpg 状态串（如 `INSERT 0 1`）。"""
        return await self._conn.execute(query, *args)

    async def fetch(self, query: str, *args: Any) -> Sequence[Mapping[str, Any]]:
        """执行查询，返回原始行记录（asyncpg Record，可按列名取值）。"""
        return await self._conn.fetch(query, *args)

    async def fetchrow(self, query: str, *args: Any) -> Mapping[str, Any] | None:
        """执行查询，返回首行或 None。"""
        return await self._conn.fetchrow(query, *args)

    async def fetchval(self, query: str, *args: Any, column: int = 0) -> Any:
        """执行查询，返回首行首列（或指定列）的值。"""
        return await self._conn.fetchval(query, *args, column=column)


def rows_as_dicts(rows: Sequence[Mapping[str, Any]] | None) -> list[dict[str, Any]]:
    """把 asyncpg 行记录批量转成普通 dict（不改变列名/取值）。"""
    if not rows:
        return []
    return [dict(row) for row in rows]


def row_as_dict(row: Mapping[str, Any] | None) -> dict[str, Any] | None:
    """把单行 asyncpg Record 转成普通 dict；None 原样返回。"""
    return None if row is None else dict(row)
