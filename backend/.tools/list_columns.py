"""临时：查看关键表列名。"""
import asyncio

import asyncpg

DSN = "postgresql://neondb_owner:npg_FU7X4gicMjkn@ep-small-brook-b54t5318-pooler.c-7.us-east-2.aws.neon.tech/neondb"

TABLES = [
    "cust_customers",
    "cust_inquiries",
    "quotations",
    "quote_orders",
    "usage_events",
    "events",
    "intel_shipments",
]


async def main() -> None:
    conn = await asyncpg.connect(DSN)
    for t in TABLES:
        cols = await conn.fetch(
            "select column_name, data_type from information_schema.columns"
            " where table_schema='public' and table_name=$1 order by ordinal_position",
            t,
        )
        print(f"{t}: {', '.join(c['column_name'] + ':' + c['data_type'] for c in cols)}")
    await conn.close()


asyncio.run(main())
