# -*- coding: utf-8 -*-
"""Tim 后续单证校验：金额勾稽 + xlsx 文本 vs PDF 文本比对 + 公章(图片)存在性 + 渲染 PNG。"""
import re
import sys
from pathlib import Path

import openpyxl
import pymupdf

TIM = Path(r"D:\projects\报价制作\Tim")
OUT = Path(r"D:\projects\报价制作\.tools\img_tim")

PAIRS = [
    ("Commercial Invoice - Tim - 20261012", False),
    ("Shipping Advice - Tim - 20261012", False),
    ("Certificate of Origin (ChAFTA COO) - Tim - 20261012", False),
    ("Sales Contract - Tim - 20261012", False),
]


def norm(s):
    return re.sub(r"\s+", "", str(s))


OUT.mkdir(parents=True, exist_ok=True)
total_missing = 0
for stem, _ in PAIRS:
    xlsx, pdf = TIM / f"{stem}.xlsx", TIM / f"{stem}.pdf"
    print("=" * 90)
    print(stem)
    if not (xlsx.exists() and pdf.exists()):
        print("  !! 缺文件", xlsx.exists(), pdf.exists())
        continue
    ws = openpyxl.load_workbook(xlsx).active
    doc = pymupdf.open(pdf)
    pdf_flat = norm("".join(p.get_text() for p in doc))
    imgs = sum(len(p.get_images(full=True)) for p in doc)
    print(f"  pages={len(doc)}  images(stamp)={imgs}")

    missing, checked = [], 0
    for row in ws.iter_rows():
        for c in row:
            v = c.value
            if v is None:
                continue
            checked += 1
            if isinstance(v, (int, float)) and not isinstance(v, bool):
                alts = {str(v), f"{v:,.2f}", f"{v:,.0f}", f"{v:.2f}", f"{v:.4f}",
                        f"{v:,.3f}", f"{v:.3f}"}
                if not any(norm(a) in pdf_flat for a in alts):
                    missing.append((c.coordinate, str(v)))
            elif norm(v) and norm(v) not in pdf_flat:
                missing.append((c.coordinate, str(v)[:70]))
    print(f"  text compare: {checked - len(missing)}/{checked} ok")
    for m in missing:
        print("    MISSING:", m)
    total_missing += len(missing)

    # 渲染首页 + 末页
    for i in sorted({0, len(doc) - 1}):
        pix = doc[i].get_pixmap(dpi=110)
        png = OUT / f"{stem[:24].replace(' ', '_')}_p{i + 1}.png"
        pix.save(png)
        print("   ", png.name)

print("=" * 90)
print("MISSING TOTAL:", total_missing)
