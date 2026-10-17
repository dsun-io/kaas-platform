"""真库 CRUD 冒烟（验证分支 br-young-water-b5quc5ql）—— 询盘/客户/订单数据流 + 持久化。

验证口径（用户 2026-10-17 要求）：
1. 业务客户 CREATE/READ/UPDATE/DELETE
2. 询盘（挂客户）CREATE/READ/UPDATE
3. 报价单 + 行项（含新列 cost_breakdown）CREATE/READ
4. 订单 CREATE/READ/UPDATE
5. 新表 trade_doc_receipts / trade_doc_doc_set_items 可写可读

只在验证分支上动数据；DELETE 只删本脚本自己插入的行。
"""
import asyncio
import sys

import asyncpg

DSN = sys.argv[1]

SQL = {
    "now": "SELECT now() AS t",
    "insert_customer": (
        "INSERT INTO customers (tenant_id, name, stage, plan, status, created_by, owner_id, owner_scope)"
        " VALUES ('default', $1, 'lead', 'free', 'active', 'verify', 'verify', 'private') RETURNING id"
    ),
    "insert_inquiry": (
        "INSERT INTO cust_inquiries (tenant_id, customer_id, product_name_raw, quantity,"
        " quantity_unit, channel, status, created_at)"
        " VALUES ('default', $1, '牛栏网 2.5mm', 300, 'ROLLS', 'alibaba', 'open', now())"
        " RETURNING id"
    ),
    "insert_quote": (
        "INSERT INTO quote_orders (tenant_id, quote_no, customer_id, status, currency,"
        " total_amount, created_by, owner_id, owner_scope)"
        " VALUES ('default', $1, $2, 'draft', 'USD', 3612.36, 'verify', 'verify', 'private')"
        " RETURNING id"
    ),
    "insert_quote_item": (
        "INSERT INTO quote_order_items (tenant_id, quote_order_id, product_name, qty,"
        " qty_unit, unit_price, currency, line_amount, sort_order, cost_breakdown)"
        " VALUES ('default', $1, 'Field Fence', 12, 'ROLLS', 301.03, 'USD', 3612.36, 0,"
        " $2::jsonb) RETURNING id"
    ),
    "insert_order": (
        "INSERT INTO orders (tenant_id, order_no, customer_id, status, currency,"
        " total_amount, created_by, owner_id, owner_scope)"
        " VALUES ('default', $1, $2, 'pending', 'USD', 3612.36, 'verify', 'verify', 'private')"
        " RETURNING id"
    ),
    "read_customer": "SELECT id, name, stage FROM customers WHERE id=$1",
    "read_inquiry": "SELECT id, customer_id, product_name_raw, status FROM cust_inquiries WHERE id=$1",
    "read_quote_item": "SELECT id, product_name, unit_price, cost_breakdown FROM quote_order_items WHERE id=$1",
    "read_order": "SELECT id, order_no, status FROM orders WHERE id=$1",
    "update_customer": "UPDATE customers SET stage='won' WHERE id=$1 RETURNING stage",
    "update_order": "UPDATE orders SET status='confirmed' WHERE id=$1 RETURNING status",
    "insert_receipt": (
        "INSERT INTO trade_doc_receipts (tenant_id, trade_doc_id, schedule_amount,"
        " received_amount, currency, diff, diff_reason, status)"
        " VALUES ('default', 999999, 100, 99.97, 'USD', -0.03, 'fx_rounding', 'auto_cleared')"
        " RETURNING id, diff_reason"
    ),
    "insert_doc_set": (
        "INSERT INTO trade_doc_doc_set_items (tenant_id, trade_doc_id, doc_type, role,"
        " issuer, status) VALUES ('default', 999999, 'pi', 'not_by_us', 'buyer', 'pending')"
        " RETURNING id, status"
    ),
    "update_doc_set": (
        "UPDATE trade_doc_doc_set_items SET status='received', received_at=now()"
        " WHERE id=$1 RETURNING status"
    ),
    "delete_customer": "DELETE FROM customers WHERE id=$1 RETURNING id",
    "delete_quote": "DELETE FROM quote_orders WHERE id=$1 RETURNING id",
}


async def main():
    conn = await asyncpg.connect(DSN)
    results = []

    def ok(step, detail=""):
        results.append((step, "PASS", detail))

    # 1. 客户 CRUD
    cust_id = await conn.fetchval(SQL["insert_customer"], "验证客户-丝网")
    row = await conn.fetchrow(SQL["read_customer"], cust_id)
    assert row["name"] == "验证客户-丝网", row
    ok("客户 CREATE+READ", f"id={cust_id}")
    stage = await conn.fetchval(SQL["update_customer"], cust_id)
    assert stage == "won", stage
    ok("客户 UPDATE", f"stage={stage}")

    # 2. 询盘（挂客户）
    inq_id = await conn.fetchval(SQL["insert_inquiry"], cust_id)
    row = await conn.fetchrow(SQL["read_inquiry"], inq_id)
    assert row["customer_id"] == cust_id, row
    ok("询盘 CREATE+READ", f"id={inq_id} customer_id={row['customer_id']}")

    # 3. 报价 + 行项（cost_breakdown 新列）
    q_id = await conn.fetchval(SQL["insert_quote"], f"QUO-VERIFY-{cust_id}", cust_id)
    item_id = await conn.fetchval(
        SQL["insert_quote_item"], q_id,
        '{"view":"internal","currency_cny_per_m2":{"cost_pretax":8.75}}',
    )
    row = await conn.fetchrow(SQL["read_quote_item"], item_id)
    import json as _j
    bd = row["cost_breakdown"]
    bd = _j.loads(bd) if isinstance(bd, str) else bd
    assert bd["view"] == "internal", row
    ok("报价+行项 CREATE+READ（cost_breakdown 落库）", f"quote={q_id} item={item_id}")

    # 4. 订单
    o_id = await conn.fetchval(SQL["insert_order"], f"ORD-VERIFY-{cust_id}", cust_id)
    row = await conn.fetchrow(SQL["read_order"], o_id)
    assert row["status"] == "pending", row
    st = await conn.fetchval(SQL["update_order"], o_id)
    assert st == "confirmed", st
    ok("订单 CREATE+READ+UPDATE", f"id={o_id} status={st}")

    # 5. 新表写入（P1 收款/单证清单）
    _rr = await conn.fetchrow(SQL["insert_receipt"])
    r_id, r_reason = _rr["id"], _rr["diff_reason"]
    assert r_reason == "fx_rounding", r_reason
    ok("收款登记 CREATE", f"id={r_id} diff_reason={r_reason}")
    _dd = await conn.fetchrow(SQL["insert_doc_set"])
    d_id, d_st = _dd["id"], _dd["status"]
    assert d_st == "pending", d_st
    d_st2 = (await conn.fetchrow(SQL["update_doc_set"], d_id))["status"]
    assert d_st2 == "received", d_st2
    ok("单证清单 CREATE+UPDATE（回执登记 pending→received）", f"id={d_id} status={d_st2}")

    # 6. DELETE（只删自己插的）
    await conn.fetchrow(SQL["insert_customer"], "验证客户-将删除")
    del_id = await conn.fetchval(
        "SELECT id FROM customers WHERE name='验证客户-将删除'")
    await conn.fetchrow(SQL["delete_customer"], del_id)
    gone = await conn.fetchval("SELECT id FROM customers WHERE id=$1", del_id)
    assert gone is None, gone
    ok("客户 DELETE", f"id={del_id} 已删除")

    await conn.fetchrow(SQL["delete_quote"], q_id)
    items = await conn.fetchval(
        "SELECT count(*) FROM quote_order_items WHERE quote_order_id=$1", q_id)
    # 行项可能因外键级联删掉或留下（看约束）；报价单必须已删
    gone_q = await conn.fetchval("SELECT id FROM quote_orders WHERE id=$1", q_id)
    assert gone_q is None, gone_q
    ok("报价 DELETE", f"id={q_id} 残留行项={items}")

    await conn.close()
    for step, st, detail in results:
        print(f"{st}  {step}  {detail}")
    print(f"\n{len(results)}/{len(results)} 项通过")

asyncio.run(main())
