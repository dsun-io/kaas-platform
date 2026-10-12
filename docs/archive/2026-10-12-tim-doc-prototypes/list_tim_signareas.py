# -*- coding: utf-8 -*-
"""列出每份单证末页的签署区文字，确认哪些要求买方签章。"""
import re
from pathlib import Path

import pymupdf

TIM = Path(r"D:\projects\报价制作\Tim")
KEYS = ("Buyer", "Seller", "Stamp", "Signature", "Acknowledged", "Prepared",
        "Confirmed")

for pdf in sorted(TIM.glob("*.pdf")):
    doc = pymupdf.open(pdf)
    text = doc[-1].get_text()
    print("=" * 78)
    print(pdf.name, f"(共 {len(doc)} 页，末页签署区)")
    for line in text.splitlines():
        if any(k in line for k in KEYS):
            print("   ", line.strip())
