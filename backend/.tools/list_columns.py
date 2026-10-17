"""临时：查看关键表列名。"""
import asyncio
import os
import sys

import asyncpg

# 生产 DSN 一律从环境变量读取：**不入仓库**（原硬编码的生产口令已按安全要求清除）。
DSN = os.environ.get("KAAS_DSN")
if not DSN:
    sys.exit("缺少环境变量 KAAS_DSN —— 先执行: $env:KAAS_DSN='postgresql://<user>:<pass>@<host>/<db>'")

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
