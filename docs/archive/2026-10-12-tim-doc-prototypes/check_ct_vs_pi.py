# -*- coding: utf-8 -*-
"""核对：销售合同是否完整、无偏移地承继了 PI（LJ-PI-20260929-01）的业务条款。

做法：把 PI xlsx 里的条款文本与合同 PDF 文本都去空白规整，然后逐条检查
PI 的关键业务事实是否能在合同中找到（金额、交货、付款、包装、原产地、税费、汇率）。
"""
import re
from pathlib import Path

import openpyxl
import pymupdf

D = Path(r"D:\projects\报价制作")
TIM = D / "Tim"


def norm(s):
    return re.sub(r"\s+", "", str(s))


pi_ws = openpyxl.load_workbook(D / "Proforma Invoice - Buyer - 20260929.xlsx").active
ct_pdf = pymupdf.open(TIM / "Sales Contract - Buyer - 20261012.pdf")
ct = norm("".join(p.get_text() for p in ct_pdf))

# PI 条款区文本，打印出来供人工复核
print("== PI 业务条款（原文） ==")
for r in range(5, pi_ws.max_row + 1):
    a = pi_ws[f"A{r}"].value
    c = pi_ws[f"C{r}"].value
    g = pi_ws[f"G{r}"].value
    if a and c:
        print(f"  [{a}] {str(c)[:150]}")
    elif a and g is not None:
        print(f"  [{a}] {g}")

# 必须承继到合同里的业务事实
CHECKS = [
    ("PI 号", "LJ-PI-20260929-01"),
    ("报价单号", "LJ-Q-20260928-01"),
    ("贸易术语", "DAPYangzhou,Jiangsu,China"),
    ("付款方式", "30%deposit"),
    ("尾款条件", "70%balance"),
    ("定金 CNY", "5,683.70"),
    ("定金 USD", "847.95"),
    ("尾款 CNY", "13,261.96"),
    ("尾款 USD", "1,978.54"),
    ("货物总值 USD", "2,714.60"),
    ("内陆运费 CNY", "750.00"),
    ("内陆运费 USD", "111.89"),
    ("合同总金额 USD", "2,826.49"),
    ("汇率", "6.7029"),
    ("交货地址", "No.1GuanglingRoad,SheyanghuIndustrialPark,BaoyingCounty"),
    ("运输时效", "4–5daysafterdispatch"),
    ("总重", "2,435kg"),
    ("总体积", "7.35CBM"),
    ("立柱工期", "approx.10days"),
    ("牛栏网工期", "approx.40days"),
    ("生产拍照", "photographs"),
    ("立柱包装", "400pcsperpallet"),
    ("编织袋加价", "CNY2.50/bag"),
    ("自吸膜（<1.8m）", "CNY1.00/roll"),
    ("自吸膜（>=1.8m）", "CNY2.00/roll"),
    ("可选包装另计费", "chargedextra"),
    ("无商标", "unbranded"),
    ("贴牌", "OEMmarking"),
    ("唛头", "N/M"),
    ("拼柜方", "JiangsuJunchengVehicleIndustryCo.,Ltd."),
    ("报关单证清单", "customsdeclarationform"),
    ("装箱单", "packinglist"),
    ("商业发票", "commercialinvoice"),
    ("运输单据副本", "copiesofthetransportdocuments"),
    ("原产地证", "ChAFTA"),
    ("CO 费用卖方承担", "bornebytheseller"),
    ("零税率", "0%VAT"),
    ("出口退税", "exporttaxrebate"),
    ("单价 2 位舍入口径", "roundedto2decimalplaces"),
    ("以 USD 汇款", "remitinUSD"),
    ("单价 CNY 25.00", "25.0000"),
    ("单价 CNY 366.31", "366.3100"),
    ("单价 CNY 2.18", "2.1800"),
]

print("\n== 合同承继 PI 条款核对 ==")
bad = []
for name, needle in CHECKS:
    ok = norm(needle) in ct
    print(f"  {'OK  ' if ok else 'MISS'}  {name:<20} {needle}")
    if not ok:
        bad.append(name)

print(f"\n结果：{len(CHECKS) - len(bad)}/{len(CHECKS)} 通过")
if bad:
    print("未通过：", bad)
