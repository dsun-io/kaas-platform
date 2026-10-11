"""原料价历史与参考均价。

用户决策（2026-10-11）：「存历史 + 算均价并展示」。

关键结论：**不用新建历史表** —— `customer_cost_items` 本来就是
**INSERT-only、不删历史**（带 effective_from/to 与 status），
`list_pricing_key_items` 返回的就是全部版本。
所以"保存每次输入、没报价时求历史平均值做参考"这条需求，
只差一个**统计**（`reference_stats`）。

本文件测的是统计本身（纯函数、不碰数据库）。
"""
from datetime import datetime, timedelta, timezone

import pytest

from app.services.pricing_table import collect_price_history, reference_stats

pytestmark = pytest.mark.unit


class _Item:
    """够用的假定价行（真实行是 SQLAlchemy 模型，字段一致）。"""

    def __init__(self, amount, days_ago=0, customer_id="c1",
                 product_key="field_fence", key="de=2|coating_code=zinc_40"):
        self.amount = amount
        self.customer_id = customer_id
        self.spec_hash = f"{product_key}:{key}"
        self.created_at = datetime.now(timezone.utc) - timedelta(days=days_ago)


class TestReferenceStats:
    def test_empty_is_all_none_not_zero(self):
        """没有历史时应当回 None（界面据此**不显示**参考价），
        而不是回 0 —— 0 会被当成"历史均价是 0 元"。"""
        got = reference_stats([])
        assert got["count"] == 0
        assert got["avg"] is None and got["min"] is None and got["max"] is None
        assert got["last"] is None and got["last_at"] is None

    def test_average_over_all_history(self):
        rows = [_Item(5.6, 1), _Item(5.0, 10), _Item(4.4, 40)]
        got = reference_stats(rows)
        assert got["count"] == 3
        assert got["avg"] == round((5.6 + 5.0 + 4.4) / 3, 6)
        assert got["min"] == 4.4 and got["max"] == 5.6

    def test_last_is_the_newest_not_the_last_iterated(self):
        """repo 按 id 倒序返回 → 第 0 条即最新。语义不能靠"碰巧顺序对"。"""
        rows = [_Item(5.9, 1), _Item(4.4, 60)]
        got = reference_stats(rows)
        assert got["last"] == 5.9
        assert got["last_at"] is not None

    def test_window_excludes_older_entries(self):
        rows = [_Item(6.0, 2), _Item(5.0, 10), _Item(3.0, 100)]
        got = reference_stats(rows, window_days=30)
        # 近 30 天只有前两条
        assert got["count_30d"] == 2
        assert got["avg_30d"] == round((6.0 + 5.0) / 2, 6)
        # 全部历史仍是三条
        assert got["count"] == 3

    def test_no_recent_entries_leaves_avg_30d_none(self):
        got = reference_stats([_Item(3.0, 100)], window_days=30)
        assert got["count"] == 1
        assert got["avg_30d"] is None and got["count_30d"] == 0


class TestCollectPriceHistory:
    def test_groups_by_customer_and_key(self):
        items = [
            _Item(4.4, customer_id="c1", key="k1"),
            _Item(5.0, customer_id="c1", key="k1"),
            _Item(5.6, customer_id="c2", key="k1"),
            _Item(6.0, customer_id="c1", key="k2"),
        ]
        product = type("P", (), {"key": "field_fence"})()
        got = collect_price_history(items, product)
        assert set(got) == {("c1", "k1"), ("c2", "k1"), ("c1", "k2")}
        assert len(got[("c1", "k1")]) == 2

    def test_ignores_other_products(self):
        items = [_Item(4.4, product_key="deer_net")]
        product = type("P", (), {"key": "field_fence"})()
        assert collect_price_history(items, product) == {}

    def test_ignores_non_positive_amounts(self):
        """0 / 负数是脏数据，混进均价会把参考值拉低。"""
        items = [_Item(0), _Item(-1), _Item(4.4)]
        product = type("P", (), {"key": "field_fence"})()
        got = collect_price_history(items, product)
        assert len(got[("c1", "de=2|coating_code=zinc_40")]) == 1
