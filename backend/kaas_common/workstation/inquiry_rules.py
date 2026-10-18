"""询盘编号规则（orchestrator 与 Worker 共用，纯函数 / 标准库）。

需求（2026-10-18 用户确认）：询盘编号格式

    `国家ISO2-客户缩写-yyyyMMddHHmmss`

例：`US-ABC-20261018170900`

- 国家：客户档案 `country` 的 ISO2（US/DE/AU…）；空或非 2 位字母 → `XX`；
- 客户缩写：`customers.abbr`（2-6 位大写字母）；空则用客户名中的拉丁词首
  （最多 3 位）；仍为空则 `C{customer_id}`；
- 时间戳：本地时间 `yyyyMMddHHmmss`；同秒冲突由调用方追加 `-2/-3` 重试。

编号只在**创建询盘时**生成；存量询盘不回填（可空）。
"""
from __future__ import annotations

import re
from datetime import datetime
from typing import Optional

__all__ = [
    "normalize_abbr",
    "derive_customer_abbr",
    "build_inquiry_no",
    "sanitize_country",
]

_ABBR_RE = re.compile(r"[^A-Z0-9]")
_WORD_RE = re.compile(r"[A-Za-z]+")
_COUNTRY_RE = re.compile(r"^[A-Za-z]{2}$")


def normalize_abbr(raw: Optional[str]) -> Optional[str]:
    """客户缩写归一：大写、去掉非字母数字；长度不足 2 或超过 6 → None。

    返回 None 表示"没填/不合法"，调用方按客户名/客户 id 兜底。
    """
    if raw is None:
        return None
    text = _ABBR_RE.sub("", str(raw).strip().upper())
    if len(text) < 2 or len(text) > 6:
        return None
    return text


def derive_customer_abbr(name: Optional[str], customer_id: Optional[int] = None) -> str:
    """没有显式缩写时的兜底：拉丁词首（最多 3 位）→ `C{id}` → `'C'`。

    中文客户名没有拉丁词，会落到 `C{id}` —— 稳定、唯一、可读性一般；
    业务可在客户档案里维护一个更有意义的缩写。
    """
    words = _WORD_RE.findall(name or "")
    if words:
        initials = "".join(w[0] for w in words[:3]).upper()
        if len(initials) >= 2:
            return initials
        # 只有一个英文词（如 "ACME"）→ 取前 3 个字母
        if len(words[0]) >= 2:
            return words[0][:3].upper()
    if customer_id is not None:
        return f"C{customer_id}"
    return "C"


def sanitize_country(raw: Optional[str]) -> str:
    """国家转 ISO2；空/不合法 → `XX`。"""
    text = (raw or "").strip()
    if _COUNTRY_RE.match(text):
        return text.upper()
    return "XX"


def build_inquiry_no(
    country: Optional[str],
    abbr: Optional[str],
    created_at: Optional[datetime] = None,
    *,
    customer_name: Optional[str] = None,
    customer_id: Optional[int] = None,
    suffix: int = 0,
) -> str:
    """生成询盘编号；`suffix` ≥ 2 时追加 `-2/-3…` 处理同秒冲突。"""
    ts = (created_at or datetime.now()).strftime("%Y%m%d%H%M%S")
    code = normalize_abbr(abbr) or derive_customer_abbr(customer_name, customer_id)
    base = f"{sanitize_country(country)}-{code}-{ts}"
    return base if suffix <= 1 else f"{base}-{suffix}"
