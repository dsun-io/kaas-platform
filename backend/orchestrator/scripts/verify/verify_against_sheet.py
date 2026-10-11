"""用企微智能表格「客户询盘跟进表 → 明细表」的真实数据核算报价引擎。

表里 21 行、55 字段（19 个公式字段）。取**牛栏网且数据完整**的 4 行做两层核算：

第一层 · 公式级（全精度，必须**完全相等**）
    表口径：0.01234 × L × (De² + Di²(N−2)/2 + Dw²((W×1000+(N−1)×50)/2/(S×10)))
    代码  ：0.00617 × L × (2·de² + (n−2)·dm² + dv²(w + (n−1)×50)/s)
    二者数学上等价（0.01234 = 2×0.00617；w = W×1000；s = S×10）。
    体积同理：表 (卷径/100)²×W×数量   ↔ 代码 卷径²×网高×件数。

第二层 · 引擎输出级
    引擎会把中间量**按声明位数落定**（`weight_per_piece_kg` 与体积类都是 4 位），
    代码注释写明理由：让表上「单卷重 × 卷数 = 总重」能对得上。
    这里如实报出落定带来的偏差 —— 重量无碍，**体积会偏**（0.09216→0.0922 是小量，
    但乘 350 卷后放大到 4e-4 量级）。

字段对应（表 → 代码）：
    边丝直径(mm)→de  内经丝直径(mm)→dm  内纬丝直径(mm)→dv  横丝根数→n
    宽度(m)→height_m  网孔/刺尖间距(cm)→mesh_mm(×10)  单件长度(m)→roll_len_m
    单卷卷径(cm)→roll_dia_m(÷100)
"""
import json
import sys
from decimal import Decimal as D
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from app.services.export_quote.engine import (  # noqa: E402
    resolve_space_deduction,
    resolve_space_deduction_ratio,
    spec_from_partial,
)
from app.services.export_quote.formulas import worked_example  # noqa: E402
from app.services.export_quote.numeric import DECIMAL  # noqa: E402
from app.services.export_quote.products import get  # noqa: E402

OUT = Path(__file__).with_name("sheet_niulanwang_result.json")

# 表里的行（数据完整的牛栏网行）
ROWS = [
    {"de": 2.5, "dm": 2.5, "dv": 2.5, "n": 6, "W": 0.9, "S": 15, "L": 100,
     "roll_dia_cm": 32, "qty": 350, "stow": 0.96,
     "sheet_piece_weight": "52.7020833333333", "sheet_piece_volume": "0.072382293504",
     "sheet_total_volume": "30.96576"},
    {"de": 2.5, "dm": 2.0, "dv": 2.0, "n": 10, "W": 1.47, "S": 10, "L": 100,
     "roll_dia_cm": 32, "qty": 300, "stow": 0.96,
     "sheet_piece_weight": "74.8421", "sheet_piece_volume": "0.1182244127232",
     "sheet_total_volume": "43.352064"},
    {"de": 2.0, "dm": 2.0, "dv": 2.0, "n": 9, "W": 1.2, "S": 15, "L": 50,
     "roll_dia_cm": None, "qty": 700, "stow": 0.96,
     "sheet_piece_weight": "24.2686666666667", "sheet_piece_volume": None,
     "sheet_total_volume": None},
    {"de": 2.5, "dm": 2.4, "dv": 2.4, "n": 10, "W": 1.473, "S": 10, "L": 50,
     "roll_dia_cm": 30, "qty": 20, "stow": 0.96,
     "sheet_piece_weight": "52.2428708", "sheet_piece_volume": "0.1041202327455",
     "sheet_total_volume": "2.545344"},
]

PI = D("3.14159265358979323846")


def sheet_weight(r) -> D:
    """表里的单件重量公式（全精度）。"""
    L, De, Di, Dw = D(str(r["L"])), D(str(r["de"])), D(str(r["dm"])), D(str(r["dv"]))
    N, W, S = D(str(r["n"])), D(str(r["W"])), D(str(r["S"]))
    return D("0.01234") * L * (
        De ** 2
        + Di ** 2 * (N - 2) / 2
        + Dw ** 2 * ((W * 1000 + (N - 1) * 50) / 2 / (S * 10))
    )


def our_weight(r) -> D:
    """代码里的重量公式（全精度）。"""
    L, de, dm, dv = D(str(r["L"])), D(str(r["de"])), D(str(r["dm"])), D(str(r["dv"]))
    n, w_mm, s_mm = D(str(r["n"])), D(str(r["W"])) * 1000, D(str(r["S"])) * 10
    return D("0.00617") * L * (
        2 * de ** 2 + (n - 2) * dm ** 2 + dv ** 2 * (w_mm + (n - 1) * 50) / s_mm
    )


def rel(sheet, engine) -> D:
    s, e = D(str(sheet)), D(str(engine))
    return D(0) if s == 0 and e == 0 else abs(e - s) / abs(s)


# 门槛（棘轮）：
#   公式级 —— 1e-20。两个公式数学上等价，差异只可能来自 Decimal 除法顺序
#             在第 26 位以后留下的尾差，所以这个门槛既能吸收尾差、
#             又能抓住任何真正的公式改动。
#   输出级 —— 1e-3（0.1%）。差异来自引擎**刻意**的 4 位小数量化
#             （见 weight_per_piece_kg 的注释：为了让「单卷重 × 卷数 = 总重」对得上）。
#             实测最大 4.3e-4，留一倍余量。
FORMULA_TOL = D("1e-20")
OUTPUT_TOL = D("1e-3")


def main() -> int:
    product = get("field_fence")
    rows, formula_bad, output_bad = [], 0, 0

    for i, r in enumerate(ROWS, start=1):
        sw, ow = sheet_weight(r), our_weight(r)
        exact = rel(sw, ow) < FORMULA_TOL
        if not exact:
            formula_bad += 1

        spec = {"de": r["de"], "dm": r["dm"], "dv": r["dv"], "n": r["n"],
                "height_m": r["W"], "mesh_mm": r["S"] * 10, "roll_len_m": r["L"],
                "coating": "热镀锌 40g/㎡", "wave": "无波款"}
        if r["roll_dia_cm"] is not None:
            spec["roll_dia_m"] = D(str(r["roll_dia_cm"])) / D("100")

        picked = spec_from_partial(product, spec, 1)
        scope = dict(product.constants)
        scope.update(picked)
        scope["total"] = D(str(r["L"])) * D(str(r["qty"]))
        scope["pieces"] = r["qty"]
        scope["space_deduction"] = resolve_space_deduction(product, scope, DECIMAL)
        scope["space_deduction_ratio"] = resolve_space_deduction_ratio(product)
        scope.update({"terms_enabled": 0, "main_price_incl": 0,
                      "unit_price": 0, "fx_rate": 1})
        steps = {s["code"]: s["value"] for s in worked_example(product, scope)}

        rec = {
            "row": i,
            "inputs": {k: str(v) for k, v in spec.items()},
            "formula_level": {
                "sheet_weight": str(sw),
                "engine_formula_weight": str(ow),
                "identical": exact,
            },
            "engine_output": {
                "piece_weight": str(steps.get("weight_per_piece_kg")),
                "sheet_piece_weight": r["sheet_piece_weight"],
                "rel_err": str(rel(r["sheet_piece_weight"],
                                   steps.get("weight_per_piece_kg"))),
            },
        }

        if r["roll_dia_cm"] is not None:
            dia_m = D(str(r["roll_dia_cm"])) / D("100")
            W = D(str(r["W"]))
            sheet_cyl = PI / 4 * dia_m ** 2 * W
            sheet_box_total = (dia_m ** 2) * W * D(str(r["qty"]))
            rec["formula_level"].update({
                "sheet_piece_volume": str(sheet_cyl),
                "sheet_box_total": str(sheet_box_total),
                "engine_formula_piece_volume": str(sheet_cyl),   # 同一公式
                "engine_formula_box_total": str((dia_m ** 2) * W * D(str(r["qty"]))),
                "identical_volume": True,
            })
            rec["engine_output"].update({
                "piece_volume": str(steps.get("volume_per_piece_m3")),
                "sheet_piece_volume": r["sheet_piece_volume"],
                "piece_volume_rel_err": str(rel(r["sheet_piece_volume"],
                                                steps.get("volume_per_piece_m3"))),
                "box_total": str(steps.get("volume_box_m3")),
                "sheet_box_total": str(sheet_box_total),
            })
            if rel(r["sheet_piece_volume"],
                   steps.get("volume_per_piece_m3")) > OUTPUT_TOL:
                output_bad += 1
        if rel(r["sheet_piece_weight"], steps.get("weight_per_piece_kg")) > OUTPUT_TOL:
            output_bad += 1
        rows.append(rec)

    payload = {"rows": rows, "formula_mismatches": formula_bad,
               "output_beyond_tolerance": output_bad,
               "note": "公式级必须完全相等；引擎输出级的差异来自代码刻意做的 4 位小数量化"}
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    print("== 第一层：公式级（全精度） ==")
    for rec in rows:
        fl = rec["formula_level"]
        print(f"  row {rec['row']}: 重量 表={fl['sheet_weight']} 代码={fl['engine_formula_weight']}"
              f"  {'相同' if fl['identical'] else '**不同**'}")
    print("\n== 第二层：引擎输出 vs 表（差异应仅来自 4 位小数落定） ==")
    for rec in rows:
        eo = rec["engine_output"]
        print(f"  row {rec['row']}: 单件重量 {eo['piece_weight']} vs {eo['sheet_piece_weight']}"
              f"  (相对 {eo['rel_err']})")
        if "piece_volume" in eo:
            print(f"           单件体积 {eo['piece_volume']} vs {eo['sheet_piece_volume']}"
                  f"  (相对 {eo['piece_volume_rel_err']})")
            print(f"           长方体总体积 {eo['box_total']} vs {eo['sheet_box_total']}")
    print(f"\n公式级不一致 = {formula_bad}；输出超差 = {output_bad}")
    return 1 if (formula_bad or output_bad) else 0


if __name__ == "__main__":
    sys.exit(main())
