import asyncio
import asyncpg


async def main():
    conn = await asyncpg.connect(
        "postgresql://neondb_owner:npg_FU7X4gicMjkn@ep-small-brook-b54t5318-pooler.c-7.us-east-2.aws.neon.tech/neondb"
    )
    total = await conn.fetchval("SELECT COUNT(*) FROM market_ports WHERE tenant_id='default'")
    with_coords = await conn.fetchval(
        "SELECT COUNT(*) FROM market_ports WHERE tenant_id='default' AND lat IS NOT NULL"
    )
    null_coords = await conn.fetch(
        "SELECT name_en, un_locode FROM market_ports WHERE tenant_id='default' AND lat IS NULL"
    )
    print("total:", total, "with_coords:", with_coords)
    for r in null_coords:
        print("  missing:", r["name_en"], r["un_locode"])
    await conn.close()


if __name__ == "__main__":
    asyncio.run(main())
