import asyncio
import asyncpg
DSN = "***REMOVED***"
async def main():
    conn = await asyncpg.connect(DSN)
    row = await conn.fetchrow(
        """SELECT suitable_cargo->0 AS elem0,
                  jsonb_typeof(suitable_cargo->0) AS elem0_type,
                  suitable_cargo->>0 AS elem0_text
           FROM market_ports WHERE un_locode=$1""",
        "USLAX",
    )
    print(dict(row))
    await conn.close()
asyncio.run(main())
