"""Parallel CSV data copy (robust to type/order differences), per-table columns from
source; delete-then-copy idempotent; replica mode per connection."""
import io
import re
import sys
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed

import psycopg2

ENV = r"D:\projects\kaas-platform\.env.local"
text = open(ENV, encoding="utf-8").read()


def dsn(name, direct_host=False):
    val = re.search(rf"^{name}=(.*)$", text, re.M).group(1).strip().strip('"').strip("'")
    val = val.replace("postgresql+asyncpg://", "postgresql://")
    if direct_host:
        val = val.replace("pooled.db.prisma.io", "db.prisma.io")
    return val


def columns(cur, table):
    cur.execute(
        """select column_name from information_schema.columns
           where table_schema='public' and table_name=%s order by ordinal_position""",
        (table,),
    )
    return [r[0] for r in cur.fetchall()]


def main():
    src_tables = {}
    s = psycopg2.connect(dsn("DATABASE_URL"), connect_timeout=20)
    s.autocommit = True
    sc = s.cursor()
    sc.execute("select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE'")
    src_tables = {r[0] for r in sc.fetchall()}

    d = psycopg2.connect(dsn("DATABASE_URL_PPG", True), connect_timeout=20)
    d.autocommit = True
    dc = d.cursor()
    dc.execute("select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE'")
    dst_tables = {r[0] for r in dc.fetchall()}
    common = sorted((src_tables & dst_tables) - {"alembic_version"})
    print("tables:", len(common), flush=True)

    local = threading.local()

    def conns():
        if not hasattr(local, "s"):
            local.s = psycopg2.connect(dsn("DATABASE_URL"), connect_timeout=20)
            local.s.autocommit = True
            local.sc = local.s.cursor()
            local.d = psycopg2.connect(dsn("DATABASE_URL_PPG", True), connect_timeout=20)
            local.d.autocommit = True
            local.dc = local.d.cursor()
            local.dc.execute("set session_replication_role = replica")
        return local.sc, local.dc

    def copy_one(t):
        try:
            sc, dc = conns()
            sc = local.s.cursor()
            cols = columns(sc, t)
            col_list = ",".join(f'"{c}"' for c in cols)
            buf = io.StringIO()
            sc.copy_expert(f'copy (select {col_list} from "{t}") to stdout (format csv)', buf)
            payload = buf.getvalue()
            dc.execute(f'delete from "{t}"')
            if payload:
                dc.copy_expert(f'copy "{t}" ({col_list}) from stdin (format csv)', io.StringIO(payload))
            return t, len(payload), None
        except Exception as exc:  # noqa: BLE001
            return t, 0, str(exc).strip().splitlines()[0][:160]

    done = 0
    errors = 0
    with ThreadPoolExecutor(max_workers=6) as pool:
        futs = [pool.submit(copy_one, t) for t in common]
        for fut in as_completed(futs):
            t, size, err = fut.result()
            done += 1
            if err:
                errors += 1
                print("ERROR", t, err, flush=True)
            elif size:
                print("copied", t, size, flush=True)
    print("done:", done, "errors:", errors, flush=True)

    # sequences
    d.autocommit = True
    s.autocommit = True
    sc = s.cursor()
    dc = d.cursor()
    sc.execute(
        """select s.relname, t.relname, a.attname
           from pg_class s
           join pg_depend dep on dep.objid=s.oid and dep.classid='pg_class'::regclass
           join pg_class t on t.oid=dep.refobjid
           join pg_attribute a on a.attrelid=t.oid and a.attnum=dep.refobjsubid
           where s.relkind='S' and dep.deptype='a'"""
    )
    fixed = 0
    for seq, tbl, col in sc.fetchall():
        try:
            dc.execute(
                f'select setval(\'"{seq}"\', coalesce((select max("{col}") from "{tbl}"), 1), '
                f'(select max("{col}") from "{tbl}") is not null)'
            )
            fixed += 1
        except Exception as exc:  # noqa: BLE001
            print("setval fail", seq, str(exc).strip().splitlines()[0][:80], flush=True)
    print("sequences setval:", fixed, flush=True)

    mismatch = 0
    for t in common:
        sc.execute(f'select count(*) from "{t}"')
        a = sc.fetchone()[0]
        dc.execute(f'select count(*) from "{t}"')
        b = dc.fetchone()[0]
        if a != b:
            mismatch += 1
            print("ROWCOUNT MISMATCH", t, a, b, flush=True)
    print("rowcount mismatches:", mismatch, flush=True)
    print("DONE", flush=True)


if __name__ == "__main__":
    main()

