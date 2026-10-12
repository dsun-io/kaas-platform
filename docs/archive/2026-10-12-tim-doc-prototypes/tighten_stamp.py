# -*- coding: utf-8 -*-
"""把公章 JPG 处理成「紧贴内容」的透明 PNG。

流程：
1. 只保留「偏红」的像素（R - G > 20），把白底、灰白残渣、扫描噪点全部清成透明；
2. 按行/列统计红色像素数量，用密度阈值（而不是"有没有一个像素"）找真实边界，
   避免个别噪点把边界撑大；
3. 紧裁后等比缩放到宽 640。
这样图片上边缘就是公章真正的内容，锚到单元格上边线时才会「顶得住」。
"""
from pathlib import Path

from PIL import Image

SRC = Path(r"D:\projects\报价制作\1fd6b17c814d52b460876d999068362a.jpg")
DST = Path(r"D:\projects\报价制作\.tools\stamp.png")

RED_DIFF = 20      # R 比 G 大这么多才算红章像素
MIN_ALPHA = 40
TARGET_W = 640

im = Image.open(SRC).convert("RGBA")
w, h = im.size
px = im.load()

rows = [0] * h
cols = [0] * w
for y in range(h):
    for x in range(w):
        r, g, b, a = px[x, y]
        if a > MIN_ALPHA and r - g > RED_DIFF:
            rows[y] += 1
            cols[x] += 1
        else:
            px[x, y] = (255, 255, 255, 0)

if max(rows) == 0:
    raise SystemExit("没有识别到红色公章，请检查源图")

row_th = max(3, round(w * 0.004))     # 一行至少这么多红像素才算「有内容」
col_th = max(3, round(h * 0.004))

top = next(y for y in range(h) if rows[y] >= row_th)
bottom = next(y for y in range(h - 1, -1, -1) if rows[y] >= row_th)
left = next(x for x in range(w) if cols[x] >= col_th)
right = next(x for x in range(w - 1, -1, -1) if cols[x] >= col_th)

im = im.crop((left, top, right + 1, bottom + 1))
if im.width > TARGET_W:
    im = im.resize((TARGET_W, round(im.height * TARGET_W / im.width)), Image.LANCZOS)
im.save(DST)

print(f"原图 {w}x{h} → 紧裁 {im.size}（去掉上 {top} 下 {h - bottom - 1} 左 {left} 右 {w - right - 1}）")
print("aspect w/h = %.4f" % (im.width / im.height))
