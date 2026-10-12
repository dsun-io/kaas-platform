# -*- coding: utf-8 -*-
"""把 Tim 单已有的报价单 / PI 复制进 Tim 文件夹，形成完整单据档案。"""
import shutil
from pathlib import Path

SRC = Path(r"D:\projects\报价制作")
DST = SRC / "Tim"

FILES = [
    "Fence Quotation - Tim - 20260928.xlsx",
    "Fence Quotation - Tim - 20260928.pdf",
    "Proforma Invoice - Tim - 20260929.xlsx",
    "Proforma Invoice - Tim - 20260929.pdf",
]

for name in FILES:
    s, d = SRC / name, DST / name
    if not s.exists():
        print("SKIP (missing):", name)
        continue
    shutil.copy2(s, d)
    print("copied:", name)

print("\n== Tim 文件夹内容 ==")
for p in sorted(DST.iterdir()):
    print(f"  {p.stat().st_size / 1024:8.1f} KB  {p.name}")
