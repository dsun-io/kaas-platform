"""核对报价表的「显示位数」链路：产品定义声明 → 后端下发 → 界面按位渲染。

为什么值得单独验：
    位数不对**不会报错**，只会让金额看起来像少了精度（301 而不是 301.00）。
    这类问题只能靠"看实际返回值"发现，类型检查和单测都照不出来。

请求体与 verify_pricing_wiring.py 保持一致 —— 复用同一套已验证的入参，
避免"脚本自己写错了参数"导致误判成接口问题。

用法：cd backend/orchestrator && .venv\\Scripts\\python.exe scripts\\verify\\check_decimals.py
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

BODY = {
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


def call(path: str, body: dict) -> dict:
    req = urllib.request.Request(BASE + path, method="POST")
    req.add_header("Authorization", "Bearer " + TOKEN)
    req.add_header("X-Tenant-Id", "lianjia")
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, json.dumps(body).encode()) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        return {"__http_error__": e.code, "__body__": e.read().decode()[:600]}


def show(view_name: str, table: dict) -> None:
    print(f"\n=== {view_name} ===")
    decimals = table.get("decimals")
    head = table.get("header") or []
    row = (table.get("rows") or [[]])[0]
    if decimals is None:
        print("  ✗ 没有 decimals 字段 —— 界面无从知道该留几位")
        return
    ok_len = len(decimals) == len(head)
    kinds = sorted({type(d).__name__ for d in decimals})
    print(f"  位数个数={len(decimals)}  列数={len(head)}  等长={'✅' if ok_len else '✗'}")
    print(f"  位数元素类型={kinds}（JS 里 1 与 1.0 无差别，这里只是如实记录）")
    for h, v, d in zip(head, row, decimals):
        if isinstance(v, (int, float)) and not isinstance(v, bool) and d is not None:
            shown = f"{v:.{int(d)}f}"
        else:
            shown = "—" if v is None else str(v)
        print(f"    {h:<20} 位数={str(d):<5} 原值={str(v):<14} 界面显示={shown}")

    money = [h for h in head if any(k in h for k in ("售价", "单价", "总价", "成本"))]
    print(f"  金额列 {money} 的位数 = {[decimals[head.index(h)] for h in money]}")
    dia = [h for h in head if "丝径" in h]
    print(f"  丝径列 {dia} 的位数 = {[decimals[head.index(h)] for h in dia]}")


def main() -> None:
    r = call("/export-quote/calculate", BODY)
    if "customer" not in r:
        print("✗ 客户视图取数失败:", json.dumps(r, ensure_ascii=False)[:600])
        return
    show("客户视图 / calculate", r["customer"])
    if r.get("customer_en"):
        show("客户视图英文表", r["customer_en"])

    ri = call("/export-quote/calculate-internal", BODY)
    if "internal" in ri:
        show("内部视图 / calculate-internal", ri["internal"])
    else:
        print("\n内部视图取数失败:", json.dumps(ri, ensure_ascii=False)[:600])


if __name__ == "__main__":
    main()
