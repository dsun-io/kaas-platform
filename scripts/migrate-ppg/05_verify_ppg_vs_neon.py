"""Comprehensive post-migration verification Neon(prod) vs PPG."""
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
sc = s.cursor()
dc = d.cursor()


def query(cur, sql, args=None):
    cur.execute(sql, args or ())
    return cur.fetchall()


def tables(cur):
    return {r[0] for r in query(cur, "select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE'")}


st, dt = tables(sc), tables(dc)
print("tables src:", len(st), "dst:", len(dt))
print("missing in dst:", sorted(st - dt))
print("extra in dst:", sorted(dt - st))

COLS_SQL = """select table_name, column_name, data_type, is_nullable, coalesce(column_default,'')
              from information_schema.columns where table_schema='public'"""
s_cols = {(a, b): (c, e, f) for a, b, c, e, f in query(sc, COLS_SQL)}
d_cols = {(a, b): (c, e, f) for a, b, c, e, f in query(dc, COLS_SQL)}
only_s = sorted(set(s_cols) - set(d_cols))
only_d = sorted(set(d_cols) - set(s_cols))
print("columns only in src:", len(only_s), only_s[:10])
print("columns only in dst:", len(only_d), only_d[:10])
diff = [k for k in set(s_cols) & set(d_cols) if s_cols[k] != d_cols[k]]
print("column attr diffs:", len(diff), diff[:10])

CON_SQL = """select conrelid::regclass::text, conname, contype from pg_constraint
             where connamespace='public'::regnamespace"""
sc_cons = {r for r in query(sc, CON_SQL)}
dc_cons = {r for r in query(dc, CON_SQL)}
print("constraints src:", len(sc_cons), "dst:", len(dc_cons), "only src:", len(sc_cons - dc_cons), "only dst:", len(dc_cons - sc_cons))

IDX_SQL = "select tablename, indexname from pg_indexes where schemaname='public'"
s_idx = {r for r in query(sc, IDX_SQL)}
d_idx = {r for r in query(dc, IDX_SQL)}
print("indexes src:", len(s_idx), "dst:", len(d_idx), "only src:", len(s_idx - d_idx), "only dst:", len(d_idx - s_idx))

mismatch = 0
for t in sorted(st & dt):
    a = query(sc, f'select count(*) from "{t}"')[0][0]
    b = query(dc, f'select count(*) from "{t}"')[0][0]
    if a != b:
        mismatch += 1
        print("ROWCOUNT MISMATCH", t, a, b)
print("rowcount mismatches:", mismatch)
print("alembic:", query(dc, "select version_num from alembic_version")[0][0])
sc.close()
dc.close()
print("VERIFY DONE")
