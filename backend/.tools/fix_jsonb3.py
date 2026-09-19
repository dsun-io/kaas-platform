"""Un-double-encode jsonb text columns."""
import asyncio

import asyncpg

DSN = "postgresql://neondb_owner:npg_FU7X4gicMjkn@ep-small-brook-b54t5318-pooler.c-7.us-east-2.aws.neon.tech/neondb"

COLS = ["suitable_cargo", "suitable_shipping_modes", "connected_corridors", "major_carriers"]


async def main():
    conn = await asyncpg.connect(DSN)
    # check type first
    row = await conn.fetchrow(
        "SELECT jsonb_typeof(suitable_cargo) AS t FROM market_ports WHERE un_locode=$1",
        "USLAX",
    )
    print("typeof before:", row["t"])
    for col in COLS:
        await conn.execute(
            f"""UPDATE market_ports
                SET {col} = (SELECT j FROM (SELECT ({col} #>> '{{}}')::text AS v) s, LATERAL (SELECT v::jsonb AS j) j)
                WHERE tenant_id='default' AND jsonb_typeof({col}) = 'string'"""
        )
        print(col, "done")
    row = await conn.fetchrow(
        "SELECT suitable_cargo FROM market_ports WHERE un_locode=$1", "USLAX"
    )
    print("cargo type:", type(row["suitable_cargo"]).__name__, row["suitable_cargo"])
    await conn.close()


if __name__ == "__main__":
    asyncio.run(main())
