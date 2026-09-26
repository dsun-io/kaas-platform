"""拿「美国 Elhadji Gueye-工厂内部报价表」这份原始参考数据，逐行逐列对当前报价引擎。

为什么要有这个脚本
------------------
这份表是**需求的原点**：牛栏网的规格、成本、税与让利口径全部出自它。
后面所有改造（退税分母、成本项结构、表面处理、数量区…）都必须证明
「引擎算出来的每一列仍与它对得上」。所以它是最有说服力的验收标尺。

用法
----
    python compare_csv.py            # 逐行逐列比对，只打印不一致
    python compare_csv.py -v         # 连一致的行也打印
"""
import csv
import json
import os
import sys
from decimal import Decimal as D
from pathlib import Path

# 从脚本自身位置推导仓库根：scripts/verify/xxx.py → backend/orchestrator。
# 不写死绝对路径 —— 写死了这个脚本就只能在某一台机器上跑。
ROOT = str(Path(__file__).resolve().parents[2])
sys.path.insert(0, ROOT)
os.chdir(ROOT)

from datetime import date  # noqa: E402

from app.services.export_quote import (  # noqa: E402
    QuoteRequest,
    RateSetRegistry,
    build,
)
from app.services.export_quote.pricing import policy_from_dict  # noqa: E402
from app.services.export_quote.products import field_fence  # noqa: E402

# 参考表是**业务原始数据，不入仓库** —— 所以路径由环境变量给，默认指向桌面那一份。
CSV_PATH = os.environ.get(
    "KAAS_REFERENCE_CSV",
    r"c:/Users/76516/Desktop/美国 Elhadji Gueye-工厂内部报价表.csv",
)
if not os.path.exists(CSV_PATH):
    raise SystemExit(
        f"找不到参考表：{CSV_PATH}\n"
        f"用环境变量 KAAS_REFERENCE_CSV 指到那份「工厂内部报价表.csv」再跑。"
    )

# 与这张表完全对应的报价政策：只有 3 个税相关旋钮（进项票税点/印花税率/让利比例），
# 出口零税率，退税率未核实 → 可退税比例取满（= 表里的「退税税额 = 进项税额」）。
POLICY = {
    "input_vat_rate": 0.10,
    "output_vat": {"rate": 0.0, "mode": "additive"},
    "profit": {"mode": "fixed", "value": 0.1},
    "refund": {"refund_ratio": "auto", "give_ratio": 0.8},
    "stamp": {"rate": 0.05, "base": "profit"},
}

# 表里的「丝径方案」一个格子，在引擎里拆成两个维度（边丝径 + 内丝径）
WIRE = {
    "全丝2.0": ("2.0", "内丝2.0"),
    "全丝2.5": ("2.5", "内丝2.5"),
    "边丝2.5+内丝2.0": ("2.5", "内丝2.0"),
}

# CSV 列名 -> 引擎输出的取值路径。逐列对照，不抽样。
COLUMNS = [
    ("卷长(m/卷)", ("spec", "roll_len_m"), "卷长"),
    ("卷径(cm)", ("derived", "roll_dia_cm"), "卷径"),
    ("单卷边丝重(kg)", ("derived", "edge_weight_kg"), "单卷边丝重"),
    ("单卷净重(kg)", ("derived", "weight_per_piece_kg"), "单卷净重"),
    ("3万米卷数", ("orders", "o30000", "pieces"), "3万米卷数"),
    ("5万米卷数", ("orders", "o50000", "pieces"), "5万米卷数"),
    ("3万米总净重(kg)", ("orders", "o30000", "total_net_weight_kg"), "3万米总净重"),
    ("5万米总净重(kg)", ("orders", "o50000", "total_net_weight_kg"), "5万米总净重"),
    ("单卷净体积(m³)", ("derived", "volume_box_per_piece_m3"), "单卷净体积"),
    ("3万米长方体总体积(m³)", ("orders", "o30000", "volume_box_m3"), "3万米总体积"),
    ("3万米实际占用体积(m³)", ("orders", "o30000", "volume_effective_m3"), "3万米实际占用"),
    ("5万米长方体总体积(m³)", ("orders", "o50000", "volume_box_m3"), "5万米总体积"),
    ("5万米实际占用体积(m³)", ("orders", "o50000", "volume_effective_m3"), "5万米实际占用"),
    ("税前成本(元/kg)", ("price", "cost_pretax"), "税前成本"),
    ("含税采购价(元/kg)", ("price", "cost_incl"), "含税采购价"),
    ("工厂加价利润(元/kg)", ("price", "profit_amount"), "加工利润"),
    ("税前报价(元/kg)", ("price", "pretax_quote"), "税前报价"),
    ("基础报价(元/kg)", ("price", "base_quote"), "基础报价"),
    ("退税税额(元/kg)", ("price", "refundable_input_vat"), "退税税额"),
    ("让利80%(元/kg)", ("price", "give_amount"), "让利额"),
    ("印花税(元/kg)", ("price", "stamp_duty"), "印花税"),
    ("报价(元/kg)", ("price", "quote"), "报价"),
    ("单卷售价(元/卷)", ("piece", "price_per_piece"), "单卷售价"),
    ("单价(元/米)", ("piece", "price_per_meter"), "单价"),
    ("3万米总售价(元)", ("orders", "o30000", "total_price"), "3万米总价"),
    ("5万米总售价(元)", ("orders", "o50000", "total_price"), "5万米总价"),
    ("单卷美元售价(USD/卷)", ("piece", "price_per_piece_fx"), "单卷美元价"),
    ("3万米总美元售价(USD)", ("orders", "o30000", "total_price_fx"), "3万米总美元"),
    ("5万米总美元售价(USD)", ("orders", "o50000", "total_price_fx"), "5万米总美元"),
]


def dump_row(r):
    """与 baseline_freeze.py 同样的取数方式：不写死属性名，避免漏字段。"""
    out = {}
    for name in dir(r):
        if name.startswith("_"):
            continue
        try:
            v = getattr(r, name)
        except Exception:
            continue
        if isinstance(v, dict):
            out[name] = v
    return out


def dig(row, path):
    cur = row
    for p in path:
        if not isinstance(cur, dict) or p not in cur:
            return None
        cur = cur[p]
    return cur


def num(s):
    if s is None:
        return None
    s = str(s).strip().replace(",", "")
    if s == "":
        return None
    try:
        return D(s)
    except Exception:
        return None


def squash(s):
    """把单元格归一成纯文本，去掉所有空白。

    两个坑：
    1. 引擎 spec 里的取值在内存中是 Decimal，直接与 CSV 的文本比会永远不等；
       所以两边都先转成字符串再比。
    2. 原始表部分「工艺」单元格夹了空格（如「无 波款」），同一列两种写法。
       按去掉空白后的文本做身份，才不会把它误当成另一个规格。
    """
    import re

    return re.sub(r"\s+", "", str(s if s is not None else ""))


def key_of(spec):
    return tuple(
        squash(spec.get(f))
        for f in ("height_m", "mesh_mm", "de", "inner_wire", "coating", "wave")
    )


def load_csv():
    with open(CSV_PATH, encoding="utf-8-sig", newline="") as f:
        rows = list(csv.reader(f))
    # 定位明细表头（以「序号」开头的那一行）
    hi = next(i for i, r in enumerate(rows) if r and r[0].strip() == "序号")
    header = [c.strip() for c in rows[hi]]
    out = []
    for r in rows[hi + 1:]:
        if not r or not r[0].strip():
            continue
        if not r[0].strip().isdigit():
            continue
        out.append(dict(zip(header, r)))
    return out


def main():
    verbose = "-v" in sys.argv

    req = QuoteRequest(
        product_key="field_fence",
        policy=policy_from_dict(POLICY),
        fx_rate=D("6.7019"),
        orders=field_fence.order_specs((30000, 50000)),
        rate_set=RateSetRegistry.from_dir().get("CN-2026-09"),
        quote_date=date(2026, 9, 24),
    )
    res = build(req)
    engine = {key_of(dump_row(r)["spec"]): dump_row(r) for r in res.rows}

    csv_rows = load_csv()
    print(f"参考表行数 = {len(csv_rows)}   引擎组合数 = {len(engine)}")
    print(f"逐列对照列数 = {len(COLUMNS)}   每行应比 = {len(COLUMNS)} 格\n")

    checked = 0
    mismatch = []
    unresolved = []

    for cr in csv_rows:
        wire = WIRE.get((cr.get("丝径方案") or "").strip())
        if wire is None:
            unresolved.append((cr.get("序号"), "丝径方案", cr.get("丝径方案")))
            continue
        mesh_cm = num(cr.get("竖丝间距(cm)"))
        k = (
            squash(num(cr.get("网高(m)"))),
            squash((mesh_cm or 0) * 10),
            squash(wire[0]),
            squash(wire[1]),
            squash(cr.get("镀锌量")),
            squash(cr.get("工艺")),
        )
        row = engine.get(k)
        if row is None:
            unresolved.append((cr.get("序号"), "组合", k))
            continue

        bad = []
        for col, path, label in COLUMNS:
            want = num(cr.get(col))
            got = num(dig(row, path))
            checked += 1
            if want is None:
                continue
            if got is None or want != got:
                bad.append((label, want, got))

        if bad:
            mismatch.append((cr.get("序号"), k, bad))
            print(f"[序号 {cr.get('序号')}] 差异 {len(bad)} 处  {k}")
            for label, want, got in bad:
                print(f"      {label}: 参考表 {want}  ≠  引擎 {got}")
        elif verbose:
            print(f"[序号 {cr.get('序号')}] 一致（{len(COLUMNS)} 列）")

    print("\n" + "=" * 68)
    print(f"比对格子数     = {checked}")
    print(f"不一致行数     = {len(mismatch)}")
    print(f"引擎里找不到的行 = {len(unresolved)}")
    for item in unresolved:
        print("   未匹配:", item)

    if not mismatch and not unresolved:
        print("结论：参考表的每一行、每一列，引擎都逐格一致 ✅")
        return 0
    print("结论：存在差异，需逐项查清 ⚠")
    return 1


if __name__ == "__main__":
    sys.exit(main())
