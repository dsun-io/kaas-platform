"""冻结出口报价基线。

为什么需要
----------
本轮改造要动「成本怎么取」（把写在产品定义里的单价，改成从定价数据取）。
要证明「业务逻辑没被改掉」，唯一的办法是拿改造前的输出当标尺，逐行比。
**差一分钱就停手。**

用法
----
    python baseline_freeze.py            # 写基线（改造前跑一次）
    python baseline_freeze.py --diff     # 与基线比对（改造后跑）

基线文件：scripts/verify/baseline_field_fence.json
"""
import json
import os
import sys
from pathlib import Path

# 从脚本自身位置推导仓库根：scripts/verify/xxx.py → backend/orchestrator。
# 不写死绝对路径 —— 写死了这个脚本就只能在某一台机器上跑。
ROOT = str(Path(__file__).resolve().parents[2])
sys.path.insert(0, ROOT)
os.chdir(ROOT)

from datetime import date  # noqa: E402
from decimal import Decimal as D  # noqa: E402

from app.services.export_quote import (  # noqa: E402
    QuoteRequest,
    RateSetRegistry,
    build,
)
from app.services.export_quote.pricing import policy_from_dict  # noqa: E402
from app.services.export_quote.products import field_fence  # noqa: E402

OUT = r"scripts/verify/baseline_field_fence.json"

# 行身份字段：牛栏网的业务规格轴/变体（能唯一插定一行的那几个）
KEY_FIELDS = ("height_m", "mesh_mm", "de", "inner_wire", "coating", "wave")

# 牛栏网基线政策（与 tests/test_export_quote_engine.py 的 policy() 逐字一致）
POLICY = {
    "input_vat_rate": 0.10,
    "output_vat": {"rate": 0.0, "mode": "additive"},
    "profit": {"mode": "fixed", "value": 0.1},
    "refund": {"refund_ratio": "auto", "give_ratio": 0.8},
    "stamp": {"rate": 0.05, "base": "profit"},
}


def build_result():
    req = QuoteRequest(
        product_key="field_fence",
        policy=policy_from_dict(POLICY),
        fx_rate=D("6.7019"),
        orders=field_fence.order_specs((30000, 50000)),
        rate_set=RateSetRegistry.from_dir().get("CN-2026-09"),
        quote_date=date(2026, 9, 24),
    )
    return build(req)


def flat(v):
    """把值统一成字符串。

    Decimal / float / int 混用时，逐行比对才不会被类型差异误报成「变了」。
    字典按键排序，保证两次运行的键序一致。
    """
    if isinstance(v, dict):
        return {k: flat(x) for k, x in sorted(v.items())}
    if isinstance(v, (list, tuple)):
        return [flat(x) for x in v]
    return str(v)


def dump_row(r):
    """把一行的全部字典型属性都 dump 出来（不写死属性名，避免漏字段）。"""
    out = {}
    for name in dir(r):
        if name.startswith("_"):
            continue
        try:
            v = getattr(r, name)
        except Exception:
            continue
        if isinstance(v, dict):
            out[name] = flat(v)
    return out


def snapshot():
    res = build_result()
    rows = [dump_row(r) for r in res.rows]
    return {
        "combo_count": len(rows),
        "diagnostics": [str(d) for d in getattr(res, "diagnostics", [])],
        "rows": rows,
    }


def row_key(row):
    """行身份：用**业务规格取值**做键，不依赖行顺序。

    刻意不用整个 spec 作用域：那里面混着政策参数（input_vat_rate、give_ratio…），
    政策或作用域变量一变，所有行都会“换身份”，逐行比对就退化成
    “全部新增 + 全部丢失”，反而看不出真实差异（已踩过）。
    """
    spec = row.get("spec") or {}
    return "|".join(f"{k}={spec.get(k)}" for k in KEY_FIELDS)


def main():
    snap = snapshot()
    print("combo_count =", snap["combo_count"])
    print("diagnostics =", len(snap["diagnostics"]))
    if snap["rows"]:
        print("spec keys   =", ", ".join(sorted(snap["rows"][0].get("spec") or {})))
        print("row attrs   =", ", ".join(sorted(snap["rows"][0])))

    if "--diff" not in sys.argv:
        os.makedirs(os.path.dirname(OUT), exist_ok=True)
        with open(OUT, "w", encoding="utf-8") as f:
            json.dump(snap, f, ensure_ascii=False, indent=1, sort_keys=True)
        print("baseline saved ->", OUT)
        return 0

    if not os.path.exists(OUT):
        print("!! 基线不存在，请先不带 --diff 跑一次", file=sys.stderr)
        return 2
    with open(OUT, encoding="utf-8") as f:
        base = json.load(f)

    old = {row_key(r): r for r in base["rows"]}
    new = {row_key(r): r for r in snap["rows"]}

    missing = sorted(set(old) - set(new))
    added = sorted(set(new) - set(old))
    changed = []
    for k in sorted(set(old) & set(new)):
        a, b = old[k], new[k]
        for attr in sorted(set(a) | set(b)):
            if a.get(attr) != b.get(attr):
                changed.append((k, attr))

    print("\n=== 与基线比对 ===")
    print("基线行数 =", len(old), " 当前行数 =", len(new))

    # 区分「业务字段」与「作用域字段」：
    #   spec 里混着政策参数（input_vat_rate、levy_rate…），它的增删不代表算价变了。
    #   真正要守住的是价格/派生/单件/订单/术语 —— 那些变了才是业务被改动。
    core_changed = [(k, a) for k, a in changed if a != "spec"]
    print("发生变化的属性组 =", ", ".join(sorted({a for _, a in changed})) or "（无）")
    if core_changed:
        print(f"⚠ 价格/派生/单件/订单/术语类字段有 {len(core_changed)} 处变化：")
        for k, a in core_changed[:20]:
            print("   ", k, "[", a, "]")
    else:
        print("✓ 价格/派生/单件/订单/术语类字段：零变化")

    if not missing and not added and not changed:
        print("结果：完全一致（逐行、逐字段）")
        return 0
    if not missing and not added and not core_changed:
        print("结果：仅 spec 作用域内的非业务字段有增删，金额类字段完全一致")
        return 0

    if missing:
        print(f"\n丢失的规格行 ({len(missing)}):")
        for k in missing[:20]:
            print("  -", k)
    if added:
        print(f"\n新增的规格行 ({len(added)}):")
        for k in added[:20]:
            print("  +", k)
    if changed:
        print(f"\n数值变化的字段 ({len(changed)}):")
        for k, attr in changed[:40]:
            a = (old[k].get(attr) or {})
            b = (new[k].get(attr) or {})
            diff_keys = [f for f in sorted(set(a) | set(b)) if a.get(f) != b.get(f)]
            print(f"  {k}  [{attr}]")
            for f in diff_keys[:6]:
                print(f"      {f}: {a.get(f)}  ->  {b.get(f)}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
