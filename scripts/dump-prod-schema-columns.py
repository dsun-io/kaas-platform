"""导出生产 schema 的「表→列」快照（只读），供列级漂移门禁使用。

用法：orchestrator venv
    python scripts/dump-prod-schema-columns.py [输出路径]

DSN 从仓库根 `.env.local` 的 DATABASE_URL 读取（去掉 +asyncpg）。
只读：SET SESSION READONLY + statement_timeout。
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import psycopg2

REPO = Path(__file__).resolve().parent.parent
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else REPO / "scripts" / "prod-schema-columns.json"


def dsn_from_env_local() -> str:
    raw = (REPO / ".env.local").read_text(encoding="utf-8")
    dsn = None
    for line in raw.splitlines():
        m = re.match(r"\s*DATABASE_URL\s*=\s*(.+)\s*$", line)
        if m:
            dsn = m.group(1).strip().strip('"').strip("'")
    if not dsn:
        raise SystemExit("未在 .env.local 找到 DATABASE_URL")
    return dsn.replace("+asyncpg", "").replace("postgresql+psycopg2", "postgresql")


def main() -> int:
    conn = psycopg2.connect(dsn_from_env_local(), connect_timeout=30)
    conn.set_session(readonly=True, autocommit=False)
    try:
        cur = conn.cursor()
        cur.execute("SET statement_timeout = 60000")
        cur.execute(
            "select table_name, column_name from information_schema.columns "
            "where table_schema='public' order by table_name, ordinal_position"
        )
        tables: dict[str, list[str]] = {}
        for table, column in cur.fetchall():
            tables.setdefault(table, []).append(column)
    finally:
        conn.close()

    OUT.write_text(
        json.dumps(tables, ensure_ascii=False, indent=1, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(f"已写入 {OUT}（{len(tables)} 张表）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
