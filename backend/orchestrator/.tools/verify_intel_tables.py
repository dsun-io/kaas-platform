"""Verify intel tables exist in Neon database"""
import asyncio
import asyncpg

async def check_tables():
    conn = await asyncpg.connect(
        'postgresql://neondb_owner:npg_FU7X4gicMjkn@ep-small-brook-b54t5318-pooler.c-7.us-east-2.aws.neon.tech/neondb?channel_binding=require&sslmode=require'
    )
    tables = await conn.fetch(
        "SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'intel_%' ORDER BY table_name"
    )
    print("Intel tables in database:")
    for t in tables:
        print(f"  - {t['table_name']}")

    # Check columns of intel_shipments
    columns = await conn.fetch(
        "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'intel_shipments' ORDER BY ordinal_position"
    )
    print(f"\nintel_shipments columns ({len(columns)}):")
    for c in columns:
        print(f"  - {c['column_name']}: {c['data_type']}")

    await conn.close()

asyncio.run(check_tables())
