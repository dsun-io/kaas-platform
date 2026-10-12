# -*- coding: utf-8 -*-
"""精确检查合同 PDF 是否有文字越界/跨栏重叠（pymupdf span bbox 相交检测）。"""
from pathlib import Path

import pymupdf

TIM = Path(r"D:\projects\报价制作\Tim")
PDF = TIM / "Sales Contract - Tim - 20261012.pdf"

doc = pymupdf.open(PDF)
issues = 0
for pno, page in enumerate(doc, 1):
    spans = []
    for blk in page.get_text("dict")["blocks"]:
        for line in blk.get("lines", []):
            for sp in line["spans"]:
                if sp["text"].strip():
                    spans.append((pymupdf.Rect(sp["bbox"]), sp["text"],
                                  round(sp["size"], 1)))
    # 同一基线（y 重叠>50%）且 x 重叠>2pt 视为跨栏重叠
    for i in range(len(spans)):
        r1, t1, s1 = spans[i]
        for j in range(i + 1, len(spans)):
            r2, t2, s2 = spans[j]
            yov = min(r1.y1, r2.y1) - max(r1.y0, r2.y0)
            xov = min(r1.x1, r2.x1) - max(r1.x0, r2.x0)
            if yov > 0.5 * min(r1.height, r2.height) and xov > 2:
                issues += 1
                if issues <= 15:
                    print(f"p{pno} 重叠 {xov:.1f}pt  字号 {s1}/{s2}")
                    print(f"    A: {t1[:70]!r}")
                    print(f"    B: {t2[:70]!r}")

    # 页内最小字号
    sizes = [s for _, _, s in spans]
    if sizes:
        print(f"p{pno}: {len(spans)} spans, 最小字号 {min(sizes)}pt")

print("\n重叠问题数:", issues)
