# -*- coding: utf-8 -*-
"""PI / SC / CI 三方一致性核对（只读，不改任何文件）。

范围严格限定在这三份；PI 是**冻结基线**（以旧版为准，绝不改写）。
四列同时过检：PI(xlsx) | PI(pdf) | SC(pdf) | CI(pdf)
  —— PI 两个来源都要满足 = 证明 PDF 也是旧版口径；
  —— SC/CI 只查 PDF（其 xlsx↔PDF 一致性由 verify_tim_post_pi.py 负责）。
"""
import datetime as dt
import re
from pathlib import Path

import openpyxl
import pymupdf

D = Path(r"D:\projects\报价制作")
TIM = D / "Tim"
ROOT_PI_XLSX = D / "Proforma Invoice - Buyer - 20260929.xlsx"
TIM_PI_XLSX = TIM / "Proforma Invoice - Buyer - 20260929.xlsx"
PI_PDF = TIM / "Proforma Invoice - Buyer - 20260929.pdf"
SC_PDF = TIM / "Sales Contract - Buyer - 20261012.pdf"
CI_PDF = TIM / "Commercial Invoice - Buyer - 20261012.pdf"


def norm(s):
    return re.sub(r"\s+", "", str(s)).lower()


def variants(v):
    out = {str(v)}
    for fmt in ("{:,.2f}", "{:,.3f}", "{:,.4f}", "{:.2f}", "{:.4f}"):
        try:
            out.add(fmt.format(float(v)))
        except (TypeError, ValueError):
            pass
    return out


def xlsx_text(path):
    ws = openpyxl.load_workbook(path).active
    parts = set()
    for row in ws.iter_rows():
        for c in row:
            if c.value is None:
                continue
            if isinstance(c.value, (int, float)) and not isinstance(c.value, bool):
                parts |= variants(c.value)
            else:
                parts.add(str(c.value))
    return norm("".join(parts))


def pdf_text(path):
    return norm("".join(pg.get_text() for pg in pymupdf.open(path)))


SRC = {
    "PIxlsx": xlsx_text(ROOT_PI_XLSX),
    "PIpdf": pdf_text(PI_PDF),
    "SCpdf": pdf_text(SC_PDF),
    "CIpdf": pdf_text(CI_PDF),
}

# ---------- 0. 文件时间戳 + PI 副本一致性 ----------
print("=" * 104)
print("文件状态（PI 为冻结基线，本次核对不改任何文件）")
print("=" * 104)
for tag, p in (("PI xlsx（根目录，基线）", ROOT_PI_XLSX), ("PI xlsx（Tim 副本）", TIM_PI_XLSX),
               ("PI pdf", PI_PDF), ("SC xlsx", TIM / "Sales Contract - Buyer - 20261012.xlsx"),
               ("SC pdf", SC_PDF), ("CI xlsx", TIM / "Commercial Invoice - Buyer - 20261012.xlsx"),
               ("CI pdf", CI_PDF)):
    print(f"  {tag:<22} {dt.datetime.fromtimestamp(p.stat().st_mtime):%Y-%m-%d %H:%M:%S}")
same = xlsx_text(ROOT_PI_XLSX) == xlsx_text(TIM_PI_XLSX)
print(f"  两份 PI xlsx 内容：{'一致' if same else '!! 不一致 —— 需人工确认以哪份为准'}")
pi_pdf_ok = all(k in SRC["PIpdf"] for k in SRC["PIxlsx"][:0] )  # 占位，下面用事实项判断
print(f"  PI pdf 是否为旧版口径：由下方 PIxlsx/PIpdf 两列同时通过来判定")

E = {"PI", "SC", "CI"}
# (类别, 项目, 检查串, 期望出现在哪些文件)
CHECKS = [
    ("编号", "PI 号", "lj-pi-20260929-01", E),
    ("编号", "报价单号", "lj-q-20260928-01", {"PI", "SC"}),
    ("编号", "合同号", "lj-sc-20261012-01", {"SC", "CI"}),
    ("编号", "发票号", "lj-ci-20261012-01", {"SC", "CI"}),
    ("日期", "PI 日期 2026-09-29", "september29,2026", E),
    ("日期", "发票/合同日期 2026-10-12", "october12,2026", {"SC", "CI"}),
    ("金额", "货物总值 CNY 18,195.66", "18,195.66", E),
    ("金额", "货物总值 USD 2,714.60", "2,714.60", E),
    ("金额", "内陆运费 CNY 750.00", "750.00", E),
    ("金额", "内陆运费 USD 111.89", "111.89", E),
    ("金额", "总金额 CNY 18,945.66", "18,945.66", E),
    ("金额", "总金额 USD 2,826.49", "2,826.49", E),
    ("金额", "定金 CNY 5,683.70", "5,683.70", E),
    ("金额", "定金 USD 847.95", "847.95", E),
    ("金额", "尾款 CNY 13,261.96", "13,261.96", E),
    ("金额", "尾款 USD 1,978.54", "1,978.54", E),
    ("金额", "舍入调整 CNY -2.54", "-2.54", E),
    ("金额", "大写金额", "twothousandeighthundred", {"SC", "CI"}),
    ("汇率", "汇率 6.7029", "6.7029", E),
    ("汇率", "汇价日期 2026-09-28", "2026-09-28", E),
    ("单价", "立柱 400pc ×CNY25.00 ×USD3.7297", "3.7297", E),
    ("单价", "立柱金额 CNY 10,000.00", "10,000.00", E),
    ("单价", "牛栏网 20roll ×CNY366.31 ×USD54.6495", "54.6495", E),
    ("单价", "牛栏网金额 CNY 7,326.20", "7,326.20", E),
    ("单价", "绝缘子 400pc ×CNY2.18 ×USD0.3252", "0.3252", E),
    ("单价", "绝缘子金额 CNY 872.00", "872.00", E),
    ("付款", "30% 定金", "30%deposit", E),
    ("付款", "70% 尾款", "70%balance", E),
    ("付款", "尾款时点 before delivery", "beforedelivery", E),
    ("付款", "定金已付（SC 措辞）", "alreadypaidbythebuyer", {"SC"}),
    ("付款", "定金已付（CI 措辞 Paid by Buyer）", "paidbybuyer", {"CI"}),
    ("交货", "DAP Yangzhou, Jiangsu, China", "dapyangzhou,jiangsu,china", E),
    ("交货", "Incoterms 2020 版本", "incoterms2020", {"SC", "CI"}),
    ("交货", "交货地址 No.1 Guangling Road", "no.1guanglingroad", E),
    ("交货", "运输时效 4–5 days", "4–5daysafterdispatch", {"PI", "SC"}),
    ("主体", "买方 John Doe", "timlyons", E),
    ("主体", "买方邮箱", "buyer@example.com", E),
    ("主体", "收货/拼柜方 Jiangsu Juncheng", "jiangsu juncheng vehicle industry co., ltd.", E),
    ("主体", "卖方税号", "91131125ma0ga4242u", E),
    ("主体", "卖方中文名/地址", "anpingcounty", E),
    ("货物", "原产国 China", "china", E),
    ("货物", "唛头 N/M", "n/m", {"SC", "CI"}),
    ("货物", "立柱 400 pcs per pallet", "400pcsperpallet", {"PI", "SC"}),
    ("货物", "总重 2,435 kg", "2,435kg", {"PI", "SC"}),
    ("货物", "总体积 7.35 CBM", "7.35cbm", {"PI", "SC"}),
    ("单据", "ChAFTA 原产地证", "chafta", {"PI", "SC"}),
    ("单据", "CO 费用卖方承担", "bornebytheseller", {"PI", "SC"}),
    ("单据", "报关单证：报关单", "customsdeclarationform", {"PI", "SC"}),
    ("单据", "报关单证：装箱单", "packinglist", {"PI", "SC"}),
    ("单据", "报关单证：运输单据副本", "transportdocuments", {"PI", "SC"}),
    ("单据", "SC 兜底：及其他所需单证", "suchotherdocumentsasmayberequired", {"SC"}),
    ("税费", "零税率 0% VAT", "0%vat", E),
    ("税费", "出口退税", "exporttaxrebate", {"PI", "SC"}),
    ("其他", "单价 2 位舍入口径", "roundedto2decimalplaces", {"PI", "SC"}),
]

print()
print("=" * 104)
print("事实矩阵：PIxlsx | PIpdf | SCpdf | CIpdf")
print("=" * 104)
print(f"{'类别':<6}{'项目':<40}{'PIx':<6}{'PIp':<6}{'SCp':<6}{'CIp':<6} 备注")
print("-" * 104)
issues = []
for cat, name, needle, expect in CHECKS:
    n = norm(needle)
    got = {
        "PIx": n in SRC["PIxlsx"],
        "PIp": n in SRC["PIpdf"],
        "SCp": n in SRC["SCpdf"],
        "CIp": n in SRC["CIpdf"],
    }
    row = "".join(("OK    " if got[k] else "--    ") for k in ("PIx", "PIp", "SCp", "CIp"))
    flag = ""
    want = {"PI": ("PIx", "PIp"), "SC": ("SCp",), "CI": ("CIp",)}
    for k in ("PI", "SC", "CI"):
        if k in expect and not all(got[x] for x in want[k]):
            flag = f"  <== {k} 缺失"
            issues.append((cat, name, f"{k} 缺失"))
    print(f"{cat:<6}{name:<40}{row}{flag}")

print("-" * 104)
print(f"事实项 {len(CHECKS)} 条；异常 {len(issues)} 处")
for cat, name, msg in issues:
    print(f"   · [{cat}] {name}：{msg}")

# ---------- 关键条款原句对照（用 PDF 原文） ----------
pi_raw = re.sub(r"\s+", " ", "".join(pg.get_text() for pg in pymupdf.open(PI_PDF)))
sc_raw = re.sub(r"\s+", " ", "".join(pg.get_text() for pg in pymupdf.open(SC_PDF)))
ci_raw = re.sub(r"\s+", " ", "".join(pg.get_text() for pg in pymupdf.open(CI_PDF)))

for title, pats in (
        ("1) 付款条件", {"PI": r"30% deposit upon.{0,150}",
                     "SC": r"T/T — 30% deposit upon.{0,220}",
                     "CI": r"Payment Terms.{0,130}"}),
        ("2) 交货 / 贸易术语", {"PI": r"DAP Yangzhou.{0,60}",
                          "SC": r"Delivery term.{0,140}",
                          "CI": r"Incoterms.{0,60}"}),
        ("3) 报关单证", {"PI": r"The buyer shall arrange for.{0,240}",
                    "SC": r"The buyer shall assist the seller.{0,250}",
                    "CI": "NONE"})):
    print("\n" + "=" * 104)
    print(title)
    print("=" * 104)
    for tag, txt in (("PI", pi_raw), ("SC", sc_raw), ("CI", ci_raw)):
        pat = pats[tag]
        if pat == "NONE":
            print(f"[{tag}] —（不涉及）")
            continue
        m = re.search(pat, txt, re.S)
        print(f"[{tag}] {' '.join(m.group(0).split()) if m else '（未匹配，请人工查看）'}")
