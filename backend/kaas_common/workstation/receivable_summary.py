"""应收台账聚合 —— 纯函数、零三方依赖（stdlib only）。

P0-A A3（docs/UI_EXECUTION_PLAN_2026-10-23.md §2）：
dashboard 需要「按时间窗看应收总额 / 已收 / 未收」，而 `GET /api/v1/receivables`
只有分页台账（前端自己拼会得出**只覆盖当前页**的假数字）。本模块是
`GET /api/v1/dashboard/receivables` 的聚合口径唯一实现 —— worker 只负责
「按 tenant + 时间窗 + 归属过滤取行」，聚合规则在这里，前端不得另写一份。

口径（与 `frontend/src/lib/receivables/summary.ts` 一致）：
- **金额只在同币种内相加**：币种不同硬加会得出无意义数字（前端同一句注释）；
  需要跨币种视图时应由后端出折算口径（`receivables.exchange_gain_loss` 已表明归后端）。
- 未收 = max(0, 应收总额 − 已收)：多收（received > total）不夹成负数，但也不虚增未收。
- 币种缺省/空 → `"—"`（与前端同口径；不伪造 USD）。
- 状态计数按 `unpaid/partial/paid` 固定顺序输出，未知状态排在后面按字典序。

⚠️ `by_status[].total` 是**跨币种原值相加**，仅作规模参考（多币种时不可当金额用）；
真正的金额看 `by_currency`。保留该字段是因为列表页卡片要显示「未收 N 单 / 合计」，
与 funnel 的 `direct_orders.amount` 同一处理（保留兼容 + 注释写清口径）。
"""
from typing import Any

__all__ = [
    "summarize_receivables",
    "RECEIVABLE_STATUSES",
    "UNKNOWN_CURRENCY",
]

#: receivables.status 的固定展示顺序（迁移枚举 unpaid/partial/paid）。
RECEIVABLE_STATUSES = ("unpaid", "partial", "paid")

#: 币种缺失时的展示值（与前端 lib/receivables/summary.ts 同口径）。
UNKNOWN_CURRENCY = "—"


def _get(row: Any, key: str) -> Any:
    if isinstance(row, dict):
        return row.get(key)
    return getattr(row, key, None)


def _num(value: Any) -> float:
    """金额 → float；None/空串/非法一律 0（聚合不能因一行脏数据整体 500）。"""
    if value is None or value == "":
        return 0.0
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _round2(value: float) -> float:
    return round(value, 2)


def _currency_of(row: Any) -> str:
    raw = _get(row, "currency")
    text = str(raw).strip() if raw is not None else ""
    return text.upper() if text else UNKNOWN_CURRENCY


def summarize_receivables(rows: Any) -> dict:
    """应收行 → dashboard 聚合结构。

    rows 每项至少带 `currency / total_amount / received_amount / status`
    （worker 只 SELECT 这四列，不把 owner_id/team_id 等内部列带出内核）。

    返回::

        {
          "by_currency": [{"currency","total","received","outstanding","count"}],
          "by_status":   [{"status","count","total"}],
          "totals":      {"count": <行数>},
        }

    `by_currency` 按币种字典序（前端同样排序，便于快照测试）；
    `by_status` 按 unpaid/partial/paid 固定顺序，未知状态随后按字典序。
    """
    by_currency: dict[str, dict] = {}
    by_status: dict[str, dict] = {}
    count = 0

    for row in rows or []:
        currency = _currency_of(row)
        total = _num(_get(row, "total_amount"))
        received = _num(_get(row, "received_amount"))
        # 未收按行先夹 0 再相加：与前端 outstandingOf 逐行一致
        outstanding = max(0.0, total - received)

        entry = by_currency.get(currency)
        if entry is None:
            entry = {"currency": currency, "total": 0.0, "received": 0.0,
                     "outstanding": 0.0, "count": 0}
            by_currency[currency] = entry
        entry["total"] += total
        entry["received"] += received
        entry["outstanding"] += outstanding
        entry["count"] += 1

        status = str(_get(row, "status") or "unknown")
        status_entry = by_status.get(status)
        if status_entry is None:
            status_entry = {"status": status, "count": 0, "total": 0.0}
            by_status[status] = status_entry
        status_entry["count"] += 1
        status_entry["total"] += total
        count += 1

    ordered_statuses = sorted(
        by_status.values(),
        key=lambda item: (
            RECEIVABLE_STATUSES.index(item["status"])
            if item["status"] in RECEIVABLE_STATUSES
            else len(RECEIVABLE_STATUSES),
            item["status"],
        ),
    )

    return {
        "by_currency": [
            {
                "currency": item["currency"],
                "total": _round2(item["total"]),
                "received": _round2(item["received"]),
                "outstanding": _round2(item["outstanding"]),
                "count": item["count"],
            }
            for item in sorted(by_currency.values(), key=lambda item: item["currency"])
        ],
        "by_status": [
            {"status": item["status"], "count": item["count"],
             "total": _round2(item["total"])}
            for item in ordered_statuses
        ],
        # 行数是唯一可跨状态的计数；金额一律看 by_currency（禁止跨币种相加）
        "totals": {"count": count},
    }
