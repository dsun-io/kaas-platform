"""临时：列出 public schema 下的表及行数估算。"""
import asyncio

import asyncpg

DSN = "***REMOVED***"


async def main() -> None:
    conn = await asyncpg.connect(DSN)
    rows = await conn.fetch(
        "select tablename from pg_tables where schemaname='public' order by 1"
    )
    for r in rows:
        name = r["tablename"]
        try:
            cnt = await conn.fetchval(f'select count(*) from "{name}"')
        except Exception as exc:  # noqa: BLE001
            cnt = f"err: {exc}"
        print(f"{name}: {cnt}")
    await conn.close()


asyncio.run(main())
