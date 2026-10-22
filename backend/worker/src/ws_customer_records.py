"""业务客户往来记录：报价 / 订单 / 单证 的**包含关系树**（Worker 端 = 生产）。

- 装配逻辑**不在本文件**：见共享内核 `kaas_common/workstation/customer_records.py`（两端一份）
- 契约见 `docs/CUSTOMER_DOCUMENTS_VIEW.md`；前端按同一契约解析
  （`frontend/src/lib/customer/customer-records.ts`）

返回形状
--------
```
{"customer": {...}, "counts": {...},
 "quotes": [ {报价..., "documents": [报价单...],
              "orders": [ {订单..., "documents": [PI/CI/PL/BL...]} ]} ],
 "direct": { "orders": [...], "documents": [...] }}
```

- **`direct`**：手动新建 / 导入已有数据的、**没有报价父对象**的订单与单证 —— 正规业务路径
  （用户明确要求支持导入历史数据），不是脏数据，前端固定渲染。
- **不按状态过滤**：草稿/已发出/已接受/已确认/作废全部返回，由 `status` 区分。
- **归属只认列**；边表由数据库触发器从列自动派生（迁移 `202610110013`）。
"""
from __future__ import annotations

from fastapi import Depends, Request

from kaas_common.workstation.customer_records import build_records

import main as _main

app = _main.app
_get_current_user = _main._get_current_user
_acquire = _main._acquire
_customer_or_404 = _main._customer_or_404
DEFAULT_TENANT = _main.DEFAULT_TENANT


@app.get("/api/v1/customers/{customer_id}/records")
async def customer_records(
    customer_id: int,
    request: Request,
    user: dict = Depends(_get_current_user),
):
    """某业务客户的往来记录（树）。不可见客户 → 404（与客户详情同口径）。"""
    async with _acquire(request) as conn:
        customer = await _customer_or_404(conn, customer_id, user)
        quotes = await conn.fetch(
            "SELECT id, quote_no, inquiry_id, status, currency, total_amount, created_at"
            " FROM quote_orders WHERE customer_id=$1 AND tenant_id=$2"
            " ORDER BY created_at DESC",
            customer_id, DEFAULT_TENANT)
        orders = await conn.fetch(
            # 2026-10-23（M2-B）：来源三元组一并查出 —— 客户详情要区分
            # 「询盘转化」与「直接下单 · 渠道」，不能再笼统归到"未关联"。
            "SELECT id, order_no, quote_id, inquiry_id, source_type,"
            " source_channel, status, currency, total_amount, created_at"
            " FROM orders WHERE customer_id=$1 AND tenant_id=$2 ORDER BY created_at",
            customer_id, DEFAULT_TENANT)
        docs = await conn.fetch(
            "SELECT id, doc_no, doc_type, quote_id, order_id, status, currency,"
            " total_amount, created_at"
            " FROM trade_docs WHERE customer_id=$1 AND tenant_id=$2 ORDER BY created_at",
            customer_id, DEFAULT_TENANT)

        order_rows = [dict(r) for r in orders]
        doc_rows = [dict(r) for r in docs]
        # 归属**只认列**；边表由数据库触发器从列自动派生（迁移 202610110013），
        # 因此不再需要"链接表兜底"那一层（见 docs/ENTITY_LINKS_OPTIMIZATION.md P3）。

    return build_records({**customer, "id": customer_id},
                         [dict(r) for r in quotes], order_rows, doc_rows)
