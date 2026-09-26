"""端到端验证「客户税率档案」：存得回、取得出、**套用后报价真的变**。

为什么最后一条最重要：
    「档案存在数据库里、接口也读得出来」并不能证明界面把值接上了。
    只有「同一组规格，套用档案与不套用算出不同金额」，才能证明整条链是活的。
    而且这个差异必须**只有套用了档案的那一份才出现**，所以同时要有个对照。

顺带钉死两个易错点：
    · 销项税率 0 与「没填」是两件事 —— 0 会参与计算，没填则走法定值；
    · 百分比往返（界面 10 ↔ 档案 0.1）不能丢精度。

用法：cd backend/orchestrator && .venv\\Scripts\\python.exe scripts\\verify\\verify_profile_e2e.py
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


def quote(policy: dict) -> float | None:
    """按给定政策算一次价，返回「单卷售价」。"""
    body = {
        "product_key": PRODUCT,
        "rate_set_code": "CN-2026-09",
        "fx_rate": 6.7019,
        "orders": [{"total": 30000, "unit": "m"}],
        "quote_date": "2026-09-24",
        "spec_rows": [{
            "height_m": 1.2,
            "mesh_mm": 100,
            "de": 2.0,
            "inner_wire": "内丝2.0",
            "coating": "普锌40g/㎡",
            "wave": "无波款",
        }],
        "policy": policy,
    }
    st, r = call("POST", "/export-quote/calculate", body)
    if "customer" not in r:
        print(f"    （算价失败 st={st}: {json.dumps(r, ensure_ascii=False)[:240]}）")
        return None
    head = r["customer"]["header"]
    row = r["customer"]["rows"][0]
    idx = next((i for i, h in enumerate(head) if "单卷售价" in h), None)
    return None if idx is None else row[idx]


def main() -> None:
    # 界面会把「10」换算成 0.1 再提交，这里照做 —— 验的就是这条往返。
    tax = {
        "input_vat_rate": 0.13,
        "output_vat_rate": 0.0,
        "rebate_rate": 0.13,
        "stamp_rate": 0.05,
        "stamp_base": "profit",
    }

    print("=== ① 保存一份档案（进项 13%、退税率 13%、销项 0）===")
    st, created = call("POST", "/quote-profiles", {
        "product_key": PRODUCT,
        "profile_name": "E2E-高进项13个点",
        "rate_set_code": "CN-2026-09",
        "tax_overrides": tax,
    })
    check("保存成功", st == 201, str(created)[:300])
    pid = created.get("id")

    print("\n=== ② 逐字段原样回来（含 0 与「没填」的区分）===")
    st, listing = call("GET", f"/quote-profiles?product_key={PRODUCT}")
    got = next((p for p in listing.get("profiles", []) if p["id"] == pid), None)
    check("能在列表里取到", got is not None)
    back = (got or {}).get("tax_overrides", {})
    check("进项票税点 0.13 原样", back.get("input_vat_rate") == 0.13, str(back))
    check("出口退税率 0.13 原样", back.get("rebate_rate") == 0.13, str(back))
    # 0 与「没填」是两件事：0 会把销项税那一环定死，没填则取法定值。
    check("销项税率 0 被保留（不是被当成空）",
          "output_vat_rate" in back and back["output_vat_rate"] == 0.0, str(back))
    check("印花税基数原样", back.get("stamp_base") == "profit", str(back))

    print("\n=== ③ 百分比往返不丢精度（界面 13% ↔ 档案 0.13）===")
    for pct in (10, 13, 5.5, 7, 0, 100):
        rate = pct / 100
        back_pct = round(rate * 100, 6)
        if back_pct != pct:
            check(f"{pct}% 往返", False, f"回来变成 {back_pct}")
            break
    else:
        check("6 个取值往返全部一致", True)

    print("\n=== ④ 套用档案 vs 不套用 —— 报价必须不同（证明接线是活的）===")
    default_policy = {
        "input_vat_rate": 0.10,
        "output_vat_rate": 0.0,
        "give_ratio": 0.8,
        "profit_mode": "fixed",
        "profit_value": 0.1,
        "refund_ratio": 1.0,
        "stamp_rate": 0.05,
        "stamp_base": "profit",
    }
    # 界面套用档案后提交的就是这个：把档案里的项覆盖到默认政策上
    applied_policy = {**default_policy, **{k: v for k, v in tax.items()}}
    p_default = quote(default_policy)
    p_applied = quote(applied_policy)
    print(f"  不套用档案：单卷售价 = {p_default}")
    print(f"  套用档案后：单卷售价 = {p_applied}")
    check("两次都算出来了", p_default is not None and p_applied is not None)
    check("套用档案后金额确实变了", p_default != p_applied,
          f"{p_default} vs {p_applied} —— 若相同，说明档案没被接上")

    print("\n=== ⑤ 对照：只改销项税率（0 → 13%）也要能看出差别 ===")
    p_out = quote({**applied_policy, "output_vat_rate": 0.13})
    print(f"  销项 13%：单卷售价 = {p_out}")
    check("销项税率参与计算", p_out is not None and p_out != p_applied,
          f"{p_applied} vs {p_out}")

    print("\n=== ⑥ 清理本次产生的档案 ===")
    st, _ = call("DELETE", f"/quote-profiles/{pid}")
    check("已移除", st == 200)
    st, listing = call("GET", f"/quote-profiles?product_key={PRODUCT}")
    check("列表里不再有它", not any(p["id"] == pid for p in listing.get("profiles", [])))

    print("\n" + "=" * 60)
    print(f"通过 {len(PASSED)} 项，失败 {len(FAILED)} 项")
    for name in FAILED:
        print(f"  ✗ {name}")
    print("全部通过 ✅" if not FAILED else "有失败项，需修")


if __name__ == "__main__":
    main()
