"""金额勾稽规则 —— 纯函数、零三方依赖（stdlib only）。

orchestrator 与 Worker 共用；任何适配层不得另写一份判定。
"""
from decimal import Decimal
from typing import Any

__all__ = ["calc_line_amount", "check_amount_reconciliation", "AmountMismatchError"]


class AmountMismatchError(ValueError):
    """金额勾稽不一致（信用证不符点防线）。"""


def calc_line_amount(qty: Any, unit_price: Any, nd: int = 4) -> Decimal:
    """行金额 = 数量 × 单价（ROUND_HALF_UP 逐级落定）。"""
    q = Decimal(str(qty)) if qty is not None else None
    p = Decimal(str(unit_price)) if unit_price is not None else None
    if q is None or p is None:
        raise ValueError("行金额计算需要数量与单价")
    from decimal import ROUND_HALF_UP
    return (q * p).quantize(Decimal(1).scaleb(-nd), rounding=ROUND_HALF_UP)


def check_amount_reconciliation(total_amount: Any, items_total: Any, tolerance: str = "0.01") -> None:
    """校验单证合计 = 行项目合计；差异 > tolerance 抛 AmountMismatchError。

    信用证下「单证合计 ≠ 行项目合计」是致命不符点，会被银行拒付。
    """
    if total_amount is None or items_total is None:
        return
    t = Decimal(str(total_amount))
    i = Decimal(str(items_total))
    if abs(t - i) > Decimal(tolerance):
        raise AmountMismatchError(
            f"单证合计 {t} ≠ 行项目合计 {i}；信用证下这是致命不符点，请核对后重试"
        )
