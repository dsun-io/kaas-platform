# -*- coding: utf-8 -*-
"""渲染 Tim 单证全部页面(150dpi) + 报告公章图片落在哪一页。"""
import re
from pathlib import Path

import openpyxl
import pymupdf

TIM = Path(r"D:\projects\报价制作\Tim")
OUT = Path(r"D:\projects\报价制作\.tools\img_tim")
OUT.mkdir(parents=True, exist_ok=True)


def norm(s):
    return re.sub(r"\s+", "", str(s))


for pdf in sorted(TIM.glob("*.pdf")):
    doc = pymupdf.open(pdf)
    per = [len(p.get_images(full=True)) for p in doc]
    print(f"{pdf.name[:46]:<48} pages={len(doc)} img/page={per}")
    tag = pdf.stem.split(" - ")[0][:22].replace(" ", "_").replace("(", "").replace(")", "")
    for i, p in enumerate(doc):
        p.get_pixmap(dpi=150).save(OUT / f"{tag}_p{i + 1}.png")

print()
# CO 文本失败定位
pdf = TIM / "Certificate of Origin (ChAFTA COO) - Tim - 20261012.pdf"
ws = openpyxl.load_workbook(pdf.with_suffix(".xlsx")).active
pages = pymupdf.open(pdf)
pdf_flat = norm("".join(p.get_text() for p in pages))
for coord in ("C11", "C12"):
    n = norm(ws[coord].value)
    print(f"--- {coord} len={len(n)} present={n in pdf_flat}")
    idx = pdf_flat.find(n[:22])
    print("    pdf:", pdf_flat[idx:idx + len(n) + 30] if idx >= 0 else "(head not found)")
