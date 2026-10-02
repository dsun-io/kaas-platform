"""单号规则 —— {TYPE}-{YYYYMM}-{SEQ:04d}（纯函数）。

与 api/ws_common.next_doc_no 的取号格式保持一致：内核只负责**格式**，
序列分配（doc_sequences 事务取号）留在适配层（DB 访问各后端不同）。
"""
from __future__ import annotations

from datetime import date, datetime

# 单证/单据类型 → 前缀（§10.7；未列出类型用前三位大写兜底）
DOC_TYPE_PREFIX: dict[str, str] = {
    "quotation": "QUO",
    "pi": "PI",
    "contract": "CON",
    "ci": "CI",
    "pl": "PL",
    "bl": "BL",
    "co": "CO",
    "insurance": "INS",
    "other": "DOC",
    "order": "ORD",
    "shipment": "SHP",
}


def doc_no_prefix(doc_type: str) -> str:
    return DOC_TYPE_PREFIX.get(doc_type, (doc_type or "DOC").upper()[:3])


def format_doc_no(doc_type: str, when: date | datetime, seq: int) -> str:
    """格式化单号：PI-202609-0001。seq 从 1 起、补足 4 位。"""
    prefix = doc_no_prefix(doc_type)
    yyyymm = when.strftime("%Y%m")
    return f"{prefix}-{yyyymm}-{seq:04d}"


def month_of(doc_no: str) -> str | None:
    """从单号解析 YYYYMM（失败返回 None）。"""
    parts = (doc_no or "").split("-")
    if len(parts) < 3:
        return None
    yyyymm = parts[-2]
    return yyyymm if len(yyyymm) == 6 and yyyymm.isdigit() else None
