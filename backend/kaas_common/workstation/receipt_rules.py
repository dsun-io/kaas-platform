"""收款容差与核销判定（P1 · TRADE_DOC_HARDENING_PLAN §E）—— 纯函数，两端共用。

裁决（UNCERTAIN #17 ③，2026-10-17）：
每币种容差 = **max(5 美分等值, 金额 × 0.1%)** ——
- 差额 ≤ 容差：自动核销（`diff_reason="fx_rounding"`，银行手续费/汇率尾差）；
- 差额 > 容差：挂 `short_paid` 告警（业务要人工决定是催收还是让利）。

为什么是两者取大：小额收款（100 USD）用比例容差太紧（0.1 USD < 银行手续费），
大额收款（10 万 USD）用绝对容差太松（0.05 相对 100 差额毫无意义）。
「5 美分等值」按币种内置表换算（先 USD/EUR/CNY，其余按 5 美分×汇率扩表）。

stdlib only（Pyodide 可跑），与 amount_rules 同风格。
"""
from __future__ import annotations

from decimal import Decimal, InvalidOperation
from typing import Any, Optional

__all__ = [
    "CURRENCY_ABS_TOLERANCE",
    "receipt_tolerance",
    "classify_receipt_diff",
    "ReceiptVerdict",
]

# 5 美分等值：USD/EUR≈0.05（欧美零头同量级）；CNY 按 1 USD≈7 估 0.35。
# 不在表里的币种按 0.05 兜底（宁可严一点：差额会挂 short_paid 让人看，不静默核销）。
CURRENCY_ABS_TOLERANCE: dict[str, Decimal] = {
    "USD": Decimal("0.05"),
    "EUR": Decimal("0.05"),
    "CNY": Decimal("0.35"),
    "GBP": Decimal("0.05"),
    "JPY": Decimal("5"),
    "AUD": Decimal("0.05"),
    "CAD": Decimal("0.05"),
    "HKD": Decimal("0.40"),
}

_RATIO = Decimal("0.001")  # 0.1%


class ReceiptVerdict:
    """一笔收款的核销判定结果。"""

    __slots__ = ("diff", "tolerance", "auto_cleared", "diff_reason")

    def __init__(self, diff: Decimal, tolerance: Decimal, auto_cleared: bool, diff_reason: str):
        self.diff = diff
        self.tolerance = tolerance
        self.auto_cleared = auto_cleared
        self.diff_reason = diff_reason

    def __repr__(self) -> str:  # pragma: no cover - 调试用
        return (
            f"ReceiptVerdict(diff={self.diff}, tolerance={self.tolerance}, "
            f"auto_cleared={self.auto_cleared}, reason={self.diff_reason!r})"
        )


def _dec(v: Any) -> Optional[Decimal]:
    if v is None:
        return None
    try:
        return Decimal(str(v))
    except InvalidOperation:  # 非数值按"缺数据"处理
        return None


def receipt_tolerance(currency: str, amount: Any) -> Decimal:
    """该币种该金额下的容差 = max(5 美分等值, |amount| × 0.1%)。"""
    amt = abs(_dec(amount) or Decimal("0"))
    abs_tol = CURRENCY_ABS_TOLERANCE.get((currency or "").upper(), Decimal("0.05"))
    return max(abs_tol, amt * _RATIO)


def classify_receipt_diff(
    schedule_amount: Any,
    received_amount: Any,
    currency: str = "USD",
) -> ReceiptVerdict:
    """按账期金额 vs 实收金额判核销：差额 ≤ 容差自动核销（fx_rounding），否则 short_paid。

    - `schedule_amount` 为空（手工登记、无账期）⇒ 不判定差额（`diff=0`，`manual`）；
    - `received_amount` 缺失按 0 处理（全短收）。
    """
    sched = _dec(schedule_amount)
    recv = _dec(received_amount) or Decimal("0")
    if sched is None:
        return ReceiptVerdict(Decimal("0"), Decimal("0"), True, "manual")

    diff = recv - sched
    tolerance = receipt_tolerance(currency, sched)
    if abs(diff) <= tolerance:
        # 落在容差内：银行手续费/汇率尾差/分角尾数 —— 自动核销
        return ReceiptVerdict(diff, tolerance, True, "fx_rounding")
    return ReceiptVerdict(diff, tolerance, False, "short_paid")
