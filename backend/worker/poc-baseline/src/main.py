"""POC：Cloudflare Workers Python runtime 能否跑 SQLAlchemy（async + asyncpg）。

只用于 P0 验证，不进入生产 worker。设计：

1. 模块级 import 探针：sqlalchemy / greenlet / sqlalchemy.ext.asyncio / asyncpg
   全部 try/except 包住，任何一个炸掉都不能让 worker 起不来 —— 要拿到**原始错误**。
2. `/health`：返回探针结果（含 SQLAlchemy 自己的 have_greenlet 判定）。
3. `/sqla/select1`、`/sqla/users_count`：SQLAlchemy async + asyncpg 真查询。
4. `/pg/users_count`：裸 asyncpg 对照（同库同表），排除数据库本身的问题。

绑定值只能在请求期读（生产 worker 铁律），故 DSN 从 request.scope["env"] 取。
"""
from __future__ import annotations

import traceback

from fastapi import FastAPI, Request
from workers import WorkerEntrypoint, asgi

app = FastAPI(title="kaas-poc-sqlalchemy")

PROBES: dict[str, dict] = {}


def _probe(name: str) -> None:
    try:
        mod = __import__(name, fromlist=["*"])
        ver = getattr(mod, "version", None) or getattr(mod, "__version__", "")
        PROBES[name] = {"ok": True, "version": str(ver)}
    except BaseException as exc:  # noqa: BLE001 - 要抓到原始错误
        PROBES[name] = {
            "ok": False,
            "error": f"{type(exc).__name__}: {exc}",
            "traceback_tail": traceback.format_exc()[-2000:],
        }


for _name in ("sqlalchemy", "greenlet", "sqlalchemy.ext.asyncio", "asyncpg"):
    _probe(_name)

# SQLAlchemy 自己的能力判定：没 greenlet 时 util.concurrency 会把 have_greenlet 置 False
try:
    from sqlalchemy.util.concurrency import have_greenlet as _sqla_have_greenlet

    PROBES["sqlalchemy.util.concurrency.have_greenlet"] = {
        "ok": True,
        "value": bool(_sqla_have_greenlet),
    }
except BaseException as exc:  # noqa: BLE001
    PROBES["sqlalchemy.util.concurrency.have_greenlet"] = {
        "ok": False,
        "error": f"{type(exc).__name__}: {exc}",
    }

# 仅创建 engine（不连接）也应能过；真正卡点在 connect() 的 greenlet_spawn
try:
    from sqlalchemy.ext.asyncio import create_async_engine

    PROBES["create_async_engine"] = {"ok": True}
except BaseException as exc:  # noqa: BLE001
    PROBES["create_async_engine"] = {
        "ok": False,
        "error": f"{type(exc).__name__}: {exc}",
    }


def _dsn(request: Request) -> str:
    """请求期解析 DSN：优先 DATABASE_URL（本地 .dev.vars），否则从 Hyperdrive 绑定拼。"""
    env = request.scope.get("env")
    dsn = getattr(env, "DATABASE_URL", "") if env is not None else ""
    if not dsn:
        hd = getattr(env, "HYPERDRIVE", None) if env is not None else None
        if hd is not None:
            dsn = (
                f"postgresql+asyncpg://{hd.user}:{hd.password}"
                f"@{hd.host}:{hd.port}/{hd.database}"
            )
    return dsn


async def _asyncpg_count(dsn: str) -> int:
    """裸 asyncpg 对照实现（把 SQLAlchemy 的 DSN 转成 asyncpg 能吃的 DSN）。"""
    import asyncpg

    raw = dsn.replace("postgresql+asyncpg://", "postgresql://")
    conn = await asyncpg.connect(raw)
    try:
        return await conn.fetchval("SELECT count(*) FROM users")
    finally:
        await conn.close()


@app.get("/health")
async def health():
    return {"status": "ok", "runtime": "workers-python", "probes": PROBES}


@app.get("/sqla/select1")
async def sqla_select1(request: Request):
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import create_async_engine
    from sqlalchemy.pool import NullPool

    dsn = _dsn(request)
    if not dsn:
        return {"ok": False, "error": "no DATABASE_URL/HYPERDRIVE binding"}
    engine = create_async_engine(dsn, poolclass=NullPool)
    try:
        async with engine.connect() as conn:
            value = (await conn.execute(text("SELECT 1"))).scalar_one()
        return {"ok": True, "select1": value, "dsn_scheme": dsn.split("://")[0]}
    except BaseException as exc:  # noqa: BLE001
        return {
            "ok": False,
            "error": f"{type(exc).__name__}: {exc}",
            "traceback_tail": traceback.format_exc()[-4000:],
        }
    finally:
        await engine.dispose()


@app.get("/sqla/users_count")
async def sqla_users_count(request: Request):
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import create_async_engine
    from sqlalchemy.pool import NullPool

    dsn = _dsn(request)
    if not dsn:
        return {"ok": False, "error": "no DATABASE_URL/HYPERDRIVE binding"}
    engine = create_async_engine(dsn, poolclass=NullPool)
    try:
        async with engine.connect() as conn:
            value = (await conn.execute(text("SELECT count(*) FROM users"))).scalar_one()
        return {"ok": True, "users_count": value}
    except BaseException as exc:  # noqa: BLE001
        return {
            "ok": False,
            "error": f"{type(exc).__name__}: {exc}",
            "traceback_tail": traceback.format_exc()[-4000:],
        }
    finally:
        await engine.dispose()


@app.get("/pg/users_count")
async def pg_users_count(request: Request):
    """阳性对照：同一 DSN、同一张表，用裸 asyncpg（生产 worker 的做法）。"""
    try:
        value = await _asyncpg_count(_dsn(request))
        return {"ok": True, "users_count": value}
    except BaseException as exc:  # noqa: BLE001
        return {
            "ok": False,
            "error": f"{type(exc).__name__}: {exc}",
            "traceback_tail": traceback.format_exc()[-4000:],
        }


class Default(WorkerEntrypoint):
    async def fetch(self, request):
        return await asgi.fetch(app, request, self.env)
