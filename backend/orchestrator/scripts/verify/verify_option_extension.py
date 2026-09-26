"""验证「定价数据加档位 → 报价页自动多出这个选项」这条链真的通了。

要证明的三件事：
  ① 录一个新档位（丝径 3.0）后，规格空间接口里就多了这个取值；
  ② 报价页能直接用这个新档位算价，且**用的是刚录的成本**（改成本价就跟着变）；
  ③ 停用那行成本后，档位随之消失 —— 撤档位不需要再去动产品定义。

用法：python verify_option_extension.py
"""
import json
import os
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:8000/api/v1"
PRODUCT = "field_fence"
# 开发库的客户令牌从环境变量读 —— 绝不把凭据写进文件（会随提交永久留档）。
#   $env:KAAS_TOKEN='...'
TOKEN = os.environ.get("KAAS_TOKEN")
if not TOKEN:
    raise SystemExit("缺少环境变量 KAAS_TOKEN（开发库的客户令牌）")
def call(method: str, path: str, body: dict | None = None) -> dict:
    req = urllib.request.Request(BASE + path, method=method)
    req.add_header("Authorization", "Bearer " + TOKEN)
    req.add_header("X-Tenant-Id", "lianjia")
    req.add_header("Content-Type", "application/json")
    data = json.dumps(body).encode() if body is not None else None
    try:
        with urllib.request.urlopen(req, data, timeout=25) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        return {"__http_error__": e.code, "__body__": e.read().decode()[:300]}


def options(group_name: str) -> list[str]:
    """规格空间里某个维度的可选显示值。"""
    d = call("GET", f"/export-quote/products/{PRODUCT}/formulas")
    for g in [*d.get("space", {}).get("axes", []), *d.get("space", {}).get("variants", [])]:
        if g["name"] == group_name:
            return [o.get("label") or str(o.get("value")) for o in g["options"]]
    return []


def quote(de: float, coating: str) -> dict:
    body = {
        "product_key": PRODUCT,
        "rate_set_code": "CN-2026-09",
        "fx_rate": 6.7019,
        "orders": [{"total": 30000, "unit": "m"}],
        "quote_date": "2026-09-24",
        "spec_rows": [{
            "height_m": 1.2, "mesh_mm": 100, "de": de,
            "inner_wire": "内丝2.0", "coating": coating, "wave": "无波款",
        }],
        "policy": {
            "input_vat_rate": 0.10, "output_vat_rate": 0.0,
            "profit_mode": "fixed", "profit_value": 0.1,
            "give_ratio": 0.8, "refund_ratio": 1.0,
            "stamp_rate": 0.05, "stamp_base": "profit",
        },
    }
    r = call("POST", "/export-quote/calculate", body)
    if "customer" not in r:
        return {"error": r}
    view, header, rows = r["customer"], r["customer"]["header"], r["customer"]["rows"]
    if not rows:
        return {"error": "no rows"}
    idx = next((i for i, h in enumerate(header) if "单卷售价" in h), None)
    return {"price": rows[0][idx] if idx is not None else None}


def main() -> int:
    ok = True

    print("=== ① 现在的可选档位 ===")
    before_de = options("de")
    before_coating = options("coating")
    print(f"  边丝径：{before_de}")
    print(f"  镀锌量：{before_coating}")

    print("\n=== ② 在定价数据里新增档位「丝径 3.0」，成本 4.8 ===")
    r = call("POST", "/pricing-data", {
        "product_key": PRODUCT,
        "values": {"de": "3.0", "coating_code": "zinc_40"},
        "labels": {"de": "3.0"},
        "amount": 4.8,
        "unit": "kg",
    })
    if "id" not in r:
        print("  ✗ 新增失败:", r)
        return 1
    new_id = r["id"]
    print(f"  已保存 id={new_id} key={r['key']}")

    after_de = options("de")
    print(f"  边丝径现在：{after_de}")
    added = "3.0" in after_de
    print(f"  报价页多出 3.0 : {'✅' if added else '❌ 档位没联动过去'}")
    ok &= added

    print("\n=== ③ 用新档位算价：成本 4.8 vs 2.4（必须跟着变）===")
    p1 = quote(3.0, "普锌40g/㎡")
    print(f"  成本 4.8 → 单卷售价 {p1.get('price', p1)}")
    r3 = call("POST", "/pricing-data", {
        "product_key": PRODUCT,
        "values": {"de": "3.0", "coating_code": "zinc_40"},
        "labels": {"de": "3.0"},
        "amount": 2.4,
        "unit": "kg",
    })
    p2 = quote(3.0, "普锌40g/㎡")
    print(f"  成本 2.4 → 单卷售价 {p2.get('price', p2)}")
    used = p1.get("price") is not None and p1.get("price") != p2.get("price")
    print(f"  新档位的成本真的在用 : {'✅' if used else '❌ 用了兜底值，没读定价数据'}")
    ok &= used

    print("\n=== ④ 新增镀锌量档位「锌60」，成本 5.0 ===")
    r2 = call("POST", "/pricing-data", {
        "product_key": PRODUCT,
        "values": {"de": "2.0", "coating_code": "zinc_60"},
        "labels": {"coating_code": "镀锌60g/㎡"},
        "amount": 5.0,
        "unit": "kg",
    })
    if "id" not in r2:
        print("  ✗ 新增失败:", r2)
        return 1
    after_coating = options("coating")
    print(f"  镀锌量现在：{after_coating}")
    added_c = "镀锌60g/㎡" in after_coating
    print(f"  报价页多出「镀锌60g/㎡」 : {'✅' if added_c else '❌ 没联动过去'}")
    ok &= added_c

    print("\n=== ⑤ 定价矩阵里应能看到新增的两格 ===")
    m = call("GET", f"/pricing-data?product_key={PRODUCT}")
    labels = [" × ".join(r["labels"]) for r in m.get("rows", [])]
    print(f"  矩阵 {len(labels)} 行：" + "；".join(labels))
    in_matrix = any("3.0" in s for s in labels) and any("镀锌60g/㎡" in s for s in labels)
    print(f"  新增档位出现在矩阵里 : {'✅' if in_matrix else '❌'}")
    ok &= in_matrix

    print("\n=== ⑥ 停用本次新增的每一行 → 档位应随之消失 ===")
    for item in (new_id, r3.get("id"), r2["id"]):
        if item:
            call("DELETE", f"/pricing-data/{item}")
    back_de = options("de")
    back_coating = options("coating")
    print(f"  边丝径回到：{back_de}")
    print(f"  镀锌量回到：{back_coating}")
    restored = back_de == before_de and back_coating == before_coating
    print(f"  撤档位后恢复原样 : {'✅ 不用再去改产品定义' if restored else '❌ 有残留'}")
    ok &= restored

    print("\n" + ("全部通过 ✅" if ok else "存在失败项 ❌"))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
