import re

import psycopg2

text = open(r"D:\projects\kaas-platform\.env.local", encoding="utf-8").read()
url = re.search(r"^DATABASE_URL_PPG=(.*)$", text, re.M).group(1).strip().strip('"').strip("'")
url = url.replace("pooled.db.prisma.io", "db.prisma.io").replace("postgres://", "postgresql://")
conn = psycopg2.connect(url, connect_timeout=15)
conn.autocommit = True
cur = conn.cursor()
cur.execute("drop schema public cascade")
cur.execute("create schema public")
print("reset ok (empty)")
conn.close()
