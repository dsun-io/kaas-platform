import asyncio
import asyncpg
DSN = "postgresql://neondb_owner:npg_FU7X4gicMjkn@ep-small-brook-b54t5318-pooler.c-7.us-east-2.aws.neon.tech/neondb"
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
