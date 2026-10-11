"""报价单/订单/单证状态机 —— 纯函数、零三方依赖（stdlib only）。

orchestrator 与 Worker 共用；任何适配层不得另写一份判定。
"""
from typing import Any

__all__ = [
    "QUOTE_NEXT", "ORDER_NEXT", "SHIPMENT_NEXT", "DOC_STATUS", "DOC_NEXT",
    "can_transition", "assert_transition", "assert_draft",
]


QUOTE_NEXT = {
    "draft": ("sent", "expired"),
    "sent": ("accepted", "rejected", "expired"),
    "accepted": (),
    "rejected": (),
    "expired": (),
}

ORDER_NEXT = {
    "pending": ("confirmed", "cancelled"),
    "confirmed": ("producing", "cancelled"),
    "producing": ("shipped", "cancelled"),
    "shipped": ("completed",),
    "completed": (),
    "cancelled": (),
}

DOC_STATUS = ("draft", "issued", "void")
DOC_NEXT = {
    "draft": ("issued", "void"),
    "issued": ("void",),
    "void": (),
}

# 出运状态机（§10.6）：booking→in_transit→arrived→customs→delivered。
# 原先只写在 orchestrator 的 api/shipments.py 里；补线上出运台账时若照抄一份，
# 就会出现「本地能流转、线上 409」这类漂移，故上收到共享内核。
SHIPMENT_NEXT = {
    "booking": ("in_transit",),
    "in_transit": ("arrived",),
    "arrived": ("customs",),
    "customs": ("delivered",),
    "delivered": (),
}

_TABLES = {
    "quote": QUOTE_NEXT,
    "order": ORDER_NEXT,
    "doc": DOC_NEXT,
    "shipment": SHIPMENT_NEXT,
}


def can_transition(kind: str, current: str, target: str) -> bool:
    """校验状态流转合法性。kind: quote | order | doc | shipment。"""
    if target == current:
        return True
    table = _TABLES.get(kind, {})
    return target in table.get(current, ())


def assert_transition(kind: str, current: str, target: str) -> None:
    if not can_transition(kind, current, target):
        table = _TABLES.get(kind, {})
        allowed = list(table.get(current, ()))
        raise ValueError(f"不允许 {current} → {target}；合法目标: {allowed}")


def assert_draft(status: str) -> None:
    """修改前置：仅 draft 可改（确认后锁死）。"""
    if status != "draft":
        raise ValueError(f"当前状态 {status} 不可修改；确认后如需变更请作废并复制重开")
