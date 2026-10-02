"""单证业务规则 —— 纯函数、零三方依赖（stdlib only）。

这是单证状态机 / 派生前置 / 确认必填 / 金额勾稽的**唯一规则源**（G1），
orchestrator 与 Worker 共用，任何适配层不得另写一份判定。

业务约定（2026-09-30 用户裁决）：
- 确认（issued）即锁死，不可修改；作废（void）后复制重开。
- 派生（后单从前单提取参数）**仅接受已确认源**：未确认=流程未到+数据仍在变。
- 金额勾稽：行金额 = 数量 × 单价（ROUND_HALF_UP）。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import Any, Mapping, Sequence

# ─── 单证状态机 ────────────────────────────────────────────────────────────
DOC_STATUS = ("draft", "issued", "void")
DOC_NEXT: dict[str, tuple[str, ...]] = {
    "draft": ("issued", "void"),
    "issued": ("void",),   # 确认即锁死：issued 只能作废
    "void": (),
}

# ─── 错误码（与 API 层 detail.code 对应）─────────────────────────────────
SOURCE_NOT_CONFIRMED = "SOURCE_NOT_CONFIRMED"
ILLEGAL_TRANSITION = "ILLEGAL_TRANSITION"
CONFIRM_INVALID = "CONFIRM_INVALID"
ITEMS_INVALID = "ITEMS_INVALID"
NOT_DRAFT = "NOT_DRAFT"

# 金额精度：行金额 4 位小数（与报价引擎逐级落定口径一致）
AMOUNT_DECIMALS = 4


class RuleError(ValueError):
    """业务规则违例。code 供 API 层直接落 detail.code。"""

    def __init__(self, code: str, detail: str):
        self.code = code
        self.detail = detail
        super().__init__(f"{code}: {detail}")


# ─── 状态机 ────────────────────────────────────────────────────────────────

def can_transition(current: str, target: str) -> bool:
    """状态流转合法性（同态视为合法，由调用方决定是否空操作）。"""
    return target == current or target in DOC_NEXT.get(current, ())


def assert_transition(current: str, target: str) -> None:
    if not can_transition(current, target):
        raise RuleError(
            ILLEGAL_TRANSITION,
            f"不允许 {current} → {target}；合法目标: {list(DOC_NEXT.get(current, ()))}",
        )


def assert_draft(status: str) -> None:
    """修改前置：仅 draft 可改（确认后锁死）。"""
    if status != "draft":
        raise RuleError(NOT_DRAFT, f"当前状态 {status} 不可修改；确认后如需变更请作废并复制重开")


def assert_derivable(source_status: str, source_no: str = "") -> None:
    """派生前置：**仅已确认（issued）单证可被参考提取**。

    理由：未确认的前单数据仍在变动，且流程尚未走到，提取过来只会制造
    "单证间不一致"（信用证下是致命不符点）。与 issued 冻结机制形成闭环：
    只有不会变的数据才允许被引用。
    """
    if source_status != "issued":
        raise RuleError(
            SOURCE_NOT_CONFIRMED,
            f"源单证{f'「{source_no}」' if source_no else ''}状态为 {source_status}，"
            f"仅已确认（issued）的单证可作为派生依据",
        )


# ─── 金额 ──────────────────────────────────────────────────────────────────

def to_decimal(value: Any) -> Decimal | None:
    """宽容转 Decimal：None/空串 → None；非法值抛 RuleError。"""
    if value is None or value == "":
        return None
    if isinstance(value, Decimal):
        return value
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError) as exc:
        raise RuleError(ITEMS_INVALID, f"数值格式非法: {value!r}") from exc


def line_amount(qty: Any, unit_price: Any, nd: int = AMOUNT_DECIMALS) -> Decimal:
    """行金额 = 数量 × 单价（ROUND_HALF_UP 逐级落定）。"""
    q, p = to_decimal(qty), to_decimal(unit_price)
    if q is None or p is None:
        raise RuleError(ITEMS_INVALID, "行金额计算需要数量与单价")
    return (q * p).quantize(Decimal(1).scaleb(-nd), rounding=ROUND_HALF_UP)


def check_line_amount(item: Mapping[str, Any], nd: int = AMOUNT_DECIMALS) -> Decimal:
    """校验并返回行金额：若请求带了 line_amount，须与 qty×price 一致。"""
    qty = item.get("qty")
    unit_price = item.get("unit_price")
    if qty is None or unit_price is None:
        # 允许询价场景：数量或单价暂缺
        provided = to_decimal(item.get("line_amount"))
        return provided if provided is not None else Decimal(0)
    calc = line_amount(qty, unit_price, nd)
    provided = to_decimal(item.get("line_amount"))
    if provided is not None and abs(provided - calc) > Decimal(1).scaleb(-nd):
        raise RuleError(
            ITEMS_INVALID,
            f"行「{item.get('product_name', '')}」金额不一致："
            f"请求 {provided} ≠ 数量×单价 {calc}",
        )
    return calc


# ─── 行项目校验 ────────────────────────────────────────────────────────────

@dataclass
class ItemCheck:
    ok: bool = True
    issues: list[str] = field(default_factory=list)

    def fail(self, msg: str) -> None:
        self.ok = False
        self.issues.append(msg)


def validate_items(items: Sequence[Mapping[str, Any]]) -> ItemCheck:
    """行项目校验：品名必填、数量>0、金额勾稽。"""
    result = ItemCheck()
    if not items:
        result.fail("至少一行商品明细")
        return result
    for i, it in enumerate(items, 1):
        name = str(it.get("product_name") or "").strip()
        if not name:
            result.fail(f"第{i}行：品名必填")
        qty = to_decimal(it.get("qty"))
        if qty is None or qty <= 0:
            result.fail(f"第{i}行（{name or '?'}）：数量须为正数")
        price = to_decimal(it.get("unit_price"))
        if price is not None and price < 0:
            result.fail(f"第{i}行（{name or '?'}）：单价不能为负")
        try:
            check_line_amount(it)
        except RuleError as exc:
            result.fail(f"第{i}行：{exc.detail}")
    return result


# ─── 确认必填 ──────────────────────────────────────────────────────────────

# 各单证类型确认前必须具备的字段（raw_payload.custom 顶层键）
DOC_REQUIRED: dict[str, tuple[str, ...]] = {
    "quotation": ("quote_no", "quote_date", "items"),
    "pi": ("payment_terms",),
    "ci": (),
    "pl": (),
    "co": (),
    "contract": (),
    "bl": (),
    "insurance": (),
    "other": (),
}


def validate_confirm(doc_type: str, payload: Mapping[str, Any], items: Sequence[Mapping[str, Any]]) -> ItemCheck:
    """确认前必填校验：空 issues = 可确认（issued）。"""
    result = validate_items(items)
    custom = dict(payload.get("custom") or {})

    # 买方识别：customer_id 或手工买方名，至少其一
    has_buyer = bool(
        payload.get("customer_id")
        or custom.get("buyer")
        or custom.get("buyer_name")
        or (payload.get("sources") or {}).get("order")
        or (payload.get("sources") or {}).get("quote")
    )
    if not has_buyer:
        result.fail("缺少买方信息（客户或手工买方）")

    for key in DOC_REQUIRED.get(doc_type, ()):
        if key == "items":
            continue  # 已由 validate_items 覆盖
        if not custom.get(key):
            result.fail(f"确认前请补齐：{key}")

    return result
