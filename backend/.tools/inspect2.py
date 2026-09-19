import asyncio
import asyncpg
DSN = "***REMOVED***"
async def main():
    conn = await asyncpg.connect(DSN)
    row = await conn.fetchrow("SELECT suitable_cargo::text AS raw FROM market_ports WHERE un_locode=$1", "USLAX")
    print("raw repr:", repr(row["raw"]))
    print("raw type:", type(row["raw"]).__name__)
    await conn.close()
asyncio.run(main())
