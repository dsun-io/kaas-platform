"""商机漏斗统计 —— 纯函数、零三方依赖（stdlib only）。

设计 §7（2026-10-22 拍板 D-6）：
- 权重：询盘 1 / 报价 2 / 订单 10
- 综合分 = 询盘数×1 + 报价数×2 + 订单数×10
- 分渠道转化率 = 某渠道订单数 / 该渠道询盘数

orchestrator 与 Worker 共用；任何适配层不得另写一份判定。
"""
from typing import Any

__all__ = [
    "build_funnel",
    "compute_composite_score",
    "channel_conversion_rates",
    "direct_currency_breakdown",
]

# ── 权重常量（D-6 拍板）─────────────────────────────────────────────────────
WEIGHT_INQUIRY = 1
WEIGHT_QUOTE = 2
WEIGHT_ORDER = 10


def build_funnel(
    inquiry_count: int,
    quoted_count: int,
    ordered_count: int,
    completed_count: int,
    completed_amount: float,
) -> dict:
    """输入四个阶段计数 + 成交金额 → 输出漏斗结构（含转化率）。

    阶段定义（worker /dashboard/funnel 的 cohort 口径：时间窗内创建的询盘）：
      - inquiry_count   : 窗口内询盘数（cust_inquiries.created_at >= since）
      - quoted_count    : 其中已报价数（至少有一张 quote_orders）
      - ordered_count   : 其中已下单数（至少有一张 orders 且 source_type='inquiry'）
      - completed_count : 其中已成笔数（orders.status='completed'，仍限 source_type='inquiry'）
      - completed_amount: 这些询盘转化出的成笔订单总金额（orders.total_amount 汇总）

    注意：直接下单（source_type='direct'）不计入漏斗，由端点单独返回。
    """
    def _pct(numerator: int, denominator: int) -> float | None:
        if denominator == 0:
            return None
        return round(numerator / denominator * 100, 2)

    return {
        "stages": [
            {"name": "inquiry",   "label": "询盘",   "count": inquiry_count},
            {"name": "quoted",    "label": "已报价", "count": quoted_count},
            {"name": "ordered",   "label": "已下单", "count": ordered_count},
            {"name": "completed", "label": "已成笔", "count": completed_count,
             "amount": round(completed_amount, 2) if completed_amount else 0.0},
        ],
        "conversion_rates": {
            "inquiry_to_quote":    _pct(quoted_count,    inquiry_count),
            "quote_to_order":      _pct(ordered_count,   quoted_count),
            "order_to_completed":  _pct(completed_count, ordered_count),
            "inquiry_to_completed": _pct(completed_count, inquiry_count),
        },
        "composite_score": compute_composite_score(
            inquiry_count, quoted_count, ordered_count),
    }


def compute_composite_score(
    inquiry_count: int,
    quote_count: int,
    order_count: int,
) -> int:
    """综合商机分（D-6）：询盘×1 + 报价×2 + 订单×10。"""
    return (
        inquiry_count * WEIGHT_INQUIRY
        + quote_count * WEIGHT_QUOTE
        + order_count * WEIGHT_ORDER
    )


def direct_currency_breakdown(rows: list[dict[str, Any]]) -> list[dict]:
    """直接下单按币种拆账（P0-A A5）—— 多币种时不再用混加金额误导。

    rows 每项形状（worker 的 GROUP BY currency 聚合结果）：
      {"currency": <str|None>, "order_count": <int>, "amount": <number>}

    返回按币种字典序的 `[{"currency","count","amount"}]`。
    币种缺失 → `"—"`（与应收聚合同口径，不伪造 USD）。

    为什么上层还保留 `count/amount`：字段是既有契约（旧卡片在用），
    但 `amount` 是**跨币种原值相加**、仅规模参考 —— 精确金额只看本函数结果。
    """
    out: list[dict] = []
    for row in rows or []:
        raw = row.get("currency")
        text = str(raw).strip() if raw is not None else ""
        out.append({
            "currency": text.upper() if text else "—",
            "count": int(row.get("order_count") or 0),
            "amount": round(float(row.get("amount") or 0), 2),
        })
    out.sort(key=lambda item: item["currency"])
    return out


def channel_conversion_rates(channels: list[dict[str, Any]]) -> list[dict]:
    """输入各渠道原始计数 → 输出带转化率的渠道列表。

    channels 每项形状：
      {"channel": <str>, "inquiry_count": <int>, "quote_count": <int>,
       "order_count": <int>, "completed_count": <int>}
    """
    out = []
    for ch in channels:
        name = ch.get("channel") or "other"
        inq = int(ch.get("inquiry_count") or 0)
        qte = int(ch.get("quote_count") or 0)
        ord_ = int(ch.get("order_count") or 0)
        cmp = int(ch.get("completed_count") or 0)

        def _pct(n: int, d: int) -> float | None:
            return round(n / d * 100, 2) if d else None

        out.append({
            "channel": name,
            "inquiry_count": inq,
            "quote_count": qte,
            "order_count": ord_,
            "completed_count": cmp,
            "conversion_rates": {
                "inquiry_to_order": _pct(ord_, inq),
                "inquiry_to_completed": _pct(cmp, inq),
            },
            "composite_score": compute_composite_score(inq, qte, ord_),
        })
    # 按综合分降序
    out.sort(key=lambda x: x["composite_score"], reverse=True)
    return out
