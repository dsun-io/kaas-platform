"""报价行项内部分解的「对内可见 / 对外剥除」—— 无数据库单元测试。

红线（UNCERTAIN #19）：`cost_breakdown`（成本/利润分解）**只允许 platform
员工（account_type='internal'）读到**；customer 账号在接口层就被剥掉，
绝不依赖前端隐藏。本测试直接钉 `_row_to_item` 的过滤行为。
"""
from __future__ import annotations

import pytest

from app.api.quote_orders import _row_to_item
from app.core.auth import AuthContext
from app.db.workstation_links import QuoteOrderItem

pytestmark = pytest.mark.unit

_BREAKDOWN = {"cost": 12.5, "tax": 0.8, "profit": 1.7, "margin": "0.12"}


def _item() -> QuoteOrderItem:
    return QuoteOrderItem(
        id=1,
        tenant_id="default",
        quote_order_id=7,
        product_name="牛栏网",
        qty=100,
        unit_price=15.0,
        currency="USD",
        line_amount=1500.0,
        sort_order=0,
        cost_breakdown=_BREAKDOWN,
    )


def test_internal_sees_cost_breakdown():
    auth = AuthContext(user_id=1, account_type="internal", role="system_admin")
    out = _row_to_item(_item(), auth)
    assert out["cost_breakdown"] == _BREAKDOWN
    # 其余白名单字段照常输出
    assert out["unit_price"] == 15.0
    assert out["product_name"] == "牛栏网"


def test_customer_item_strips_cost_breakdown():
    auth = AuthContext(user_id=2, account_type="customer", role="customer_owner")
    out = _row_to_item(_item(), auth)
    assert "cost_breakdown" not in out
    # 对外价格字段不受影响
    assert out["unit_price"] == 15.0
    assert out["line_amount"] == 1500.0


def test_anonymous_item_strips_cost_breakdown():
    # auth=None 视为不可信出口（防御默认），同样剥除
    out = _row_to_item(_item(), None)
    assert "cost_breakdown" not in out


def test_null_breakdown_serializes_as_none_for_internal():
    auth = AuthContext(user_id=1, account_type="internal", role="user")
    it = _item()
    it.cost_breakdown = None  # 老数据无分解
    out = _row_to_item(it, auth)
    assert out["cost_breakdown"] is None
