# -*- coding: utf-8 -*-
"""直接量 PDF：每页文字内容的上下边界，算出真实页高利用率（磅）。"""
import sys
from pathlib import Path

import pymupdf

PDF = Path(sys.argv[1] if len(sys.argv) > 1
           else r"D:\projects\报价制作\Tim\Sales Contract - Tim - 20261012.pdf")

doc = pymupdf.open(PDF)
print(f"{PDF.name}  共 {len(doc)} 页")
for i, page in enumerate(doc, 1):
    h = page.rect.height
    blocks = [b for b in page.get_text("blocks") if b[4].strip()]
    imgs = page.get_image_rects(page.get_images(full=True)[0][0]) if page.get_images() else []
    ys = [b[1] for b in blocks] + [b[3] for b in blocks]
    ys += [r.y0 for r in imgs] + [r.y1 for r in imgs]
    if not ys:
        print(f"  p{i}: 空白页")
        continue
    top, bottom = min(ys), max(ys)
    print(f"  p{i}: 页高 {h:.0f}pt  内容 {top:.0f}→{bottom:.0f}pt  "
          f"占用 {bottom - top:.0f}pt ({bottom - top:.0f}pt / 可用 {(8.268 - 1.0) * 72:.0f}pt "
          f"= {(bottom - top) / ((8.268 - 1.0) * 72) * 100:.0f}%)  "
          f"页脚余白 {h - bottom:.0f}pt")
