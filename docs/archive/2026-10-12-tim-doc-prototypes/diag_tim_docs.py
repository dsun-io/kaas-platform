# -*- coding: utf-8 -*-
"""诊断：CO 两处长文本比对失败原因 + 各单证公章图片落在哪一页。"""
import re
from pathlib import Path

import openpyxl
import pymupdf

TIM = Path(r"D:\projects\报价制作\Tim")


def norm(s):
    return re.sub(r"\s+", "", str(s))


# 1) 公章图片分页情况
for pdf in sorted(TIM.glob("*.pdf")):
    doc = pymupdf.open(pdf)
    per = [len(p.get_images(full=True)) for p in doc]
    print(f"{pdf.name[:45]:<47} pages={len(doc)} images/page={per}")

print()
# 2) CO 两处失败文本的定位
pdf = TIM / "Certificate of Origin (ChAFTA COO) - Tim - 20261012.pdf"
ws = openpyxl.load_workbook(pdf.with_suffix(".xlsx")).active
pdf_flat = norm("".join(p.get_text() for p in pymupdf.open(pdf)))
for coord in ("C11", "C12"):
    v = ws[coord].value
    n = norm(v)
    print(f"--- {coord} len={len(n)} present={n in pdf_flat}")
    for i in range(0, len(n), 40):
        chunk = n[i:i + 40]
        if chunk not in pdf_flat:
            print(f"    NOT FOUND: ...{chunk}...")
    # 找出 PDF 里对应的区域
    head = n[:25]
    idx = pdf_flat.find(head)
    if idx >= 0:
        print("    pdf has:", pdf_flat[idx:idx + len(n) + 40])
