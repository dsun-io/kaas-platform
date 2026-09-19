import asyncio
import asyncpg
DSN = "postgresql://neondb_owner:npg_FU7X4gicMjkn@ep-small-brook-b54t5318-pooler.c-7.us-east-2.aws.neon.tech/neondb"
async def main():
    conn = await asyncpg.connect(DSN)
    row = await conn.fetchrow("SELECT suitable_cargo::text AS raw FROM market_ports WHERE un_locode=$1", "USLAX")
    print("raw repr:", repr(row["raw"]))
    print("raw type:", type(row["raw"]).__name__)
    await conn.close()
asyncio.run(main())
