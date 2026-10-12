# -*- coding: utf-8 -*-
"""
Tim 单 —— PI(LJ-PI-20260929-01) 之后的后续单证（卖方 联佳 出具）。

  01 Commercial Invoice      商业发票                 LJ-CI-20261012-01
  （02 装箱单 Packing List 已停用——联佳不负责装箱，装箱单由实际出口方出具）
  03 Shipping Advice         装运通知                 LJ-SA-20261012-01
  （04 木包装 ISPM-15 声明 已停用——本单无木包装，不再生成）
  05 Certificate of Origin   ChAFTA COO 申报数据表     LJ-CO-20261012-01
  06 Sales Contract          销售合同                 LJ-SC-20261012-01

数据源：Proforma Invoice - Tim - 20260929.xlsx（同一批货物，金额/规格/汇率/条款一致）
版式：沿用 PI（Calibri、#1F4E79 表头、#DDEBF7 浅蓝、#F2F7FC 斑马纹、细边框）
输出：D:\\projects\\报价制作\\Tim\\
公章：.tools\\stamp.png 自动盖到每份单证的卖方签章区
"""
import math
import os
from decimal import Decimal, ROUND_HALF_UP

import openpyxl
from openpyxl.drawing.image import Image as XLImage
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import column_index_from_string, get_column_letter
from openpyxl.worksheet.pagebreak import Break

OUT_DIR = r"D:\projects\报价制作\Tim"
STAMP = r"D:\projects\报价制作\.tools\stamp.png"
D = Decimal


def q2(x):
    return D(x).quantize(D("0.01"), rounding=ROUND_HALF_UP)


def q4(x):
    return D(x).quantize(D("0.0001"), rounding=ROUND_HALF_UP)


# ─────────────────────────────────────────────────────────── 主体信息
SELLER = "Anping Lianjia Wire Mesh Products Co., Ltd."
SELLER_ZH = "安平县联佳丝网制品有限公司"
SELLER_ADDR_ZH = "河北省衡水市安平县堤涡村村北 100 米处"
SIGNER_ZH = "孙嘉泽"          # 签署人：中文名
SIGNER_EN = "David Sun"       # 签署人：英文名（不用拼音）
SELLER_ADDR = ("100 meters north of Diwo Village, Anping County, "
               "Hengshui City, Hebei Province, China")
SELLER_CONTACT = ("Tel: +86 136 0318 1774  ·  E-mail: sales@lianjiafence.com  "
                  "·  Tax ID: 91131125MA0GA4242U")
BUYER = "Tim Lyons"
BUYER_CONTACT = "Tel: +61 438 381 068  ·  E-mail: timlyons@oneatmosphere.com"
CONSIGNEE = "Jiangsu Juncheng Vehicle Industry Co., Ltd. (江苏钧骋车业有限公司)"
CONSIGNEE_ZH = "江苏钧骋车业有限公司"
DELIVERY = ("No. 1 Guangling Road, Sheyanghu Industrial Park, Baoying County, "
            "Yangzhou City, Jiangsu Province, China")
DELIVERY_ZH = "江苏省扬州市宝应县舍阳湖工业园区广陵路 1 号"

PI_NO, PI_DATE = "LJ-PI-20260929-01", "September 29, 2026"
PI_DATE_ZH = "2026 年 9 月 29 日"
QUO_NO, QUO_DATE = "LJ-Q-20260928-01", "September 28, 2026"
DOC_DATE = "October 12, 2026"

CI_NO = "LJ-CI-20261012-01"
PL_NO = "LJ-PL-20261012-01"
SA_NO = "LJ-SA-20261012-01"
PD_NO = "LJ-PD-20261012-01"
CO_NO = "LJ-CO-20261012-01"
SC_NO = "LJ-SC-20261012-01"

RATE = D("6.7029")
RATE_NOTE = ("1 USD = 6.7029 CNY  ·  Bank of China USD spot buying rate "
             "670.29 per USD 100 (2026-09-28)")

ITEMS = [
    dict(no=1, name="Y-Type Fence Post",
         spec="Height 1.83 m  ·  Material: rail steel  ·  Hot-dip galvanized  ·  "
              "Unit weight 1.86 kg/m",
         unit="pc", qty=400, cny=D("25.00"), hs="7308.90.00",
         package="1 pallet (400 pcs, steel-strapped)",
         nw=D("1361.50"), gw=D("1380.00"), cbm=D("2.850"), wood="Pallet — wood (ISPM-15 HT)"),
    dict(no=2, name="Field Fence (Cattle Fence)",
         spec="Height 1.473 m  ·  Vertical wire Ø2.4 mm, spacing 10 cm  ·  "
              "Horizontal wire Ø2.5 mm, 10 line wires  ·  Hot-dip galvanized, "
              "zinc coating 200 g/m²  ·  50 m per roll  ·  Net weight 53.5 kg/roll",
         unit="roll", qty=20, cny=D("366.31"), hs="7314.41.00",
         package="20 rolls, unwrapped", nw=D("1070.00"), gw=D("1070.00"),
         cbm=D("4.450"), wood="None"),
    dict(no=3, name="Electric Fence Support Insulator",
         spec="Support height 200 mm  ·  Insulating material  ·  "
              "Manufacturer's packing",
         unit="pc", qty=400, cny=D("2.18"), hs="8546.90.00",
         package="4 bags (100 pcs per bag)", nw=D("13.00"), gw=D("14.00"),
         cbm=D("0.050"), wood="None"),
]

for _it in ITEMS:
    _it["amt_cny"] = q2(D(_it["qty"]) * _it["cny"])
    _it["usd"] = q4(_it["cny"] / RATE)
    _it["amt_usd"] = q2(_it["amt_cny"] / RATE)

GOODS_CNY, GOODS_USD = D("18195.66"), D("2714.60")
FREIGHT_CNY, FREIGHT_USD = D("750.00"), D("111.89")
GRAND_CNY, GRAND_USD = D("18945.66"), D("2826.49")
DEP_CNY, DEP_USD = D("5683.70"), D("847.95")
BAL_CNY, BAL_USD = D("13261.96"), D("1978.54")
NW_TOTAL = sum((i["nw"] for i in ITEMS), D("0"))
GW_TOTAL = sum((i["gw"] for i in ITEMS), D("0"))
CBM_TOTAL = sum((i["cbm"] for i in ITEMS), D("0"))
PKG_TOTAL = "25 packages (1 pallet · 20 rolls · 4 bags)"

assert q2(D(ITEMS[0]["qty"]) * ITEMS[0]["cny"] + D(ITEMS[1]["qty"]) * ITEMS[1]["cny"]
          + D(ITEMS[2]["qty"]) * ITEMS[2]["cny"] - D("2.54")) == GOODS_CNY
assert GOODS_CNY + FREIGHT_CNY == GRAND_CNY
assert DEP_CNY + BAL_CNY == GRAND_CNY
assert CBM_TOTAL == D("7.350")


# ─────────────────────────────────────────────────────────── 金额英文大写
ONES = ["ZERO", "ONE", "TWO", "THREE", "FOUR", "FIVE", "SIX", "SEVEN", "EIGHT",
        "NINE", "TEN", "ELEVEN", "TWELVE", "THIRTEEN", "FOURTEEN", "FIFTEEN",
        "SIXTEEN", "SEVENTEEN", "EIGHTEEN", "NINETEEN"]
TENS = ["", "", "TWENTY", "THIRTY", "FORTY", "FIFTY", "SIXTY", "SEVENTY",
        "EIGHTY", "NINETY"]


def _u1000(n):
    if n < 20:
        return ONES[n]
    if n < 100:
        t, r = divmod(n, 10)
        return TENS[t] + ("-" + ONES[r] if r else "")
    h, r = divmod(n, 100)
    return ONES[h] + " HUNDRED" + (" " + _u1000(r) if r else "")


def _int_words(n):
    if n == 0:
        return "ZERO"
    parts = []
    for div, name in ((10 ** 9, "BILLION"), (10 ** 6, "MILLION"), (10 ** 3, "THOUSAND")):
        if n >= div:
            q, n = divmod(n, div)
            parts.append(f"{_int_words(q)} {name}")
    if n:
        parts.append(_u1000(n))
    return " ".join(parts)


def usd_words(amount):
    cents_total = int(q2(amount) * 100)
    dollars, cents = divmod(cents_total, 100)
    return (f"SAY US DOLLARS {_int_words(dollars)} AND CENTS "
            f"{_int_words(cents)} ONLY")


# ─────────────────────────────────────────────────────────── 样式
DARK, LIGHT, ZEBRA = "1F4E79", "DDEBF7", "F2F7FC"
GREY = Side(style="thin", color="8EA9C1")
BORDER = Border(left=GREY, right=GREY, top=GREY, bottom=GREY)

F_TITLE = Font(name="Calibri", size=16, bold=True, color=DARK)
F_BAND = Font(name="Calibri", size=18, bold=True, color="FFFFFF")
F_SUB = Font(name="Calibri", size=10, italic=True, color=DARK)
F_LABEL = Font(name="Calibri", size=10, bold=True, color=DARK)
F_VALUE = Font(name="Calibri", size=10)
F_HEAD = Font(name="Calibri", size=10, bold=True, color="FFFFFF")
F_BODY = Font(name="Calibri", size=10)
F_BODY_B = Font(name="Calibri", size=10, bold=True)
F_NOTE = Font(name="Calibri", size=10, italic=True, color="595959")
F_SMALL = Font(name="Calibri", size=9, italic=True, color="595959")
F_TOTAL = Font(name="Calibri", size=11, bold=True, color=DARK)
F_GRAND = Font(name="Calibri", size=11, bold=True, color="FFFFFF")

FILL_TITLE = PatternFill("solid", fgColor=LIGHT)
FILL_BAND = PatternFill("solid", fgColor=DARK)
FILL_HEAD = PatternFill("solid", fgColor=DARK)
FILL_ZEBRA = PatternFill("solid", fgColor=ZEBRA)
FILL_TOTAL = PatternFill("solid", fgColor=LIGHT)
FILL_GRAND = PatternFill("solid", fgColor=DARK)

C_CENTER = Alignment(horizontal="center", vertical="center", wrap_text=True)
C_LEFT = Alignment(horizontal="left", vertical="center", wrap_text=True)
C_RIGHT = Alignment(horizontal="right", vertical="center")
C_LEFT_IND = Alignment(horizontal="left", vertical="center", wrap_text=True, indent=2)
C_JUST = Alignment(horizontal="justify", vertical="center", wrap_text=True)

FMT_CNY = '#,##0.00'
FMT_USD4 = '#,##0.0000'
FMT_W3 = '#,##0.000'

WIDTHS = {"A": 6, "B": 30, "C": 56, "D": 8, "E": 8, "F": 15, "G": 15, "H": 15, "I": 15}
# 合同专用：左欄 A:C 与右欄 D:I 等宽（各 80），条款表 A:B | C:F | G:I
CT_WIDTHS = {"A": 6, "B": 28, "C": 46, "D": 8, "E": 8,
             "F": 16, "G": 16, "H": 16, "I": 16}
LAST = "I"


def new_book(sheet_title, widths=None):
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = sheet_title
    ws.sheet_properties.tabColor = DARK
    ws.sheet_view.showGridLines = False
    for col, w in (widths or WIDTHS).items():
        ws.column_dimensions[col].width = w
    return wb, ws


def col_width(ws, first, last):
    """合并区可用字符宽（列宽单位）合计，已扣掉左右内边距。"""
    a = column_index_from_string(first)
    b = column_index_from_string(last)
    total = sum((ws.column_dimensions[get_column_letter(i)].width or 8.43)
                for i in range(a, b + 1))
    return max(8, total - 2)


def put(ws, ref, value=None, font=F_BODY, fill=None, align=C_LEFT, numfmt=None,
        border=True):
    c = ws[ref]
    c.value = value
    c.font = font
    if fill is not None:
        c.fill = fill
    c.alignment = align
    if numfmt:
        c.number_format = numfmt
    if border:
        c.border = BORDER
    return c


def mrg(ws, ref_range, value=None, font=F_BODY, fill=None, align=C_LEFT,
        numfmt=None, border=True):
    """合并 + 逐格铺样式（合并单元格不会自动继承样式）。"""
    ws.merge_cells(ref_range)
    first = ref_range.split(":")[0]
    put(ws, first, value, font, fill, align, numfmt, border)
    for row in ws[ref_range]:
        for c in row:
            if border:
                c.border = BORDER
            if fill is not None:
                c.fill = fill
            c.font = font
            c.alignment = align
    return ws[first].row


# 各合并区可用字符宽度（列宽单位；Calibri 10pt 下约 1 单位 = 1 字符，取保守值）
W_FULL = 158   # A:I
W_CI = 125     # C:I
W_CD = 60      # C:D
W_AB = 33      # A:B
W_EF = 21      # E:F
W_GI = 42      # G:I
W_C = 53       # 单列 C


def text_w(text):
    """字符宽度：中文/全角按 2，其余按 1。"""
    return sum(2 if ord(ch) > 0x2E7F else 1 for ch in str(text))


def est_lines(text, width):
    """估算行数：显式换行 + 自动折行。合并单元格不会自动撑高，行高必须自己算准。"""
    n = 0
    for para in str(text).split("\n"):
        n += max(1, math.ceil(text_w(para) / width))
    return n


# 每行文字高度(pt)与单页可用高度(pt)：横向 A4 + fitToWidth=1 实测约 600pt
LINE = 13
PAGE_BUDGET = 600


def h_for(text, width=W_CI, base=16, line=LINE):
    return max(base, est_lines(text, width) * line + 3)


def item_h(text, width=W_C):
    return max(24, est_lines(text, width) * LINE + 2)


def page_budget(ws, safety=0.96):
    """按表内实际列宽推算：fitToWidth 缩放后，横向 A4 单页可容纳的行高合计(pt)。
    表越宽 → 缩放越多 → 单页可容纳的内容越高。"""
    ncol = column_index_from_string(LAST)
    units = sum((ws.column_dimensions[get_column_letter(i)].width or 8.43)
                for i in range(1, ncol + 1))
    sheet_pt = (units * 7 + ncol * 5) * 0.75          # 列宽单位 → 磅
    printable_w = (11.693 - 0.8) * 72                 # 横向 A4 减左右 0.4in 边距
    printable_h = (8.268 - 1.0) * 72                  # 上下各 0.5in 边距
    scale = min(1.0, printable_w / sheet_pt)
    return printable_h / scale * safety


def finish(ws, last_row, sections=(), forced=(), budget=None):
    """页设置 + 分页。若末页超预算，按 section 边界断页（尽量填满每页），
    保证签章区（含公章）不会被分页劈开。"""
    budget = budget or page_budget(ws)
    breaks = list(forced)
    start = (max(breaks) + 1) if breaks else 1

    def h(a, b):
        return sum(ws.row_dimensions[i].height or 15 for i in range(a, b + 1))

    if h(start, last_row) > budget:
        # 贪心按 section 边界断页：每页尽量填满，避免末页只剩签章
        segs = sorted(s for s in sections if start < s <= last_row)
        cur = start
        for idx, s in enumerate(segs):
            nxt = segs[idx + 1] if idx + 1 < len(segs) else last_row + 1
            if h(cur, nxt - 1) > budget:
                breaks.append(s - 1)
                cur = s
        if h(cur, last_row) > budget:   # 末段仍超页 → 从后往前找最靠后的可容断点
            for s in sorted(segs, reverse=True):
                if s > cur and h(s, last_row) <= budget:
                    breaks.append(s - 1)
                    break
    ws.page_setup.orientation = "landscape"
    ws.page_setup.fitToWidth = 1
    ws.page_setup.fitToHeight = 0
    ws.sheet_properties.pageSetUpPr.fitToPage = True
    for b in sorted(set(breaks)):
        if 1 <= b < last_row:
            ws.row_breaks.append(Break(id=b))
    ws.print_area = f"A1:{LAST}{last_row}"
    ws.page_margins.left = ws.page_margins.right = 0.4
    ws.page_margins.top = ws.page_margins.bottom = 0.5


def header(ws, band, subtitle=None):
    mrg(ws, "A1:I1", value=SELLER.upper(), font=F_TITLE, fill=FILL_TITLE,
        align=C_CENTER, border=False)
    ws.row_dimensions[1].height = 28
    mrg(ws, "A2:I2", value=band, font=F_BAND, fill=FILL_BAND, align=C_CENTER,
        border=False)
    ws.row_dimensions[2].height = 32
    mrg(ws, "A3:I3", value=f"{SELLER_ADDR}  ·  {SELLER_CONTACT}", font=F_SUB,
        fill=FILL_TITLE, align=C_CENTER, border=False)
    ws.row_dimensions[3].height = 16
    if subtitle:
        mrg(ws, "A4:I4", value=subtitle, font=F_NOTE, align=C_CENTER, border=False)
        ws.row_dimensions[4].height = 18
    else:
        ws.row_dimensions[4].height = 5


def meta(ws, r, label, value, label2=None, value2=None, value_align=C_LEFT_IND):
    wab = col_width(ws, "A", "B")
    mrg(ws, f"A{r}:B{r}", value=label, font=F_LABEL, fill=FILL_TITLE, align=C_LEFT)
    if label2 is None:
        mrg(ws, f"C{r}:{LAST}{r}", value=value, font=F_VALUE, align=value_align)
        lines = max(est_lines(label, wab), est_lines(value, col_width(ws, "C", LAST)))
    else:
        mrg(ws, f"C{r}:D{r}", value=value, font=F_VALUE, align=value_align)
        mrg(ws, f"E{r}:F{r}", value=label2, font=F_LABEL, fill=FILL_TITLE, align=C_LEFT)
        mrg(ws, f"G{r}:{LAST}{r}", value=value2, font=F_VALUE, align=value_align)
        lines = max(est_lines(label, wab), est_lines(value, col_width(ws, "C", "D")),
                    est_lines(label2, col_width(ws, "E", "F")),
                    est_lines(value2, col_width(ws, "G", LAST)))
    ws.row_dimensions[r].height = max(15, lines * LINE + 1)
    return r + 1


def section(ws, r, title, sections=None):
    if sections is not None:
        sections.append(r)
    mrg(ws, f"A{r}:{LAST}{r}", value=title, font=F_HEAD, fill=FILL_HEAD, align=C_CENTER)
    ws.row_dimensions[r].height = 17
    return r + 1


def kv(ws, r, label, value, height=None):
    mrg(ws, f"A{r}:B{r}", value=label, font=F_LABEL, fill=FILL_TITLE, align=C_LEFT)
    mrg(ws, f"C{r}:{LAST}{r}", value=value, font=F_VALUE, align=C_LEFT_IND)
    lines = max(est_lines(label, col_width(ws, "A", "B")),
                est_lines(value, col_width(ws, "C", LAST)))
    ws.row_dimensions[r].height = height or max(15, lines * LINE + 1)
    return r + 1


def spacer(ws, r, h=5):
    ws.row_dimensions[r].height = h
    return r + 1


def items_header(ws, r, headers):
    for j, h in enumerate(headers, start=1):
        put(ws, f"{get_column_letter(j)}{r}", h, font=F_HEAD, fill=FILL_HEAD,
            align=C_CENTER)
    ws.row_dimensions[r].height = 24
    return r + 1


def signature(ws, r, stamp=True, buyer_label="Confirmed by (Buyer)",
              seller_label="Confirmed by (Seller)", extra_note=None, stamp_w=260,
              buyer_line="Signature / Stamp / Date: ______________________",
              seller_line="Signature / Stamp / Date: ______________________",
              party_rows=(), stamp_below=False,
              buyer_end="C", seller_start="F", pre_rows=()):
    """买卖双方签章区。左右两栏宽度由 buyer_end / seller_start 决定，保证对齐。
    extra_note 排在签章区**上方**；公章压盖在卖方签章行上（不跨页）。"""
    wl = col_width(ws, "A", buyer_end)
    wr = col_width(ws, seller_start, LAST)
    if extra_note:
        mrg(ws, f"A{r}:{LAST}{r}", value=extra_note, font=F_SMALL, align=C_LEFT,
            border=False)
        ws.row_dimensions[r].height = h_for(extra_note, W_FULL, base=14, line=12)
        r += 1
    bl = f"A{r}:{buyer_end}{r}"
    sr = f"{seller_start}{r}:{LAST}{r}"
    mrg(ws, bl, value=buyer_label, font=F_LABEL, fill=FILL_TITLE, align=C_LEFT)
    mrg(ws, sr, value=seller_label, font=F_LABEL, fill=FILL_TITLE, align=C_LEFT)
    ws.row_dimensions[r].height = 16
    r += 1
    mrg(ws, f"A{r}:{buyer_end}{r}", value=BUYER, font=F_VALUE, align=C_LEFT)
    mrg(ws, f"{seller_start}{r}:{LAST}{r}", value=SELLER, font=F_VALUE, align=C_LEFT)
    ws.row_dimensions[r].height = 19
    r += 1
    for left, right in pre_rows:     # 签字行之前的行（签署人姓名、职务）
        mrg(ws, f"A{r}:{buyer_end}{r}", value=left, font=F_NOTE, align=C_LEFT)
        mrg(ws, f"{seller_start}{r}:{LAST}{r}", value=right, font=F_NOTE, align=C_LEFT)
        ws.row_dimensions[r].height = max(16, max(est_lines(left, wl),
                                                  est_lines(right, wr)) * LINE)
        r += 1
    sig_line = r
    mrg(ws, f"A{r}:{buyer_end}{r}", value=buyer_line, font=F_NOTE, align=C_LEFT)
    mrg(ws, f"{seller_start}{r}:{LAST}{r}", value=seller_line, font=F_NOTE, align=C_LEFT)
    ws.row_dimensions[r].height = 19
    r += 1
    extra_h = 0
    for left, right in party_rows:   # 买卖双方对称行（姓名/职务、日期）
        mrg(ws, f"A{r}:{buyer_end}{r}", value=left, font=F_NOTE, align=C_LEFT)
        mrg(ws, f"{seller_start}{r}:{LAST}{r}", value=right, font=F_NOTE, align=C_LEFT)
        ws.row_dimensions[r].height = max(16, max(est_lines(left, wl),
                                                  est_lines(right, wr)) * LINE)
        extra_h += ws.row_dimensions[r].height
        r += 1
    stamp_anchor = r if stamp_below else sig_line
    h_img_pt = 0
    if stamp and os.path.exists(STAMP):
        img = XLImage(STAMP)
        h_img_px = round(stamp_w / (img.width / img.height))
        img.width, img.height = stamp_w, h_img_px
        ws.add_image(img, f"{seller_start}{stamp_anchor}")
        h_img_pt = h_img_px * 0.75       # 图片尺寸是 px，行高是 pt
        print(f"    stamp on {seller_start}{stamp_anchor}  "
              f"{img.width}x{h_img_px}px = {h_img_pt:.0f}pt")
    if stamp_below:
        ws.row_dimensions[r].height = max(70, h_img_pt + 4)
    else:
        # 公章压在签章行上、向下盖住姓名/职务/日期；只在不足时才补空白行
        ws.row_dimensions[r].height = max(6, h_img_pt - 19 - extra_h + 4)
    return r + 1, sig_line


def simple_sign(ws, r, rows, stamp=True, stamp_w=260, buyer_end="C",
                seller_start="D", stamp_row=0, stamp_col=None):
    """极简落款。stamp_row/stamp_col 指定公章压在哪一行的哪一列（默认第一行、卖方列）。"""
    wl = col_width(ws, "A", buyer_end)
    wr = col_width(ws, seller_start, LAST)
    first = r
    heights = []
    for left, right in rows:
        mrg(ws, f"A{r}:{buyer_end}{r}", value=left, font=F_VALUE, align=C_LEFT)
        mrg(ws, f"{seller_start}{r}:{LAST}{r}", value=right, font=F_VALUE, align=C_LEFT)
        h = max(19, max(est_lines(left, wl), est_lines(right, wr)) * LINE + 4)
        ws.row_dimensions[r].height = h
        heights.append(h)
        r += 1
    h_img_pt = 0
    if stamp and os.path.exists(STAMP):
        img = XLImage(STAMP)
        h_img_px = round(stamp_w / (img.width / img.height))
        img.width, img.height = stamp_w, h_img_px
        col = stamp_col or seller_start
        anchor = first + stamp_row
        ws.add_image(img, f"{col}{anchor}")
        h_img_pt = h_img_px * 0.75
        print(f"    stamp on {col}{anchor}  {img.width}x{h_img_px}px = {h_img_pt:.0f}pt")
    below = sum(heights[stamp_row:])          # 盖章行及以下已有的高度
    ws.row_dimensions[r].height = max(6, h_img_pt - below + 6)
    return r + 1, first


def save(wb, name):
    path = os.path.join(OUT_DIR, name)
    wb.save(path)
    print("saved:", path)


# ═══════════════════════════════════════════════ 01 商业发票 Commercial Invoice
def build_ci():
    wb, ws = new_book("Commercial Invoice")
    header(ws, "COMMERCIAL INVOICE")
    sections = []
    r = 5
    r = meta(ws, r, "Invoice No.", CI_NO, "Date", DOC_DATE)
    r = meta(ws, r, "Ref. Proforma Invoice No.", PI_NO, "PI Date", PI_DATE)
    # 标准做法：商业发票必须能对应到销售合同（SC 条款 12 也把 CI 列为附件，互相引用闭环）
    r = meta(ws, r, "Contract No.", SC_NO, "Shipping Marks", "N/M")
    r = meta(ws, r, "Payment Terms",
             "T/T — 30% deposit upon order confirmation / 70% balance upon "
             "dispatch, before delivery",
             "Incoterms", "DAP Yangzhou, Jiangsu, China (Incoterms 2020)")
    r = meta(ws, r, "Currency / Exchange Rate", RATE_NOTE, "Country of Origin", "China")
    r = meta(ws, r, "BILL TO:", f"{BUYER}\n{BUYER_CONTACT}")
    r = meta(ws, r, "CONSIGNED TO:", f"{CONSIGNEE}\nAddress: {DELIVERY}\n"
                                     f"Contact: {BUYER}  ·  {BUYER_CONTACT}")
    r = spacer(ws, r)

    r = items_header(ws, r, ["No.", "Description", "Specification", "Unit", "Qty",
                             "Unit Price (CNY)", "Amount (CNY)",
                             "Unit Price (USD)", "Amount (USD)"])
    for i, it in enumerate(ITEMS):
        fill = FILL_ZEBRA if i % 2 else None
        put(ws, f"A{r}", it["no"], fill=fill, align=C_CENTER)
        put(ws, f"B{r}", it["name"], font=F_BODY_B, fill=fill, align=C_LEFT)
        put(ws, f"C{r}", it["spec"], fill=fill, align=C_LEFT)
        put(ws, f"D{r}", it["unit"], fill=fill, align=C_CENTER)
        put(ws, f"E{r}", it["qty"], fill=fill, align=C_CENTER, numfmt="#,##0")
        put(ws, f"F{r}", float(it["cny"]), fill=fill, align=C_RIGHT, numfmt=FMT_CNY)
        put(ws, f"G{r}", float(it["amt_cny"]), fill=fill, align=C_RIGHT, numfmt=FMT_CNY)
        put(ws, f"H{r}", float(it["usd"]), fill=fill, align=C_RIGHT, numfmt=FMT_USD4)
        put(ws, f"I{r}", float(it["amt_usd"]), fill=fill, align=C_RIGHT, numfmt=FMT_CNY)
        ws.row_dimensions[r].height = item_h(it["spec"])
        r += 1

    mrg(ws, f"A{r}:F{r}", value="Rounding adjustment (unit prices rounded to 2 decimals)",
        font=F_NOTE, align=C_RIGHT)
    put(ws, f"G{r}", -2.54, font=F_NOTE, align=C_RIGHT, numfmt=FMT_CNY)
    put(ws, f"H{r}", None, font=F_NOTE, align=C_RIGHT)
    put(ws, f"I{r}", -0.37, font=F_NOTE, align=C_RIGHT, numfmt=FMT_CNY)
    ws.row_dimensions[r].height = 18
    r += 1

    for label, cny, usd, bold in (
            ("Total Goods Value", GOODS_CNY, GOODS_USD, False),
            ("Inland Freight to Delivery Address (Anping → Yangzhou, Jiangsu)",
             FREIGHT_CNY, FREIGHT_USD, False)):
        mrg(ws, f"A{r}:F{r}", value=label, font=F_TOTAL if bold else F_BODY,
            fill=FILL_TOTAL if bold else None, align=C_RIGHT)
        put(ws, f"G{r}", float(cny), font=F_TOTAL if bold else F_BODY,
            fill=FILL_TOTAL if bold else None, align=C_RIGHT, numfmt=FMT_CNY)
        put(ws, f"H{r}", None, fill=FILL_TOTAL if bold else None, align=C_RIGHT)
        put(ws, f"I{r}", float(usd), font=F_TOTAL if bold else F_BODY,
            fill=FILL_TOTAL if bold else None, align=C_RIGHT, numfmt=FMT_CNY)
        ws.row_dimensions[r].height = 18
        r += 1

    mrg(ws, f"A{r}:F{r}", value="TOTAL AMOUNT PAYABLE", font=F_GRAND,
        fill=FILL_GRAND, align=C_RIGHT)
    put(ws, f"G{r}", float(GRAND_CNY), font=F_GRAND, fill=FILL_GRAND,
        align=C_RIGHT, numfmt=FMT_CNY)
    put(ws, f"H{r}", None, font=F_GRAND, fill=FILL_GRAND, align=C_RIGHT)
    put(ws, f"I{r}", float(GRAND_USD), font=F_GRAND, fill=FILL_GRAND,
        align=C_RIGHT, numfmt=FMT_CNY)
    ws.row_dimensions[r].height = 22
    r += 1

    mrg(ws, f"A{r}:{LAST}{r}", value=usd_words(GRAND_USD), font=F_NOTE, align=C_LEFT)
    ws.row_dimensions[r].height = 18
    r = spacer(ws, r + 1, 8)

    pay_head = r
    r = section(ws, r, "Payment Status", sections)
    for label, cny, usd, status in (
            ("Deposit (30%, upon order confirmation)", DEP_CNY, DEP_USD,
             "Paid by Buyer"),
            ("Balance (70%, upon dispatch of the goods to Jiangsu / before "
             "delivery)", BAL_CNY, BAL_USD, "Due")):
        mrg(ws, f"A{r}:C{r}", value=label, font=F_LABEL, fill=FILL_TITLE, align=C_LEFT)
        mrg(ws, f"D{r}:F{r}", value=f"CNY {cny:,.2f}", align=C_RIGHT)
        mrg(ws, f"G{r}:H{r}", value=f"USD {usd:,.2f}", align=C_RIGHT)
        put(ws, f"I{r}", status, align=C_CENTER, font=F_BODY_B)
        ws.row_dimensions[r].height = 18
        r += 1
    r = spacer(ws, r)

    r = section(ws, r, "Bank Details for Remittance", sections)
    for label, value in (
            ("Beneficiary", SELLER.upper()),
            ("Beneficiary Address", SELLER_ADDR),
            ("Bank", "China Construction Bank Corporation, Hebei Anping Sub-branch, "
                     "Anping County, Hengshui City, Hebei Province, China"),
            ("Account No.", "13050171770800004556"),
            ("SWIFT Code", "PCBCCNBJHBX"),
            ("Beneficiary Tax ID", "91131125MA0GA4242U (Unified Social Credit Code)")):
        r = kv(ws, r, label, value)

    r = spacer(ws, r)
    decl = ("We hereby certify that the goods described in this invoice are of "
            "Chinese origin, that the particulars stated above are true and "
            "correct, and that the invoice value shown is the actual transaction "
            "value of the goods.  Export trade (general trade); export sales are "
            "zero-rated (0% VAT).")
    r = section(ws, r, "Declaration", sections)
    mrg(ws, f"A{r}:{LAST}{r}", value=decl, font=F_VALUE, align=C_JUST)
    ws.row_dimensions[r].height = h_for(decl, W_FULL)
    r += 1

    # 用户 2026-10-12：商业发票不写“谁报关 / 谁提供报关单证”——那是合同/报关层面的事，
    # 且“由钧骋报关”属未经核实的推断，发票上不得断言。
    r, _ = signature(ws, r + 1)
    finish(ws, r, sections=sections, forced=[pay_head - 1])
    save(wb, f"Commercial Invoice - Tim - 20261012.xlsx")


# ═══════════════════════════════════════════════ 02 装箱单 Packing List
# 【已停用 2026-10-12】用户明确：联佳不负责装箱，装箱单不由卖方出具
# （具体由谁出具未确认，单证中一律不点名）。
# 因此不再生成该单证，其他单证中也不再引用；函数保留以便日后需要时恢复。
def build_pl():
    wb, ws = new_book("Packing List")
    header(ws, "PACKING LIST")
    sections = []
    r = 5
    r = meta(ws, r, "Packing List No.", PL_NO, "Date", DOC_DATE)
    r = meta(ws, r, "Ref. Invoice No.", CI_NO, "Ref. Proforma Invoice", PI_NO)
    r = meta(ws, r, "Buyer", BUYER, "Consignee", CONSIGNEE)
    r = meta(ws, r, "Delivery Address", DELIVERY)
    r = meta(ws, r, "Incoterms", "DAP Yangzhou, Jiangsu, China",
             "Country of Origin", "China")
    r = spacer(ws, r)

    r = items_header(ws, r, ["No.", "Description", "Packages (Type & No.)", "Unit",
                             "Qty", "N.W. (KG)", "G.W. (KG)", "MEAS. (CBM)",
                             "Marks & Nos."])
    for i, it in enumerate(ITEMS):
        fill = FILL_ZEBRA if i % 2 else None
        put(ws, f"A{r}", it["no"], fill=fill, align=C_CENTER)
        put(ws, f"B{r}", it["name"], font=F_BODY_B, fill=fill, align=C_LEFT)
        put(ws, f"C{r}", it["package"], fill=fill, align=C_LEFT)
        put(ws, f"D{r}", it["unit"], fill=fill, align=C_CENTER)
        put(ws, f"E{r}", it["qty"], fill=fill, align=C_CENTER, numfmt="#,##0")
        put(ws, f"F{r}", float(it["nw"]), fill=fill, align=C_RIGHT, numfmt=FMT_CNY)
        put(ws, f"G{r}", float(it["gw"]), fill=fill, align=C_RIGHT, numfmt=FMT_CNY)
        put(ws, f"H{r}", float(it["cbm"]), fill=fill, align=C_RIGHT, numfmt=FMT_W3)
        put(ws, f"I{r}", "N/M", fill=fill, align=C_CENTER)
        ws.row_dimensions[r].height = item_h(it["package"])
        r += 1

    mrg(ws, f"A{r}:C{r}", value="TOTAL", font=F_TOTAL, fill=FILL_TOTAL, align=C_CENTER)
    put(ws, f"D{r}", None, fill=FILL_TOTAL)
    put(ws, f"E{r}", None, fill=FILL_TOTAL)
    put(ws, f"F{r}", float(NW_TOTAL), font=F_TOTAL, fill=FILL_TOTAL,
        align=C_RIGHT, numfmt=FMT_CNY)
    put(ws, f"G{r}", float(GW_TOTAL), font=F_TOTAL, fill=FILL_TOTAL,
        align=C_RIGHT, numfmt=FMT_CNY)
    put(ws, f"H{r}", float(CBM_TOTAL), font=F_TOTAL, fill=FILL_TOTAL,
        align=C_RIGHT, numfmt=FMT_W3)
    put(ws, f"I{r}", "25 PKGS", font=F_TOTAL, fill=FILL_TOTAL, align=C_CENTER)
    ws.row_dimensions[r].height = 22
    r += 1
    mrg(ws, f"A{r}:{LAST}{r}", value=f"Total packages: {PKG_TOTAL}", font=F_NOTE,
        align=C_LEFT)
    ws.row_dimensions[r].height = 18
    r = spacer(ws, r + 1)

    r = section(ws, r, "Packing Notes", sections)
    for note in (
            "1.  Y-Type Fence Posts: 400 pcs per pallet, steel-strapped.  Optional: "
            "one woven bag per 10 posts at CNY 2.50/bag.",
            "2.  Field Fence: supplied unwrapped.  Optional self-adhesive film "
            "wrapping at CNY 1.00/roll below 1.8 m height and CNY 2.00/roll at "
            "1.8 m and above.",
            "3.  Electric Fence Support Insulators: in the manufacturer's original "
            "packing (or in bags where the original packing is unavailable).",
            "4.  Goods are supplied unbranded; OEM marking on request.  Shipping "
            "marks: N/M.",
            "5.  Net weights are calculated from unit weights; gross weights and "
            "measurements are approximate and subject to final weighing."):
        mrg(ws, f"A{r}:{LAST}{r}", value=note, font=F_VALUE, align=C_LEFT)
        ws.row_dimensions[r].height = h_for(note, W_FULL)
        r += 1

    r = spacer(ws, r)
    r, _ = signature(ws, r)
    finish(ws, r, sections=sections)
    save(wb, f"Packing List - Tim - 20261012.xlsx")


# ═══════════════════════════════════════════════ 03 装运通知 Shipping Advice
def build_sa():
    wb, ws = new_book("Shipping Advice")
    header(ws, "SHIPPING ADVICE")
    sections = []
    r = 5
    r = meta(ws, r, "Advice No.", SA_NO, "Date", DOC_DATE)
    r = meta(ws, r, "Ref. Invoice No.", CI_NO, "Ref. Proforma Invoice", PI_NO)
    r = meta(ws, r, "Buyer", BUYER, "Consignee", CONSIGNEE)
    r = meta(ws, r, "Incoterms", "DAP Yangzhou, Jiangsu, China",
             "Country of Origin", "China")
    r = spacer(ws, r)

    intro = ("We hereby advise that the goods covered by the above invoice have "
             "been dispatched from our works to the delivery address designated "
             "by the buyer, as detailed below.")
    mrg(ws, f"A{r}:{LAST}{r}", value=intro, font=F_VALUE, align=C_JUST)
    ws.row_dimensions[r].height = h_for(intro, W_FULL)
    r = spacer(ws, r + 1)

    r = section(ws, r, "Goods Dispatched", sections)
    r = items_header(ws, r, ["No.", "Description", "Packages (Type & No.)", "Unit",
                             "Qty", "N.W. (KG)", "G.W. (KG)", "MEAS. (CBM)",
                             "Marks & Nos."])
    for i, it in enumerate(ITEMS):
        fill = FILL_ZEBRA if i % 2 else None
        put(ws, f"A{r}", it["no"], fill=fill, align=C_CENTER)
        put(ws, f"B{r}", it["name"], font=F_BODY_B, fill=fill, align=C_LEFT)
        put(ws, f"C{r}", it["package"], fill=fill, align=C_LEFT)
        put(ws, f"D{r}", it["unit"], fill=fill, align=C_CENTER)
        put(ws, f"E{r}", it["qty"], fill=fill, align=C_CENTER, numfmt="#,##0")
        put(ws, f"F{r}", float(it["nw"]), fill=fill, align=C_RIGHT, numfmt=FMT_CNY)
        put(ws, f"G{r}", float(it["gw"]), fill=fill, align=C_RIGHT, numfmt=FMT_CNY)
        put(ws, f"H{r}", float(it["cbm"]), fill=fill, align=C_RIGHT, numfmt=FMT_W3)
        put(ws, f"I{r}", "N/M", fill=fill, align=C_CENTER)
        ws.row_dimensions[r].height = item_h(it["package"])
        r += 1
    mrg(ws, f"A{r}:C{r}", value=f"TOTAL  ·  {PKG_TOTAL}", font=F_TOTAL,
        fill=FILL_TOTAL, align=C_CENTER)
    put(ws, f"D{r}", None, fill=FILL_TOTAL)
    put(ws, f"E{r}", None, fill=FILL_TOTAL)
    put(ws, f"F{r}", float(NW_TOTAL), font=F_TOTAL, fill=FILL_TOTAL,
        align=C_RIGHT, numfmt=FMT_CNY)
    put(ws, f"G{r}", float(GW_TOTAL), font=F_TOTAL, fill=FILL_TOTAL,
        align=C_RIGHT, numfmt=FMT_CNY)
    put(ws, f"H{r}", float(CBM_TOTAL), font=F_TOTAL, fill=FILL_TOTAL,
        align=C_RIGHT, numfmt=FMT_W3)
    put(ws, f"I{r}", "N/M", font=F_TOTAL, fill=FILL_TOTAL, align=C_CENTER)
    ws.row_dimensions[r].height = 22
    r = spacer(ws, r + 1)

    r = section(ws, r, "Transport Details", sections)
    for label, value in (
            ("Date of Dispatch", "To be advised upon completion of production"),
            ("Mode of Transport", "By road (truck) — Anping, Hebei → Baoying, "
                                  "Yangzhou, Jiangsu"),
            ("Carrier / Vehicle No.", "To be advised"),
            ("Place of Delivery", DELIVERY),
            ("Estimated Transit", "4–5 days after dispatch"),
            ("Consolidation & Export", f"{CONSIGNEE} — the buyer's supplier "
                                       "responsible for consolidating and shipping "
                                       "the consignment")):
        r = kv(ws, r, label, value)

    r = spacer(ws, r)
    r = section(ws, r, "Remarks", sections)
    for note in (
            f"1.  The 30% deposit of CNY {DEP_CNY:,.2f} (USD {DEP_USD:,.2f}) has "
            "been paid by the buyer.  The 70% balance of CNY "
            f"{BAL_CNY:,.2f} (USD {BAL_USD:,.2f}) becomes due upon dispatch of the "
            "goods to the delivery address.",
            "2.  Documents issued by the seller: Commercial Invoice and the "
            "China–Australia FTA Certificate of Origin (ChAFTA COO).",
            "3.  The buyer shall assist the seller in providing the relevant export "
            "customs declaration documents (customs declaration form, packing list "
            "and copies of the transport documents) required for the seller's export "
            "tax rebate and for the issuance of the Certificate of Origin.",
            "4.  Photographs of the goods are provided at each stage of production "
            "as agreed."):
        mrg(ws, f"A{r}:{LAST}{r}", value=note, font=F_VALUE, align=C_LEFT)
        ws.row_dimensions[r].height = h_for(note, W_FULL)
        r += 1

    r = spacer(ws, r)
    r, _ = signature(ws, r, buyer_label="Acknowledged by (Buyer)",
                     seller_label="Issued by (Seller)")
    finish(ws, r, sections=sections)
    save(wb, f"Shipping Advice - Tim - 20261012.xlsx")


# ═══════════════════════════════════════════════ 04 木包装声明 ISPM-15
# 【已停用 2026-10-12】用户明确：本单没有木包装，不需要木包装声明。
# 不再生成该单证，合同/装运通知的附件与单据清单也不得引用；函数保留以便日后需要时恢复。
def build_pd():
    wb, ws = new_book("Packing Declaration")
    header(ws, "PACKING DECLARATION",
           subtitle="Declaration on Wood Packing Materials — ISPM-15 Compliance")
    sections = []
    r = 5
    r = meta(ws, r, "Declaration No.", PD_NO, "Date", DOC_DATE)
    r = meta(ws, r, "Ref. Invoice No.", CI_NO, "Ref. Proforma Invoice", PI_NO)
    r = meta(ws, r, "Buyer", BUYER, "Consignee", CONSIGNEE)
    r = meta(ws, r, "Transport", "By road to Yangzhou, Jiangsu; onward consolidated "
                                 "shipment abroad", "Place of Delivery", "Yangzhou, Jiangsu, China")
    r = spacer(ws, r)

    r = section(ws, r, "Declaration", sections)
    for clause in (
            f"1.  We, {SELLER} (Anping County, Hebei Province, P. R. China), hereby "
            f"declare that the goods covered by Commercial Invoice No. {CI_NO}, "
            "consisting of the items and quantities stated therein, are packed as "
            "described in this declaration.",
            "2.  The pallet used for this consignment is made of wood and has been "
            "heat-treated (HT) in accordance with ISPM-15 (International Standards "
            "for Phytosanitary Measures No. 15).  The pallet bears the IPPC mark "
            "together with the country code CN and the treatment code HT, applied "
            "by a registered treatment facility.",
            "3.  All other packing materials used in this consignment — stretch "
            "film, woven bags, plastic bags and steel strapping — are of non-wood "
            "material.",
            "4.  The consignment contains no soil, no plant debris and no other "
            "wood or plant material that would require phytosanitary measures.",
            "5.  This declaration is issued for the buyer's export customs "
            "clearance and quarantine inspection purposes."):
        mrg(ws, f"A{r}:{LAST}{r}", value=clause, font=F_VALUE, align=C_JUST)
        ws.row_dimensions[r].height = h_for(clause, W_FULL)
        r += 1

    r = spacer(ws, r)
    r = section(ws, r, "Goods & Packing Summary", sections)
    r = items_header(ws, r, ["No.", "Description", "Packages (Type & No.)", "Unit",
                             "Qty", "N.W. (KG)", "G.W. (KG)", "MEAS. (CBM)",
                             "Wood Packing"])
    for i, it in enumerate(ITEMS):
        fill = FILL_ZEBRA if i % 2 else None
        put(ws, f"A{r}", it["no"], fill=fill, align=C_CENTER)
        put(ws, f"B{r}", it["name"], font=F_BODY_B, fill=fill, align=C_LEFT)
        put(ws, f"C{r}", it["package"], fill=fill, align=C_LEFT)
        put(ws, f"D{r}", it["unit"], fill=fill, align=C_CENTER)
        put(ws, f"E{r}", it["qty"], fill=fill, align=C_CENTER, numfmt="#,##0")
        put(ws, f"F{r}", float(it["nw"]), fill=fill, align=C_RIGHT, numfmt=FMT_CNY)
        put(ws, f"G{r}", float(it["gw"]), fill=fill, align=C_RIGHT, numfmt=FMT_CNY)
        put(ws, f"H{r}", float(it["cbm"]), fill=fill, align=C_RIGHT, numfmt=FMT_W3)
        put(ws, f"I{r}", it["wood"], fill=fill, align=C_CENTER)
        ws.row_dimensions[r].height = item_h(it["package"])
        r += 1
    mrg(ws, f"A{r}:C{r}", value=f"TOTAL  ·  {PKG_TOTAL}", font=F_TOTAL,
        fill=FILL_TOTAL, align=C_CENTER)
    put(ws, f"D{r}", None, fill=FILL_TOTAL)
    put(ws, f"E{r}", None, fill=FILL_TOTAL)
    put(ws, f"F{r}", float(NW_TOTAL), font=F_TOTAL, fill=FILL_TOTAL,
        align=C_RIGHT, numfmt=FMT_CNY)
    put(ws, f"G{r}", float(GW_TOTAL), font=F_TOTAL, fill=FILL_TOTAL,
        align=C_RIGHT, numfmt=FMT_CNY)
    put(ws, f"H{r}", float(CBM_TOTAL), font=F_TOTAL, fill=FILL_TOTAL,
        align=C_RIGHT, numfmt=FMT_W3)
    put(ws, f"I{r}", "1 pallet", font=F_TOTAL, fill=FILL_TOTAL, align=C_CENTER)
    ws.row_dimensions[r].height = 22
    r = spacer(ws, r + 1)

    r, _ = signature(ws, r, extra_note=(
        "The wooden pallet must carry a valid IPPC mark (CN + HT) applied by a "
        "registered treatment facility; a copy of the treatment certificate is "
        "available on request."))
    finish(ws, r, sections=sections)
    save(wb, f"Packing Declaration - Tim - 20261012.xlsx")


# ═══════════════════════════════════════════════ 05 原产地证 ChAFTA COO
def build_co():
    wb, ws = new_book("Certificate of Origin")
    header(ws, "CERTIFICATE OF ORIGIN",
           subtitle="China–Australia Free Trade Agreement (ChAFTA) — "
                    "Application Data Sheet")
    sections = []
    r = 5
    r = meta(ws, r, "Application No.", CO_NO, "Date", DOC_DATE)
    r = meta(ws, r, "Ref. Invoice No.", CI_NO, "Ref. Proforma Invoice", PI_NO)
    r = spacer(ws, r)

    note = ("The official Certificate of Origin is issued by the China Council for "
            "the Promotion of International Trade (CCPIT) or by China Customs. "
            "This data sheet contains the particulars required for that "
            "application; the certificate number is assigned by the issuing "
            "authority.")
    mrg(ws, f"A{r}:{LAST}{r}", value=note, font=F_SMALL, align=C_JUST)
    ws.row_dimensions[r].height = h_for(note, W_FULL)
    r = spacer(ws, r + 1)

    r = section(ws, r, "Certificate Particulars", sections)
    r = kv(ws, r, "1. Exporter / Producer",
           f"{SELLER}\n{SELLER_ADDR}\n{SELLER_CONTACT}")
    r = kv(ws, r, "2. Consignee",
           f"{BUYER} — Australia\n"
           f"{BUYER_CONTACT}\n"
           "Full legal name and address to be advised.")
    r = kv(ws, r, "3. Transport Details",
           "By road, Anping (Hebei) → Baoying, Yangzhou (Jiangsu) for consolidation; "
           "onward shipment by sea.  Port of loading, vessel / voyage and departure "
           "date to be advised by the consolidator "
           f"({CONSIGNEE}).")
    r = kv(ws, r, "4. Country of Origin", "P. R. China (CN)")
    r = kv(ws, r, "5. Country of Destination", "Australia (AU)")
    r = kv(ws, r, "6. Invoice No. & Date", f"{CI_NO}  ·  {DOC_DATE}")
    r = spacer(ws, r)

    r = section(ws, r, "Goods Details (Boxes 5–10)", sections)
    r = items_header(ws, r, ["Item No.", "Description of Goods", "Specification",
                             "Unit", "Qty", "HS Code", "Origin Criterion",
                             "Gross Wt. (KG)", "FOB Value (USD)"])
    for i, it in enumerate(ITEMS):
        fill = FILL_ZEBRA if i % 2 else None
        put(ws, f"A{r}", it["no"], fill=fill, align=C_CENTER)
        put(ws, f"B{r}", it["name"], font=F_BODY_B, fill=fill, align=C_LEFT)
        put(ws, f"C{r}", it["spec"], fill=fill, align=C_LEFT)
        put(ws, f"D{r}", it["unit"], fill=fill, align=C_CENTER)
        put(ws, f"E{r}", it["qty"], fill=fill, align=C_CENTER, numfmt="#,##0")
        put(ws, f"F{r}", it["hs"], fill=fill, align=C_CENTER)
        put(ws, f"G{r}", "PSR", fill=fill, align=C_CENTER)
        put(ws, f"H{r}", float(it["gw"]), fill=fill, align=C_RIGHT, numfmt=FMT_CNY)
        put(ws, f"I{r}", float(it["amt_usd"]), fill=fill, align=C_RIGHT, numfmt=FMT_CNY)
        ws.row_dimensions[r].height = item_h(it["spec"])
        r += 1
    mrg(ws, f"A{r}:E{r}", value="TOTAL", font=F_TOTAL, fill=FILL_TOTAL, align=C_RIGHT)
    put(ws, f"F{r}", None, fill=FILL_TOTAL)
    put(ws, f"G{r}", None, fill=FILL_TOTAL)
    put(ws, f"H{r}", float(GW_TOTAL), font=F_TOTAL, fill=FILL_TOTAL,
        align=C_RIGHT, numfmt=FMT_CNY)
    put(ws, f"I{r}", float(GOODS_USD), font=F_TOTAL, fill=FILL_TOTAL,
        align=C_RIGHT, numfmt=FMT_CNY)
    ws.row_dimensions[r].height = 22
    r += 1
    mrg(ws, f"A{r}:{LAST}{r}",
        value="Marks & Nos.: N/M  ·  Origin criterion: PSR (Product Specific Rule) — "
              "to be confirmed by the issuing authority against the applicable "
              "ChAFTA rule of origin.",
        font=F_SMALL, align=C_LEFT)
    ws.row_dimensions[r].height = 26
    r = spacer(ws, r + 1)

    r = section(ws, r, "Declaration by the Exporter (Box 11)", sections)
    decl = ("The undersigned hereby declares that the goods described above comply "
            "with the origin requirements specified for these goods under the "
            "China–Australia Free Trade Agreement, that the goods were produced in "
            "the People's Republic of China, and that the particulars given in this "
            "application are true and correct.")
    mrg(ws, f"A{r}:{LAST}{r}", value=decl, font=F_VALUE, align=C_JUST)
    ws.row_dimensions[r].height = h_for(decl, W_FULL)
    r += 1

    r, _ = signature(
        ws, r + 1,
        seller_label="11. Declaration by the Exporter (Seller)",
        buyer_label="Acknowledged by (Buyer)",
        extra_note=("Box 12 — Certification: to be completed and signed by CCPIT / "
                    "China Customs.  Certificate No. and date of issue are assigned "
                    "by the issuing authority."))
    finish(ws, r, sections=sections)
    save(wb, f"Certificate of Origin (ChAFTA COO) - Tim - 20261012.xlsx")


# ══════════════════════════════════════ 06 销售合同 Sales Contract
CONTRACT_CLAUSES = [
    ("1. Commodity & Quality",
     "The goods shall conform to the description and specification set out above "
     "and shall be manufactured in accordance with the seller's standard "
     "production practice, with hot-dip galvanizing to the relevant Chinese "
     "national standards.  A tolerance of ±5% in quantity and weight is allowed.  "
     "Country of origin: P. R. China."),
    ("2. Packing & Marking",
     "Packing as stated in Packing List No. " + PL_NO + ": Y-Type Fence Posts 400 "
     "pcs per pallet, steel-strapped; Field Fence supplied unwrapped; insulators "
     "in the manufacturer's original packing.  Goods supplied unbranded; OEM "
     "marking on request.  Shipping marks: N/M."),
    ("3. Delivery",
     "Delivery term: DAP Yangzhou, Jiangsu, China (Incoterms 2020).  Delivery to "
     "the buyer's designated address: " + DELIVERY + ".  Transit 4–5 days after "
     "dispatch.  The seller's responsibility ends upon delivery to that address; "
     "the consignment is thereafter consolidated and shipped by " + CONSIGNEE +
     ", another supplier of the buyer."),
    ("4. Payment",
     "T/T — 30% deposit upon signing of this contract; 70% balance to be paid in "
     f"full upon dispatch of the goods to the delivery address.  Deposit: CNY "
     f"{DEP_CNY:,.2f} (USD {DEP_USD:,.2f});  Balance: CNY {BAL_CNY:,.2f} "
     f"(USD {BAL_USD:,.2f}).  Bank charges outside China are for the buyer's "
     "account.  Please remit in USD to the beneficiary account stated on the "
     "Commercial Invoice."),
    ("5. Documents",
     "The seller shall provide the Commercial Invoice, the Packing List and a "
     "China–Australia FTA Certificate of Origin (ChAFTA COO; a standard CO if the "
     "ChAFTA COO cannot be issued).  The buyer shall arrange for the export "
     "customs declaration documents — customs declaration form, packing list, "
     "commercial invoice and copies of the transport documents — to be furnished "
     "to the seller, as required for the seller's export tax rebate and for the "
     "issuance of the Certificate of Origin."),
    ("6. Tax",
     "Export trade (general trade).  Export sales are zero-rated (0% VAT); the "
     "seller handles the export tax rebate.  The prices are exclusive of any "
     "import duties, taxes or charges levied in the country of destination."),
    ("7. Inspection & Claims",
     "The buyer shall inspect the goods upon arrival and shall notify the seller "
     "in writing of any claim within 30 days of arrival, supported by an "
     "inspection report issued by a recognised surveyor.  The seller shall not be "
     "liable for claims arising from improper storage, handling or use."),
    ("8. Force Majeure",
     "Neither party shall be liable for failure or delay in performance caused by "
     "events beyond its reasonable control, including but not limited to natural "
     "disasters, war, government action, epidemics, port congestion or strikes.  "
     "The affected party shall notify the other promptly and furnish evidence."),
    ("9. Arbitration",
     "Any dispute arising out of or in connection with this contract shall first "
     "be settled amicably; failing which it shall be submitted to the China "
     "International Economic and Trade Arbitration Commission (CIETAC) for "
     "arbitration in accordance with its rules then in force.  The award shall be "
     "final and binding upon both parties."),
    ("10. Governing Law",
     "This contract shall be governed by and construed in accordance with the "
     "laws of the People's Republic of China."),
    ("11. Entire Agreement",
     f"This contract supersedes Proforma Invoice No. {PI_NO} dated {PI_DATE} "
     "where the two differ.  Any amendment shall be made in writing and signed by "
     "both parties.  This contract is made in English in two originals, one for "
     "each party."),
]


def build_ct_clause_form():
    """旧版：散文条款式、全英文（保留备用，不写入正式文件）。"""
    wb, ws = new_book("Sales Contract (clause form)")
    header(ws, "SALES CONTRACT",
           subtitle=f"Contract No. {SC_NO}   ·   Ref. Proforma Invoice {PI_NO}")
    sections = []
    r = 5
    r = meta(ws, r, "Contract No.", SC_NO, "Date", DOC_DATE)
    r = meta(ws, r, "Ref. Proforma Invoice", PI_NO, "Ref. Quotation", QUO_NO)
    r = meta(ws, r, "Currency / Exchange Rate", RATE_NOTE)
    r = spacer(ws, r)

    r = section(ws, r, "Parties", sections)
    r = kv(ws, r, "The Seller", f"{SELLER}\n{SELLER_ADDR}\n{SELLER_CONTACT}")
    r = kv(ws, r, "The Buyer", f"{BUYER}\n{BUYER_CONTACT}")
    r = kv(ws, r, "Consignee & Address", f"{CONSIGNEE}\n{DELIVERY}")
    r = spacer(ws, r)

    r = section(ws, r, "Goods & Price", sections)
    r = items_header(ws, r, ["No.", "Description", "Specification", "Unit", "Qty",
                             "Unit Price (CNY)", "Amount (CNY)",
                             "Unit Price (USD)", "Amount (USD)"])
    for i, it in enumerate(ITEMS):
        fill = FILL_ZEBRA if i % 2 else None
        put(ws, f"A{r}", it["no"], fill=fill, align=C_CENTER)
        put(ws, f"B{r}", it["name"], font=F_BODY_B, fill=fill, align=C_LEFT)
        put(ws, f"C{r}", it["spec"], fill=fill, align=C_LEFT)
        put(ws, f"D{r}", it["unit"], fill=fill, align=C_CENTER)
        put(ws, f"E{r}", it["qty"], fill=fill, align=C_CENTER, numfmt="#,##0")
        put(ws, f"F{r}", float(it["cny"]), fill=fill, align=C_RIGHT, numfmt=FMT_CNY)
        put(ws, f"G{r}", float(it["amt_cny"]), fill=fill, align=C_RIGHT, numfmt=FMT_CNY)
        put(ws, f"H{r}", float(it["usd"]), fill=fill, align=C_RIGHT, numfmt=FMT_USD4)
        put(ws, f"I{r}", float(it["amt_usd"]), fill=fill, align=C_RIGHT, numfmt=FMT_CNY)
        ws.row_dimensions[r].height = item_h(it["spec"])
        r += 1

    mrg(ws, f"A{r}:F{r}", value="Rounding adjustment (unit prices rounded to 2 decimals)",
        font=F_NOTE, align=C_RIGHT)
    put(ws, f"G{r}", -2.54, font=F_NOTE, align=C_RIGHT, numfmt=FMT_CNY)
    put(ws, f"H{r}", None, font=F_NOTE, align=C_RIGHT)
    put(ws, f"I{r}", -0.37, font=F_NOTE, align=C_RIGHT, numfmt=FMT_CNY)
    ws.row_dimensions[r].height = 16
    r += 1
    for label, cny, usd in (("Total Goods Value", GOODS_CNY, GOODS_USD),
                            ("Inland Freight to Delivery Address", FREIGHT_CNY,
                             FREIGHT_USD)):
        mrg(ws, f"A{r}:F{r}", value=label, align=C_RIGHT)
        put(ws, f"G{r}", float(cny), align=C_RIGHT, numfmt=FMT_CNY)
        put(ws, f"H{r}", None, align=C_RIGHT)
        put(ws, f"I{r}", float(usd), align=C_RIGHT, numfmt=FMT_CNY)
        ws.row_dimensions[r].height = 16
        r += 1
    mrg(ws, f"A{r}:F{r}", value="TOTAL CONTRACT VALUE", font=F_GRAND,
        fill=FILL_GRAND, align=C_RIGHT)
    put(ws, f"G{r}", float(GRAND_CNY), font=F_GRAND, fill=FILL_GRAND,
        align=C_RIGHT, numfmt=FMT_CNY)
    put(ws, f"H{r}", None, font=F_GRAND, fill=FILL_GRAND, align=C_RIGHT)
    put(ws, f"I{r}", float(GRAND_USD), font=F_GRAND, fill=FILL_GRAND,
        align=C_RIGHT, numfmt=FMT_CNY)
    ws.row_dimensions[r].height = 20
    r += 1
    mrg(ws, f"A{r}:{LAST}{r}", value=usd_words(GRAND_USD), font=F_NOTE, align=C_LEFT)
    ws.row_dimensions[r].height = 16
    r = spacer(ws, r + 1)

    terms_head = r
    r = section(ws, r, "Terms & Conditions", sections)
    for label, text in CONTRACT_CLAUSES:
        sections.append(r)
        mrg(ws, f"A{r}:B{r}", value=label, font=F_LABEL, fill=FILL_TITLE,
            align=C_LEFT)
        mrg(ws, f"C{r}:{LAST}{r}", value=text, font=F_VALUE, align=C_JUST)
        ws.row_dimensions[r].height = h_for(text, W_CI)
        r += 1

    r = spacer(ws, r)
    r, _ = signature(ws, r, buyer_label="The Buyer (Signature & Stamp)",
                     seller_label="The Seller (Signature & Stamp)")
    finish(ws, r, sections=sections, forced=[terms_head - 1])
    save(wb, f"Sales Contract (clause form) - Tim - 20261012.xlsx")


# ══════════════════════════ 06b 销售合同（正式版·中英对照，交银行审贸易背景）
ITEMS_ZH = {
    1: ("Y型栅栏立柱",
        "高度 1.83 m  ·  材质：轨道钢  ·  热浸镀锌  ·  单位重量 1.86 kg/m"),
    2: ("牛栏网",
        "高度 1.473 m  ·  竖丝 Ø2.4 mm，间距 10 cm  ·  横丝 Ø2.5 mm，共 10 根  ·  "
        "热浸镀锌，锌层 200 g/m²  ·  每卷 50 m  ·  净重 53.5 kg/卷"),
    3: ("电围栏支撑绝缘子",
        "支撑高度 200 mm  ·  绝缘材质  ·  原厂包装"),
}

CT_INTRO_EN = ("This Contract is made by and between the Seller and the Buyer, "
               "whereby the Seller agrees to sell and the Buyer agrees to buy the "
               "under-mentioned goods subject to the terms and conditions "
               "stipulated below.  Both parties have read and accepted all the "
               "terms hereof.")
CT_INTRO_ZH = ("本合同由卖方与买方签订：卖方同意出售、买方同意购买下列货物，"
               "并按本合同所列条款执行。双方已阅读并接受本合同全部条款。")

CT_KEYS = (
    ("Terms of Delivery / 交货条件",
     "DAP Yangzhou, Jiangsu, China —— 交货至江苏扬州指定地址"),
    ("Terms of Payment / 付款方式",
     "T/T —— 30% deposit upon order confirmation, paid by the Buyer; 70% balance "
     "before dispatch（订单确认后付 30% 定金，买方已支付；发货前付清 70% 尾款）"),
    ("Time of Delivery / 交货期",
     "Posts 立柱 approx. 10 days 约 10 天;  Field Fence 牛栏网 approx. 40 days 约 40 天"),
    ("Port of Loading / 装运港", "N/A 不适用（见下方说明 see note below）"),
    ("Port of Destination / 目的港", "N/A 不适用（见下方说明 see note below）"),
    ("Shipping Marks / 唛头", "N/M"),
)

CT_PORT_NOTE = (
    "Note 说明：Port of Loading / Port of Destination are not applicable to the "
    "seller — the goods are delivered DAP to the address designated by the buyer in "
    "Yangzhou, Jiangsu, and the consignment is consolidated and exported by the "
    "buyer's supplier, Jiangsu Juncheng Vehicle Industry Co., Ltd.\n"
    "装运港 / 目的港与卖方无关：货物以 DAP 条件交至买方指定的江苏扬州地址，"
    "由买方供货商江苏钧骋车业有限公司负责拼柜出运。")

CT_CLAUSES = (
    ("1. Quality 品质",
     "The goods shall conform to the description and specification set out above "
     "and shall be hot-dip galvanized as specified therein.  Country of origin: "
     "P. R. China.",
     "货物应符合上表所列名称与规格，并按要求进行热浸镀锌处理。原产国：中国。"),
    ("2. Packing 包装",
     "Y-Type Fence Posts: 400 pcs per pallet; optional one woven bag per 10 posts "
     "at CNY 2.50/bag.  Field Fence: supplied unwrapped; optional self-adhesive "
     "film wrapping at CNY 1.00/roll below 1.8 m height and CNY 2.00/roll at 1.8 m "
     "and above.  Electric Fence Support Insulators: in the manufacturer's "
     "original packing, or in bags where the original packing is unavailable.  "
     "Optional packing charged extra.  Goods supplied unbranded; OEM marking on "
     "request.  Shipping marks: N/M.",
     "Y 型立柱：每托 400 根，可选每 10 根加装编织袋（CNY 2.50/个）。牛栏网："
     "裸装，可选自吸膜缠绕包装（1.8 m 以下 CNY 1.00/卷，1.8 m 及以上 "
     "CNY 2.00/卷）。电围栏支撑绝缘子：原厂包装，无原厂包装时装袋发货。可选"
     "包装另行计费。货物无商标，可按需贴牌。唛头：N/M。"),
    ("3. Delivery 交货",
     "Delivery term: DAP Yangzhou, Jiangsu, China (Incoterms 2020).  Delivery "
     "to the buyer's "
     "designated address: " + DELIVERY + ".  Transit 4–5 days after dispatch.  "
     "The seller's responsibility ends upon delivery to the designated address, "
     "where the goods are consolidated and shipped by " + CONSIGNEE +
     ", another supplier of the buyer.  Total weight approx. 2,435 kg; total "
     "volume approx. 7.35 CBM.  Inland freight to the delivery address: CNY "
     "750.00 (USD 111.89), included in the total amount payable.  The seller will "
     "keep the buyer informed by providing photographs of the goods at each "
     "stage of production.",
     "交货条件：DAP 江苏扬州（Incoterms 2020）。送货至买方指定地址：" + DELIVERY_ZH + "，发运后运输 "
     "4–5 天。卖方责任至该指定地址交货为止；此后货物由买方另一供货商" +
     CONSIGNEE_ZH + "负责拼柜发运。总重约 2,435 kg，总体积约 7.35 CBM。至交货地址"
     "的内陆运费 CNY 750.00（USD 111.89），已含在总金额内。生产期间卖方将按"
     "生产环节向买方提供货物照片。"),
    ("4. Payment 付款",
     f"T/T — 30% deposit upon order confirmation; 70% balance to be paid "
     f"in full upon dispatch of the goods to Jiangsu (before delivery).  Deposit: "
     f"CNY {DEP_CNY:,.2f} (USD {DEP_USD:,.2f}), already paid by the Buyer;  "
     f"balance: CNY {BAL_CNY:,.2f} (USD {BAL_USD:,.2f}).  Please remit in USD.",
     f"电汇（T/T）：订单确认后付 30% 定金；发货至江苏时（交货前）付清 70% "
     f"尾款。定金：CNY {DEP_CNY:,.2f}（USD {DEP_USD:,.2f}），买方已支付；"
     f"尾款：CNY {BAL_CNY:,.2f}（USD {BAL_USD:,.2f}）。请以美元汇款。"),
    ("5. Documents 单据",
     "Documents provided by the seller: a "
     "China–Australia FTA Certificate of Origin (ChAFTA COO), enabling the "
     "buyer to claim preferential tariff treatment; failing which a standard CO "
     "is issued instead.  Charges for the Certificate of Origin are borne by the "
     "seller and NOT included in the total.  The buyer shall "
     "assist the seller in providing the relevant export customs declaration "
     "documents — customs declaration form, packing list, copies of the transport "
     "documents and such other documents as may be required — required for the "
     "seller's export tax rebate and for the issuance of the Certificate of "
     "Origin.",
     "卖方提供：中澳自贸协定原产地证（ChAFTA COO，便于买方"
     "享受关税优惠；无法出具时提供普通 CO）。原产地证费用由卖方承担，不计"
     "入总价。买方应协助卖方提供相关出口报关单证——报关单、装箱单、运输单据"
     "副本及其他所需的单证——用于卖方出口退税及办理原产地证。"),
    ("6. Tax 税费",
     "Export trade (general trade).  Export sales are zero-rated (0% VAT); the "
     "seller handles the export tax rebate.",
     "出口贸易（一般贸易）。出口销售适用零税率（0% VAT），出口退税由卖方办理。"),
    ("7. Price Basis 价格基础",
     "Unit prices are rounded to 2 decimal places; totals are calculated from "
     "unrounded unit prices (see the rounding adjustment in the table above).  "
     "USD amounts are converted at 1 USD = 6.7029 CNY (Bank of China USD spot "
     "buying rate, 2026-09-28).",
     "单价按 2 位小数四舍五入列示；合计按未舍入单价计算（见上表「舍入调整」"
     "行）。美元金额按 1 USD = 6.7029 CNY 折算（2026-09-28 中国银行美元现汇"
     "买入价）。"),
    ("8. Inspection & Claims 检验与索赔",
     "The buyer shall inspect the goods upon arrival and shall notify the seller in "
     "writing of any claim within 30 days of arrival, supported by an inspection "
     "report issued by a recognised surveyor.  The seller shall not be liable for "
     "claims arising from improper storage, handling or use.",
     "买方应于货到后检验，如有索赔应于到货后 30 天内书面通知卖方，并附认可检验"
     "机构出具的检验报告。因不当储存、搬运或使用引起的索赔，卖方不承担责任。"),
    ("9. Force Majeure 不可抗力",
     "Neither party shall be liable for failure or delay in performance caused by "
     "events beyond its reasonable control, including but not limited to natural "
     "disasters, war, government action, epidemics, port congestion or strikes.  "
     "The affected party shall notify the other promptly and furnish evidence.",
     "因不可抗力（包括但不限于自然灾害、战争、政府行为、疫情、港口拥堵、罢工）"
     "导致不能或延迟履行的，双方互不承担责任。受影响方应及时通知对方并提供证明。"),
    ("10. Arbitration 仲裁",
     "Any dispute arising out of or in connection with this contract shall first be "
     "settled amicably; failing which it shall be submitted to the China "
     "International Economic and Trade Arbitration Commission (CIETAC) for "
     "arbitration in accordance with its rules then in force.  The award shall be "
     "final and binding upon both parties.",
     "因本合同引起的或与本合同有关的任何争议，应首先友好协商解决；协商不成，"
     "提交中国国际经济贸易仲裁委员会（CIETAC）按其现行仲裁规则仲裁。仲裁裁决"
     "为终局裁决，对双方均有约束力。"),
    ("11. Governing Law 适用法律",
     "This contract shall be governed by the laws of the People's Republic of "
     "China.  This contract is made pursuant to Proforma Invoice No. " + PI_NO +
     " dated " + PI_DATE + ", the terms of which form part of this contract; in "
     "the event of any inconsistency between the two, " + PI_NO + " shall "
     "prevail.  This Contract is made in English and Chinese, both texts being "
     "equally authentic.  In case of any discrepancy, the Chinese version shall "
     "prevail.  Any amendment shall be made in writing signed by both parties.  "
     "Two originals, one for each party.",
     "本合同适用中华人民共和国法律。本合同依据 " + PI_DATE_ZH + " 出具的形式发票 " +
     PI_NO + " 签订，该形式发票条款构成本合同组成部分；两者如有不一致，以 " +
     PI_NO + " 为准。本合同以中英文书就，两种文本具有同等法律效力；如中英文" +
     "不一致，以中文文本为准。任何修改须经双方书面签署。一式两份，双方各执一份。"),
    ("12. Effectiveness & Annexes 生效与附件",
     "This contract shall come into effect upon being signed and stamped by both "
     "parties.  The parties agree that it may be signed and exchanged by electronic "
     "means — scanned copies exchanged by e-mail, or signature through an electronic "
     "signature platform — and that such signed copies shall have the same legal "
     "effect as the originals.  Annexes forming an integral part of this contract: "
     "Proforma Invoice No. " + PI_NO + "; Commercial Invoice No. " + CI_NO + ".",
     "本合同自双方签字盖章之日起生效。双方同意本合同可通过电子方式签署并交换"
     "——以电子邮件交换扫描件，或经电子签名平台签署——该等签署副本与原件具有"
     "同等法律效力。构成本合同组成部分的附件：形式发票 " + PI_NO +
     "、商业发票 " + CI_NO + "。"),
)


def build_ct_formal():
    """正式销售合同（中英对照）—— 供国内银行审贸易背景 / 双方签章使用。"""
    wb, ws = new_book("Sales Contract", CT_WIDTHS)
    header(ws, "SALES CONTRACT / 销售合同",
           subtitle=f"Contract No. {SC_NO}   ·   Ref. Proforma Invoice {PI_NO}")
    sections = []
    r = 5
    r = meta(ws, r, "Contract No. / 合同号", SC_NO, "Date / 签订日期", DOC_DATE)
    r = meta(ws, r, "Signed At / 签约地点",
             "Anping, Hebei, China（中国河北安平 · 扫描件签署 scanned-copy signing）",
             "Currency / 币种", "USD / 美元")
    r = meta(ws, r, "Ref. PI / 参照形式发票", PI_NO, "Ref. Quote / 报价单", QUO_NO)
    r = spacer(ws, r)

    mrg(ws, f"A{r}:{LAST}{r}", value=CT_INTRO_EN, font=F_VALUE, align=C_JUST)
    ws.row_dimensions[r].height = h_for(CT_INTRO_EN, W_FULL)
    r += 1
    mrg(ws, f"A{r}:{LAST}{r}", value=CT_INTRO_ZH, font=F_VALUE, align=C_LEFT)
    ws.row_dimensions[r].height = h_for(CT_INTRO_ZH, W_FULL)
    r = spacer(ws, r + 1)

    r = section(ws, r, "PARTIES / 合同双方", sections)
    s_txt = (f"{SELLER_ZH} / {SELLER}\n"
             f"{SELLER_ADDR_ZH}\n"
             "100 meters north of Diwo Village, Anping County,\n"
             "Hengshui City, Hebei Province, China\n"
             "电话 Tel: +86 136 0318 1774  ·  邮箱 E-mail: sales@lianjiafence.com\n"
             "税号 Tax ID: 91131125MA0GA4242U")
    b_txt = (f"{BUYER} 澳大利亚 Australia\n"
             "电话 Tel: +61 438 381 068  ·  邮箱 E-mail: timlyons@oneatmosphere.com\n"
             f"收货地址 Delivery Address: {DELIVERY_ZH}\n"
             "No. 1 Guangling Road, Sheyanghu Industrial Park,\n"
             "Baoying County, Yangzhou City, Jiangsu Province, China")
    mrg(ws, f"A{r}:C{r}", value="The Seller / 卖方", font=F_LABEL, fill=FILL_TITLE,
        align=C_LEFT)
    mrg(ws, f"D{r}:{LAST}{r}", value="The Buyer / 买方", font=F_LABEL, fill=FILL_TITLE,
        align=C_LEFT)
    ws.row_dimensions[r].height = 16
    r += 1
    mrg(ws, f"A{r}:C{r}", value=s_txt, font=F_VALUE, align=C_LEFT)
    mrg(ws, f"D{r}:{LAST}{r}", value=b_txt, font=F_VALUE, align=C_LEFT)
    ws.row_dimensions[r].height = max(est_lines(s_txt, 88), est_lines(b_txt, 70)) * LINE + 6
    r = spacer(ws, r + 1)

    r = section(ws, r, "GOODS & PRICE / 货物与价格", sections)
    heads = ((f"A{r}", "No.\n序号"),
             (f"B{r}", "Description\n货物名称"),
             (f"C{r}", "Specification\n规格"),
             (f"D{r}", "Unit\n单位"),
             (f"E{r}", "Qty\n数量"),
             (f"F{r}", "Unit Price CNY\n单价 人民币"),
             (f"G{r}", "Amount CNY\n金额 人民币"),
             (f"H{r}", "Unit Price USD\n单价 美元"),
             (f"I{r}", "Amount USD\n金额 美元"))
    for spec, txt in heads:
        put(ws, spec, txt, font=F_HEAD, fill=FILL_HEAD, align=C_CENTER)
    ws.row_dimensions[r].height = max(est_lines(t, 14) for _, t in heads) * LINE + 6
    r += 1
    for i, it in enumerate(ITEMS):
        zh_name, _zh_spec = ITEMS_ZH[it["no"]]
        fill = FILL_ZEBRA if i % 2 else None
        put(ws, f"A{r}", it["no"], fill=fill, align=C_CENTER)
        put(ws, f"B{r}", f"{it['name']}\n{zh_name}", font=F_BODY_B, fill=fill,
            align=C_LEFT)
        put(ws, f"C{r}", it["spec"], fill=fill, align=C_LEFT)
        put(ws, f"D{r}", it["unit"], fill=fill, align=C_CENTER)
        put(ws, f"E{r}", it["qty"], fill=fill, align=C_CENTER, numfmt="#,##0")
        put(ws, f"F{r}", float(it["cny"]), fill=fill, align=C_RIGHT, numfmt=FMT_CNY)
        put(ws, f"G{r}", float(it["amt_cny"]), fill=fill, align=C_RIGHT, numfmt=FMT_CNY)
        put(ws, f"H{r}", float(it["usd"]), fill=fill, align=C_RIGHT, numfmt=FMT_USD4)
        put(ws, f"I{r}", float(it["amt_usd"]), fill=fill, align=C_RIGHT, numfmt=FMT_CNY)
        ws.row_dimensions[r].height = max(
            est_lines(it["spec"], col_width(ws, "C", "C")),
            est_lines(f"{it['name']}\n{zh_name}", col_width(ws, "B", "B"))) * LINE + 8
        r += 1

    mrg(ws, f"A{r}:F{r}", value="Rounding adjustment / 舍入调整", font=F_NOTE,
        align=C_RIGHT)
    put(ws, f"G{r}", -2.54, font=F_NOTE, align=C_RIGHT, numfmt=FMT_CNY)
    put(ws, f"H{r}", None, font=F_NOTE, align=C_RIGHT)
    put(ws, f"I{r}", -0.37, font=F_NOTE, align=C_RIGHT, numfmt=FMT_CNY)
    ws.row_dimensions[r].height = 16
    r += 1
    for label, cny, usd in (("Total Goods Value / 货物总值", GOODS_CNY, GOODS_USD),
                            ("Inland Freight / 内陆运费", FREIGHT_CNY, FREIGHT_USD)):
        mrg(ws, f"A{r}:F{r}", value=label, align=C_RIGHT)
        put(ws, f"G{r}", float(cny), align=C_RIGHT, numfmt=FMT_CNY)
        put(ws, f"H{r}", None, align=C_RIGHT)
        put(ws, f"I{r}", float(usd), align=C_RIGHT, numfmt=FMT_CNY)
        ws.row_dimensions[r].height = 16
        r += 1
    mrg(ws, f"A{r}:F{r}", value="TOTAL CONTRACT VALUE / 合同总金额", font=F_GRAND,
        fill=FILL_GRAND, align=C_RIGHT)
    put(ws, f"G{r}", float(GRAND_CNY), font=F_GRAND, fill=FILL_GRAND,
        align=C_RIGHT, numfmt=FMT_CNY)
    put(ws, f"H{r}", None, font=F_GRAND, fill=FILL_GRAND, align=C_RIGHT)
    put(ws, f"I{r}", float(GRAND_USD), font=F_GRAND, fill=FILL_GRAND,
        align=C_RIGHT, numfmt=FMT_CNY)
    ws.row_dimensions[r].height = 20
    r += 1
    mrg(ws, f"A{r}:{LAST}{r}", value=usd_words(GRAND_USD), font=F_NOTE, align=C_LEFT)
    ws.row_dimensions[r].height = 16
    r += 1
    rate_note = ("Exchange rate / 汇率：1 USD = 6.7029 CNY"
                 "（2026-09-28 中国银行美元现汇买入价 670.29/100）")
    mrg(ws, f"A{r}:{LAST}{r}", value=rate_note, font=F_SMALL, align=C_LEFT)
    ws.row_dimensions[r].height = 16
    r = spacer(ws, r + 1)

    r = section(ws, r, "KEY TERMS / 主要条款", sections)
    for label, value in CT_KEYS:
        r = meta(ws, r, label, value)
    mrg(ws, f"A{r}:{LAST}{r}", value=CT_PORT_NOTE, font=F_SMALL, align=C_LEFT)
    ws.row_dimensions[r].height = h_for(CT_PORT_NOTE, W_FULL)
    r = spacer(ws, r + 1)

    r = section(ws, r, "PAYMENT & BANK DETAILS / 付款与收款账户", sections)
    for label, value in (
            ("Beneficiary 收款人", f"{SELLER} / {SELLER_ZH}"),
            ("Bank 开户银行",
             "China Construction Bank Corporation, Hebei Anping Sub-branch, Anping "
             "County, Hengshui City, Hebei Province, China "
             "中国建设银行股份有限公司河北省安平支行"),
            ("Account No. 账号", "13050171770800004556"),
            ("SWIFT Code", "PCBCCNBJHBX"),
            ("Beneficiary Tax ID 税号",
             "91131125MA0GA4242U（统一社会信用代码）"),
            ("Payment 付款路径",
             f"T/T in USD to the account above —— deposit USD {DEP_USD:,.2f} "
             f"(paid by the Buyer), balance USD {BAL_USD:,.2f}.  Please remit in "
             f"USD.\n"
             f"以美元电汇至上述账户：定金 USD {DEP_USD:,.2f}（买方已支付）、"
             f"尾款 USD {BAL_USD:,.2f}。请以美元汇款。")):
        r = kv(ws, r, label, value)
    r = spacer(ws, r)

    r = section(ws, r, "GENERAL TERMS / 一般条款", sections)
    mrg(ws, f"A{r}:B{r}", value="Clause / 条款", font=F_HEAD, fill=FILL_HEAD,
        align=C_CENTER)
    mrg(ws, f"C{r}:F{r}", value="Terms & Conditions / 条款内容（英文）", font=F_HEAD,
        fill=FILL_HEAD, align=C_CENTER)
    mrg(ws, f"G{r}:{LAST}{r}", value="条款内容（中文）", font=F_HEAD,
        fill=FILL_HEAD, align=C_CENTER)
    ws.row_dimensions[r].height = 20
    r += 1
    for label, en, zh in CT_CLAUSES:
        sections.append(r)
        fill = FILL_ZEBRA if (r % 2) else None
        mrg(ws, f"A{r}:B{r}", value=label, font=F_LABEL, fill=FILL_TITLE, align=C_LEFT)
        mrg(ws, f"C{r}:F{r}", value=en, font=F_VALUE, fill=fill, align=C_LEFT)
        mrg(ws, f"G{r}:{LAST}{r}", value=zh, font=F_VALUE, fill=fill, align=C_LEFT)
        ws.row_dimensions[r].height = max(est_lines(en, 76), est_lines(zh, 46)) * LINE + 4
        r += 1

    r = spacer(ws, r)
    r, _ = simple_sign(
        ws, r,
        rows=(
            ("Buyer's Representative 买方代表: Tim Lyons",
             f"Seller's Representative 卖方代表: {SIGNER_ZH} ({SIGNER_EN})"),
            ("Company Stamp / Signature 公司盖章 / 签字: ______________________",
             "Company Stamp / Signature 公司盖章 / 签字: ______________________"),
            ("Date 日期: ______________________",
             f"Date 日期: {DOC_DATE}"),
        ),
        stamp_w=230, stamp_row=1, stamp_col="G")
    finish(ws, r, sections=sections)
    save(wb, f"Sales Contract - Tim - 20261012.xlsx")


if __name__ == "__main__":
    os.makedirs(OUT_DIR, exist_ok=True)
    print("== 01 Commercial Invoice ==")
    build_ci()
    # 02 装箱单 Packing List —— 已按用户要求停用（联佳不负责装箱，装箱单由出口方出具）
    print("== 03 Shipping Advice ==")
    build_sa()
    # 04 木包装声明 ISPM-15 —— 已按用户要求停用（本单无木包装，不需要声明）
    print("== 05 Certificate of Origin ==")
    build_co()
    print("== 06 Sales Contract (formal, bilingual) ==")
    build_ct_formal()
    print("\nNW=%.2f  GW=%.2f  CBM=%.3f  grand=USD %.2f (%s)"
          % (NW_TOTAL, GW_TOTAL, CBM_TOTAL, GRAND_USD, usd_words(GRAND_USD)))
