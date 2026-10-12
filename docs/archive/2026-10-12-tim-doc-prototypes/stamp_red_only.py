# -*- coding: utf-8 -*-
"""公章 → 严格「只保留红像素」的透明 PNG。

与 tighten_stamp.py 的差别：过滤器放在**最后一步**执行。
  tighten_stamp.py：过滤 → 裁 → 缩放  → 缩放(LANCZOS) 会把透明白底混进红字边缘，
                    产出 24% 的非红晕影像素（半透明近白，肉眼几乎看不见但确实存在）
  本脚本：          裁 → 缩放 → **过滤**      → 可见像素 100% 都是红像素（R-G>20），其余全透明

输出固定宽 640（与既有版式/锚点换算兼容），高度按红内容自适应。
"""
from pathlib import Path

from PIL import Image

SRC = Path(r"D:\projects\报价制作\1fd6b17c814d52b460876d999068362a.jpg")
DST = Path(r"D:\projects\报价制作\.tools\stamp.png")
COPY = Path(r"D:\projects\报价制作\公章-红字透明底.png")   # 同内容副本，方便资源管理器里直接找

RED_DIFF = 20      # R 比 G 大这么多才算红章像素
MIN_ALPHA = 40     # 源图（JPG 无 alpha，全不透明）保留此参数以便复用
TARGET_W = 640

# ── 1) 在原分辨率上按红像素密度找真实边界（避免孤立噪点撑大边界）──
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

if max(rows) == 0:
    raise SystemExit("没有识别到红色公章，请检查源图")

row_th = max(3, round(w * 0.004))
col_th = max(3, round(h * 0.004))
top = next(y for y in range(h) if rows[y] >= row_th)
bottom = next(y for y in range(h - 1, -1, -1) if rows[y] >= row_th)
left = next(x for x in range(w) if cols[x] >= col_th)
right = next(x for x in range(w - 1, -1, -1) if cols[x] >= col_th)

# ── 2) 紧裁 + 缩放 ──
im = im.crop((left, top, right + 1, bottom + 1))
if im.width != TARGET_W:
    im = im.resize((TARGET_W, max(1, round(im.height * TARGET_W / im.width))),
                   Image.LANCZOS)

# ── 3) 最后一步过滤：只保留红像素，其余全透明 ──
w, h = im.size
px = im.load()
kept = 0
for y in range(h):
    for x in range(w):
        r, g, b, a = px[x, y]
        if r - g > RED_DIFF:
            px[x, y] = (r, g, b, 255)      # 红像素：保留原色，实心
            kept += 1
        else:
            px[x, y] = (255, 255, 255, 0)  # 非红像素：完全透明（无晕影）

im.save(DST)
im.save(COPY)

visible = w * h - sum(1 for y in range(h) for x in range(w) if px[x, y][3] == 0)
print("源图 %dx%d → 紧裁缩放后 %dx%d（去掉上 %d 下 %d 左 %d 右 %d）"
      % (w if False else Image.open(SRC).size[0], Image.open(SRC).size[1],
         w, h, top, Image.open(SRC).size[1] - bottom - 1, left,
         Image.open(SRC).size[0] - right - 1))
print("可见像素 %d，其中红像素 %d = %.2f%%" % (visible, kept, 100.0 * kept / max(visible, 1)))
print("aspect w/h = %.4f" % (w / h))
print("输出:", DST)
print("副本:", COPY)
