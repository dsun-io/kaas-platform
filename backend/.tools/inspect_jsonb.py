import asyncio

import asyncpg

DSN = "postgresql://neondb_owner:npg_FU7X4gicMjkn@ep-small-brook-b54t5318-pooler.c-7.us-east-2.aws.neon.tech/neondb"


async def main():
    conn = await asyncpg.connect(DSN)
    row = await conn.fetchrow(
        """SELECT jsonb_typeof(suitable_cargo) AS t,
                  suitable_cargo #>> '{}' AS inner_v,
                  jsonb_typeof(suitable_cargo #>> '{}') AS it
           FROM market_ports WHERE un_locode=$1""",
        "USLAX",
    )
    print(dict(row))
    await conn.close()


if __name__ == "__main__":
    asyncio.run(main())
