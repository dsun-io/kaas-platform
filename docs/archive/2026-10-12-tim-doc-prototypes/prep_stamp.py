# -*- coding: utf-8 -*-
"""把用户放入目录的公章 JPG 处理成透明背景 PNG（裁白边），供 PI 盖章用。"""
from pathlib import Path

from PIL import Image

SRC = Path(r"D:\projects\报价制作\1fd6b17c814d52b460876d999068362a.jpg")
DST = Path(r"D:\projects\报价制作\.tools\stamp.png")

im = Image.open(SRC).convert("RGBA")
print("src size:", im.size)

# 白底 → 透明（按亮度阈值），顺便裁掉四周白边
px = im.load()
w, h = im.size
minx, miny, maxx, maxy = w, h, 0, 0
for y in range(h):
    for x in range(w):
        r, g, b, a = px[x, y]
        if r > 235 and g > 235 and b > 235:
            px[x, y] = (255, 255, 255, 0)
        else:
            if x < minx: minx = x
            if x > maxx: maxx = x
            if y < miny: miny = y
            if y > maxy: maxy = y

pad = 8
box = (max(0, minx - pad), max(0, miny - pad),
       min(w, maxx + pad), min(h, maxy + pad))
im = im.crop(box)

# 宽度压到 640 以内，控制 xlsx 体积
if im.width > 640:
    im = im.resize((640, round(im.height * 640 / im.width)), Image.LANCZOS)

im.save(DST)
print("cropped size:", im.size, "-> saved", DST)
print("aspect w/h = %.4f" % (im.width / im.height))
