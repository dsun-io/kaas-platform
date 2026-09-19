import asyncio
import asyncpg
DSN = "postgresql://neondb_owner:npg_FU7X4gicMjkn@ep-small-brook-b54t5318-pooler.c-7.us-east-2.aws.neon.tech/neondb"
COLS = ["suitable_cargo", "suitable_shipping_modes", "connected_corridors", "major_carriers"]
async def main():
    conn = await asyncpg.connect(DSN)
    for col in COLS:
        r = await conn.execute(
            f"UPDATE market_ports SET {col} = ({col} #>> '{{}}')::jsonb WHERE tenant_id='default' AND jsonb_typeof({col})='string'"
        )
        print(col, r)
    row = await conn.fetchrow("SELECT suitable_cargo FROM market_ports WHERE un_locode=$1", "USLAX")
    print("type:", type(row["suitable_cargo"]).__name__, row["suitable_cargo"])
    await conn.close()
asyncio.run(main())
