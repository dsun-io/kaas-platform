"""验证「定价数据 → 报价」这条链真的通了。

要证明两件事：
  1. 现状（4 行都是 4.4/5.6，与产品定义兜底值一致）→ 报价与基线一致；
  2. **改一格成本 → 只有用到那一格的报价变，其他规格不变**。
     第 2 条是「接线通了」的唯一硬证据 —— 只看第 1 条无法区分
     「接上了但值恰好相同」和「根本没接上」。

用法：
    python verify_pricing_wiring.py
"""
import json
import os
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:8000/api/v1"
# 开发库的客户令牌从环境变量读 —— 绝不把凭据写进文件（会随提交永久留档）。
#   $env:KAAS_TOKEN='...'
TOKEN = os.environ.get("KAAS_TOKEN")
if not TOKEN:
    raise SystemExit("缺少环境变量 KAAS_TOKEN（开发库的客户令牌）")
PRODUCT = "field_fence"


def call(method: str, path: str, body: dict | None = None) -> dict:
    req = urllib.request.Request(BASE + path, method=method)
    req.add_header("Authorization", "Bearer " + TOKEN)
    req.add_header("X-Tenant-Id", "lianjia")
    req.add_header("Content-Type", "application/json")
    data = json.dumps(body).encode() if body is not None else None
    try:
        with urllib.request.urlopen(req, data) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        return {"__http_error__": e.code, "__body__": e.read().decode()[:400]}


def quote(de: float, zinc: str) -> dict:
    """算一个规格：给定边丝径与镀锌量，返回值表（客户视图第一行）。"""
    body = {
        "product_key": PRODUCT,
        "rate_set_code": "CN-2026-09",
        "fx_rate": 6.7019,
        "orders": [{"total": 30000, "unit": "m"}],
        "quote_date": "2026-09-24",
        "spec_rows": [{
            "height_m": 1.2,
            "mesh_mm": 100,
            "de": de,
            "inner_wire": "内丝2.0",
            "coating": "普锌40g/㎡" if zinc == "zinc_40" else "重镀锌≥200g/㎡",
            "wave": "无波款",
        }],
        "policy": {
            "input_vat_rate": 0.10,
            "output_vat_rate": 0.0,
            "profit_mode": "fixed",
            "profit_value": 0.1,
            "give_ratio": 0.8,
            "refund_ratio": 1.0,
            "stamp_rate": 0.05,
            "stamp_base": "profit",
        },
    }
    r = call("POST", "/export-quote/calculate", body)
    if "customer" not in r:
        return {"error": r}
    view = r["customer"]
    header = view.get("header") or []
    rows = view.get("rows") or []
    if not rows:
        return {"error": "no rows"}
    # 按列名找价格列（不写死列序号 —— 列会随产品/需求增减）
    idx = next((i for i, h in enumerate(header) if "单卷售价" in h), None)
    if idx is None:
        return {"error": f"列里找不到售价: {header}"}
    return {"price": rows[0][idx], "net_weight": rows[0][16]}


def price_of(row: dict):
    return row.get("price")


def main() -> int:
    print("=== ① 定价数据现状 ===")
    m = call("GET", f"/pricing-data?product_key={PRODUCT}")
    if "rows" not in m:
        print("  ✗ 取定价数据失败:", m)
        return 1
    for r in m["rows"]:
        print(f"  · {' × '.join(r['labels']):<28} {r['amount']} 元/{r['unit']}"
              f"  已配置={r['configured']} 来源={r['source']}")

    target = "de=2|coating_code=zinc_40"

    print("\n=== ② 把成本归位到 4.4，测出「4.4 应有的价」 ===")
    call("POST", "/pricing-data", {
        "product_key": PRODUCT,
        "values": {"de": 2.0, "coating_code": "zinc_40"},
        "amount": 4.4,
        "unit": "kg",
    })
    a0 = quote(2.0, "zinc_40")
    b0 = quote(2.5, "zinc_40")
    print(f"  边丝2.0·普锌  价格={price_of(a0)}   （成本 4.4）")
    print(f"  边丝2.5·普锌  价格={price_of(b0)}")
    if price_of(a0) is None:
        print("  ✗ 取值失败:", a0)
        return 1

    print("\n=== ③ 把「边丝2.0·普锌」的成本改成 8.8 ===")
    r = call("POST", "/pricing-data", {
        "product_key": PRODUCT,
        "values": {"de": 2.0, "coating_code": "zinc_40"},
        "amount": 8.8,
        "unit": "kg",
    })
    if "id" not in r:
        print("  ✗ 保存失败:", r)
        return 1
    print(f"  已保存 id={r['id']} key={r['key']}")

    a1 = quote(2.0, "zinc_40")
    b1 = quote(2.5, "zinc_40")
    print(f"  边丝2.0·普锌  价格={price_of(a1)}   ← 必须变（成本翻倍）")
    print(f"  边丝2.5·普锌  价格={price_of(b1)}   ← 必须不变（另一格）")

    changed = price_of(a1) != price_of(a0)
    isolated = price_of(b1) == price_of(b0)

    print(f"\n  保存后真的生效 : {'✅' if changed else '❌ 存进去了但报价没变 —— 查价键对不上'}")
    print(f"  只影响本格     : {'✅' if isolated else '❌ 改了别的格也被影响'}")

    print("\n=== ④ 恢复为 4.4，必须回到第②步的价 ===")
    r = call("POST", "/pricing-data", {
        "product_key": PRODUCT,
        "values": {"de": 2.0, "coating_code": "zinc_40"},
        "amount": 4.4,
        "unit": "kg",
    })
    a2 = quote(2.0, "zinc_40")
    restored = price_of(a2) == price_of(a0)
    print(f"  恢复后价格={price_of(a2)}  {'✅ 与 4.4 时的价一致' if restored else '❌ 与 4.4 时的价不一致'}")

    ok = changed and isolated and restored
    print("\n" + ("全部通过 ✅" if ok else "存在失败项 ❌"))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
