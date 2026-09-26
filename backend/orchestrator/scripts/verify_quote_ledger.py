"""验证「报价单签发 → 报价记录台账入账（整单一条）」这条新规则。

校验点：
  1. 建草稿报价单      → 台账**不应**增长（只有业务节点才落账）
  2. 签发给客户(sent)  → 台账**应**恰好 +1，且字段符合约定
  3. 重复签发          → 状态机拒绝(409)，台账不再增长（幂等）
  4. 收尾              → 删除本次测试产生的所有行，不留测试数据

用法：python scripts/verify_quote_ledger.py
"""
from __future__ import annotations

import json
import pathlib
import sys
import urllib.error
import urllib.request

BASE = "http://localhost:8000/api/v1"
ENV = pathlib.Path(__file__).resolve().parent.parent / ".env"

creds = {}
for line in ENV.read_text(encoding="utf-8").splitlines():
    for k in ("DEV_LIANJIA_EMAIL", "DEV_LIANJIA_PASSWORD"):
        if line.startswith(k + "="):
            creds[k] = line.split("=", 1)[1].strip().strip('"')


def call(method: str, path: str, token: str | None = None, body: dict | None = None):
    req = urllib.request.Request(BASE + path, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    data = json.dumps(body).encode() if body is not None else None
    try:
        with urllib.request.urlopen(req, data, timeout=30) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        raw = e.read().decode(errors="replace")
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, raw


def ledger_total(token: str) -> int:
    _, j = call("GET", "/quotations", token)
    return j.get("total", 0)


def main() -> None:
    ok = True
    status, j = call("POST", "/auth/login", body={
        "email": creds["DEV_LIANJIA_EMAIL"], "password": creds["DEV_LIANJIA_PASSWORD"]})
    if status != 200:
        raise SystemExit(f"登录失败 {status}: {j}")
    token = j["access_token"]

    _, cust = call("GET", "/customers", token)
    items = cust.get("items") or []
    if not items:
        raise SystemExit("该租户下没有客户，无法建报价单")
    customer_id = items[0].get("customer_id") or items[0].get("id")
    print(f"  使用客户: {customer_id}")

    before = ledger_total(token)
    print(f"  ① 建单前台账条数: {before}")

    status, q = call("POST", "/quotes", token, {
        "customer_id": str(customer_id),
        "customer_name": "[TEST] 台账规则验证",
        "currency": "USD",
        "items": [
            {"product_name": "[TEST] 产品甲", "qty": 10, "qty_unit": "Rolls",
             "unit_price": 100, "currency": "USD"},
            {"product_name": "[TEST] 产品乙", "qty": 5, "qty_unit": "Pcs",
             "unit_price": 50, "currency": "USD"},
        ],
    })
    if status != 201:
        raise SystemExit(f"建报价单失败 {status}: {q}")
    quote_id, quote_no = q["id"], q["quote_no"]
    print(f"  ② 已建草稿报价单: {quote_no} (id={quote_id}) 总额={q.get('total_amount')}")

    mid = ledger_total(token)
    if mid != before:
        ok = False
        print(f"  ✗ 草稿阶段台账不应增长，实际 {before} → {mid}")
    else:
        print(f"  ✓ 草稿阶段未落账（{mid} 条，符合「只有业务节点才记账」）")

    status, sent = call("PATCH", f"/quotes/{quote_id}", token, {"status": "sent"})
    print(f"  ③ 签发结果: HTTP {status}, 状态={sent.get('status')}")

    after = ledger_total(token)
    if after != before + 1:
        ok = False
        print(f"  ✗ 签发后台账应 +1，实际 {before} → {after}")
    else:
        print(f"  ✓ 签发后台账 +1（{before} → {after}）")

    # 核对新入账那一行的字段
    _, lst = call("GET", "/quotations?limit=5", token)
    rows = lst.get("items") or []
    target = next((r for r in rows if r.get("source") == "quote_issued"
                   and (r.get("product_spec") or {}).get("quote_no") == quote_no), None)
    if not target:
        ok = False
        print("  ✗ 台账里没找到本次签发的记录")
    else:
        spec = target.get("product_spec") or {}
        checks = [
            ("来源标记", target.get("source"), "quote_issued"),
            ("单位", target.get("unit"), "单"),
            ("金额=整单总额", float(target.get("unit_price") or 0), float(q.get("total_amount") or 0)),
            ("快照含单号", spec.get("quote_no"), quote_no),
            ("快照明细条数", len(spec.get("items") or []), 2),
        ]
        for name, got, want in checks:
            hit = got == want
            ok = ok and hit
            print(f"    {'✓' if hit else '✗'} {name}: {got!r}" + ("" if hit else f"（期望 {want!r}）"))

    status, again = call("PATCH", f"/quotes/{quote_id}", token, {"status": "sent"})
    if status == 409:
        print(f"  ✓ 重复签发被状态机拒绝（409），不会产生第二条流水")
    else:
        print(f"  · 重复签发返回 {status}（{again if isinstance(again, str) else again.get('status')}）")
    final_total = ledger_total(token)
    if final_total != after:
        ok = False
        print(f"  ✗ 重复签发后台账又变了: {after} → {final_total}")
    else:
        print(f"  ✓ 台账仍为 {final_total} 条（幂等成立）")

    # ── 收尾：删除本次测试产生的数据，不留痕 ──
    print("\n  ④ 清理本次测试数据：")
    sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
    import asyncio
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import create_async_engine

    url = None
    for line in ENV.read_text(encoding="utf-8").splitlines():
        if line.startswith("DATABASE_URL"):
            url = line.split("=", 1)[1].strip().strip('"')

    async def cleanup() -> None:
        eng = create_async_engine(url)
        async with eng.begin() as c:
            r1 = await c.execute(text("delete from quote_order_items where quote_order_id = :i"),
                                 {"i": quote_id})
            r2 = await c.execute(text("delete from quote_orders where id = :i"), {"i": quote_id})
            r3 = await c.execute(
                text("delete from quotations where source = :s and product_spec->>'quote_no' = :q"),
                {"s": "quote_issued", "q": quote_no})
            print(f"    删除行项 {r1.rowcount} / 报价单 {r2.rowcount} / 台账 {r3.rowcount}")
        await eng.dispose()

    asyncio.run(cleanup())
    restored = ledger_total(token)
    print(f"    清理后台账条数: {restored}（应为 {before}）")
    if restored != before:
        ok = False
        print("  ✗ 清理后未回到原始条数")

    print()
    print("✓ 全部通过：签发才落账、整单一条、幂等、测试数据已清理" if ok else "✗ 存在不符合预期的项")
    raise SystemExit(0 if ok else 1)


main()
