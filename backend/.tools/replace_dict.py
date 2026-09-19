import re

path = r"d:\projects\kaas-platform\backend\worker\src\main.py"
with open(path, encoding="utf-8") as f:
    src = f.read()

# Only remaining plain [dict(r) for r in rows] and channels = [dict(r)...]
src = src.replace("[dict(r) for r in rows]", "[_row_to_dict(r) for r in rows]")
src = src.replace("channels = [dict(r) for r in rows]", "channels = [_row_to_dict(r) for r in rows]")

with open(path, "w", encoding="utf-8") as f:
    f.write(src)
print("done")
