"""Fix double-encoded jsonb columns (2nd pass): value is text containing JSON string."""
import asyncio

import asyncpg

DSN = "postgresql://neondb_owner:npg_FU7X4gicMjkn@ep-small-brook-b54t5318-pooler.c-7.us-east-2.aws.neon.tech/neondb"

COLS = ["suitable_cargo", "suitable_shipping_modes", "connected_corridors", "major_carriers"]

FIX_SQL = """
UPDATE market_ports
SET {col} = CASE
    WHEN jsonb_typeof({col}) = 'string'
        AND jsonb_typeof(({col} #>> '{{}}')::jsonb) = 'string'
        THEN (({col} #>> '{{}}')::jsonb #>> '{{}}')::jsonb
    WHEN jsonb_typeof({col}) = 'string'
        THEN ({col} #>> '{{}}')::jsonb
    ELSE {col}
END
WHERE tenant_id = 'default'
"""


async def main():
    conn = await asyncpg.connect(DSN)
    for col in COLS:
        r = await conn.execute(FIX_SQL.format(col=col))
        print(col, r)
    row = await conn.fetchrow(
        "SELECT suitable_cargo FROM market_ports WHERE un_locode=$1", "USLAX"
    )
    v = row["suitable_cargo"]
    print("cargo type:", type(v).__name__, v)
    await conn.close()


if __name__ == "__main__":
    asyncio.run(main())
