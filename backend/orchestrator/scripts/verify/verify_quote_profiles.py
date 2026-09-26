"""验证「客户税率档案」的完整生命周期。

为什么这些检查值得写
--------------------
档案的价值全在「存进去什么、取出来还是什么」。它**不会报错**的失败方式有三种：
  1. 键名存错（如 input_vat_rates）→ 存进去、读不出来，界面显示「保存成功」；
  2. 数值被静默改写（0.1 → 10）→ 报价差一个数量级，金额看着完全正常；
  3. 取回顺序不对 → 「默认选最新」选到最老的一份，用户按着过期的税率报价。
三种都是「静默降级」，日志里一条错都没有。所以这里逐项对着返回值验。

用法：cd backend/orchestrator && .venv\\Scripts\\python.exe scripts\\verify\\verify_quote_profiles.py
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
PASSED: list[str] = []
FAILED: list[str] = []


def call(method: str, path: str, body: dict | None = None):
    req = urllib.request.Request(BASE + path, method=method)
    req.add_header("Authorization", "Bearer " + TOKEN)
    req.add_header("X-Tenant-Id", "lianjia")
    req.add_header("Content-Type", "application/json")
    data = json.dumps(body).encode() if body is not None else None
    try:
        with urllib.request.urlopen(req, data) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw)
        except ValueError:
            return e.code, {"raw": raw[:200]}


def check(label: str, cond: bool, detail: str = "") -> None:
    (PASSED if cond else FAILED).append(label)
    print(f"  {'✅' if cond else '✗ '} {label}" + (f"   [{detail}]" if detail and not cond else ""))


def main() -> None:
    print("=== ① 起点：本客户暂无任何档案 ===")
    st, listing = call("GET", f"/quote-profiles?product_key={PRODUCT}")
    check("列表可读", st == 200, str(listing)[:200])
    before = {p["id"] for p in listing.get("profiles", [])}
    print(f"  现有档案 {len(before)} 份")

    print("\n=== ② 保存一份档案（自定义名称）===")
    st, created = call("POST", "/quote-profiles", {
        "product_key": PRODUCT,
        "profile_name": "美国线-普票10个点",
        "rate_set_code": "CN-2026-09",
        "tax_overrides": {
            "input_vat_rate": 0.10,
            "output_vat_rate": 0.0,
            "rebate_rate": 0.13,
            "stamp_rate": 0.05,
        },
    })
    check("新建返回 201", st == 201, str(created)[:300])
    pid = created.get("id")
    print(f"  id={pid} name={created.get('profile_name')} rate_set={created.get('rate_set_code')}")

    print("\n=== ③ 存进去什么、取出还是什么（档案的全部价值）===")
    check("进项票税点原样", created.get("tax_overrides", {}).get("input_vat_rate") == 0.10,
          str(created.get("tax_overrides")))
    check("出口退税率原样", created.get("tax_overrides", {}).get("rebate_rate") == 0.13,
          str(created.get("tax_overrides")))
    check("销项税率原样（0 也要保留）", created.get("tax_overrides", {}).get("output_vat_rate") == 0.0,
          str(created.get("tax_overrides")))
    check("没填的项不出现在档案里（不塞 null）",
          "stamp_base" not in created.get("tax_overrides", {}),
          str(created.get("tax_overrides")))
    check("法定档案编号被记住", created.get("rate_set_code") == "CN-2026-09")
    check("产品名可读", bool(created.get("product_name")), str(created.get("product_name")))

    print("\n=== ④ 列表：新档案排在最前（界面「默认选最新」靠它）===")
    st, listing = call("GET", f"/quote-profiles?product_key={PRODUCT}")
    rows = listing.get("profiles", [])
    check("新档案出现在列表里", any(p["id"] == pid for p in rows))
    check("新的排在最前面（created_at 倒序）", bool(rows) and rows[0]["id"] == pid,
          f"首条 id={rows[0]['id'] if rows else None}")

    print("\n=== ⑤ 键名打错必须报错，不能静默存下 ===")
    st, resp = call("POST", "/quote-profiles", {
        "product_key": PRODUCT,
        "profile_name": "错键测试",
        "rate_set_code": "CN-2026-09",
        "tax_overrides": {"input_vat_rates": 0.1},
    })
    check("未知税率项被拦下（422）", st == 422, f"st={st} {str(resp)[:160]}")

    print("\n=== ⑥ 按百分数填税率（10 而非 0.1）必须报错 ===")
    st, resp = call("POST", "/quote-profiles", {
        "product_key": PRODUCT,
        "profile_name": "百分数测试",
        "rate_set_code": "CN-2026-09",
        "tax_overrides": {"input_vat_rate": 10},
    })
    check("超出 0~1 被拦下（422）", st == 422, f"st={st} {str(resp)[:160]}")

    print("\n=== ⑦ 重名必须拦下（否则下拉里两份一模一样）===")
    st, resp = call("POST", "/quote-profiles", {
        "product_key": PRODUCT,
        "profile_name": "美国线-普票10个点",
        "rate_set_code": "CN-2026-09",
        "tax_overrides": {"input_vat_rate": 0.13},
    })
    check("同名被拦下（409）", st == 409, f"st={st} {str(resp)[:160]}")

    print("\n=== ⑧ 空档案必须拦下（套用后什么都不会变）===")
    st, resp = call("POST", "/quote-profiles", {
        "product_key": PRODUCT,
        "profile_name": "空档案",
        "rate_set_code": "CN-2026-09",
        "tax_overrides": {},
    })
    check("没有任何税率项时（422）", st == 422, f"st={st} {str(resp)[:160]}")

    print("\n=== ⑨ 改名 ===")
    st, renamed = call("PATCH", f"/quote-profiles/{pid}", {"profile_name": "美国线-普票10个点(已改名)"})
    check("改名成功", st == 200 and renamed.get("profile_name", "").endswith("(已改名)"),
          f"st={st} {str(renamed)[:200]}")
    check("改名不改内容", renamed.get("tax_overrides", {}).get("rebate_rate") == 0.13)

    print("\n=== ⑩ 跨客户不可见 / 管理员看全部需要权限 ===")
    st, resp = call("GET", f"/quote-profiles?product_key={PRODUCT}&scope=all")
    check("非管理员取 scope=all 被拒（403）", st == 403, f"st={st} {str(resp)[:160]}")

    print("\n=== ⑪ 停用后从下拉里消失 ===")
    st, resp = call("DELETE", f"/quote-profiles/{pid}")
    check("停用成功", st == 200, f"st={st} {str(resp)[:160]}")
    st, listing = call("GET", f"/quote-profiles?product_key={PRODUCT}")
    check("停用后不再出现在列表里",
          not any(p["id"] == pid for p in listing.get("profiles", [])))

    print("\n=== ⑫ 清理本次产生的测试档案 ===")
    st, listing = call("GET", f"/quote-profiles?product_key={PRODUCT}")
    leftovers = [p for p in listing.get("profiles", []) if p["id"] not in before]
    for p in leftovers:
        call("DELETE", f"/quote-profiles/{p['id']}")
    st, listing = call("GET", f"/quote-profiles?product_key={PRODUCT}")
    now_ids = {p["id"] for p in listing.get("profiles", [])}
    check("恢复到起点", now_ids == before, f"残留 {now_ids - before}")

    print("\n" + "=" * 60)
    print(f"通过 {len(PASSED)} 项，失败 {len(FAILED)} 项")
    for name in FAILED:
        print(f"  ✗ {name}")
    print("全部通过 ✅" if not FAILED else "有失败项，需修")


if __name__ == "__main__":
    main()
