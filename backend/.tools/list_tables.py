"""临时：列出 public schema 下的表及行数估算。"""
import asyncio
import os
import sys

import asyncpg

# 生产 DSN 一律从环境变量读取：**不入仓库**（原硬编码的生产口令已按安全要求清除）。
DSN = os.environ.get("KAAS_DSN")
if not DSN:
    sys.exit("缺少环境变量 KAAS_DSN —— 先执行: $env:KAAS_DSN='postgresql://<user>:<pass>@<host>/<db>'")


async def main() -> None:
    conn = await asyncpg.connect(DSN)
    rows = await conn.fetch(
        "select tablename from pg_tables where schemaname='public' order by 1"
    )
    for r in rows:
        name = r["tablename"]
        try:
            cnt = await conn.fetchval(f'select count(*) from "{name}"')
        except asyncpg.PostgresError as exc:
            cnt = f"err: {exc}"
        print(f"{name}: {cnt}")
    await conn.close()


asyncio.run(main())
