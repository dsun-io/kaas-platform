"""Fix schema drift for market_ports / trade_docs: add missing columns, copy those tables."""
import io
import re

import psycopg2

ENV = r"D:\projects\kaas-platform\.env.local"
text = open(ENV, encoding="utf-8").read()


def dsn(name, direct_host=False):
    val = re.search(rf"^{name}=(.*)$", text, re.M).group(1).strip().strip('"').strip("'")
    val = val.replace("postgresql+asyncpg://", "postgresql://")
    if direct_host:
        val = val.replace("pooled.db.prisma.io", "db.prisma.io")
    return val


s = psycopg2.connect(dsn("DATABASE_URL"), connect_timeout=20)
d = psycopg2.connect(dsn("DATABASE_URL_PPG", True), connect_timeout=20)
s.autocommit = True
d.autocommit = True
sc = s.cursor()
dc = d.cursor()

TABLES = ["market_ports", "trade_docs"]


def cols(cur, t):
    cur.execute(
        "select column_name from information_schema.columns "
        "where table_schema='public' and table_name=%s order by ordinal_position",
        (t,),
    )
    return [r[0] for r in cur.fetchall()]


for t in TABLES:
    src_cols = cols(sc, t)
    dst_cols = cols(dc, t)
    missing = [c for c in src_cols if c not in dst_cols]
    print(t, "missing cols:", missing, flush=True)
    for c in missing:
        sc.execute(
            """select format_type(a.atttypid, a.atttypmod),
                      coalesce(pg_get_expr(ad.adbin, ad.adrelid), ''),
                      a.attnotnull
               from pg_attribute a
               join pg_class c on c.oid = a.attrelid
               left join pg_attrdef ad on ad.adrelid = a.attrelid and ad.adnum = a.attnum
               where c.relname = %s and a.attname = %s""",
            (t, c),
        )
        typ, default, notnull = sc.fetchone()
        stmt = f'alter table "{t}" add column "{c}" {typ}'
        if default:
            stmt += f" default {default}"
        if notnull:
            stmt += " not null" if not default else " not null"
        dc.execute(stmt)
        print("  added", c, typ, flush=True)

    col_list = ",".join(f'"{c}"' for c in src_cols)
    buf = io.StringIO()
    sc.copy_expert(f'copy (select {col_list} from "{t}") to stdout (format csv)', buf)
    payload = buf.getvalue()
    dc.execute(f'delete from "{t}"')
    if payload:
        dc.copy_expert(f'copy "{t}" ({col_list}) from stdin (format csv)', io.StringIO(payload))
    print("  copied", t, len(payload), flush=True)

for t in TABLES:
    sc.execute(f'select count(*) from "{t}"')
    a = sc.fetchone()[0]
    dc.execute(f'select count(*) from "{t}"')
    b = dc.fetchone()[0]
    print("rowcount", t, a, b, "OK" if a == b else "MISMATCH", flush=True)
print("DONE", flush=True)
