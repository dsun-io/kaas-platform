"""统一数据库访问封装（阶段 3「补线上接口」）。

新增线上接口的数据库访问一律走本模块；历史接口继续用 main._acquire，行为不变。
所有查询由调用方带 tenant_id 条件（与历史接口同一口径：DEFAULT_TENANT）。

main.py 按文件加载本模块——因为本包目录与 Python 标准库模块 `platform` 同名，
按包导入（`from platform.db import ...`）会与标准库冲突：

    import os
    from importlib.util import spec_from_file_location, module_from_spec

    _spec = spec_from_file_location(
        "platform_db", os.path.join(os.path.dirname(__file__), "platform", "db.py")
    )
    db = module_from_spec(_spec)
    _spec.loader.exec_module(db)
"""
from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Any, Optional

import asyncpg

from dbjson import row_to_dict

# 与 main.DEFAULT_TENANT 同口径；按文件加载无法从 main 导入（会循环），故在此重申。
DEFAULT_TENANT = "default"


@asynccontextmanager
async def acquire(request):
    """每请求建立一个 Hyperdrive 连接（与 main._acquire 同语义）。

    asgi.fetch 会把 Worker env 注入 request.scope['env']。
    """
    hd = request.scope["env"].HYPERDRIVE
    conn = await asyncpg.connect(
        host=hd.host,
        port=int(hd.port),
        user=hd.user,
        password=hd.password,
        database=hd.database,
        ssl=False,
    )
    try:
        yield conn
    finally:
        await conn.close()


async def fetch(request, sql: str, *args, table: Optional[str] = None) -> list[dict]:
    """查询多行，返回 dict 列表（jsonb 列按 table 解析）。"""
    async with acquire(request) as conn:
        rows = await conn.fetch(sql, *args)
    return [row_to_dict(r, table) for r in rows]


async def fetchrow(
    request, sql: str, *args, table: Optional[str] = None
) -> Optional[dict]:
    """查询单行，返回 dict 或 None。"""
    async with acquire(request) as conn:
        row = await conn.fetchrow(sql, *args)
    return row_to_dict(row, table) if row is not None else None


async def fetchval(request, sql: str, *args) -> Any:
    """查询单值（COUNT 等）。"""
    async with acquire(request) as conn:
        return await conn.fetchval(sql, *args)


async def execute(request, sql: str, *args) -> str:
    """执行写入语句，返回 asyncpg 状态串（如 'INSERT 0 1'）。"""
    async with acquire(request) as conn:
        return await conn.execute(sql, *args)
