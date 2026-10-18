"""企业抬头 / 收款信息规则（两端共用，纯函数 / 标准库）。

用户口径（2026-10-18）：
  · 企业抬头设置区只允许**团队管理员**修改（权限判定在调用方，本文件只做字段规则）；
  · PNG 公章沿用既有 `validate_seal_image`；
  · SWIFT/BIC 必须是 8 位或 11 位字母数字（银行主码 4 + 国家 2 + 地区 2 + 可选分行 3）。
"""
from __future__ import annotations

import re
from typing import Optional

__all__ = ["normalize_swift", "SwiftError"]

_SWIFT_RE = re.compile(r"^[A-Z0-9]{8}([A-Z0-9]{3})?$")


class SwiftError(ValueError):
    """SWIFT 编码不合法。"""


def normalize_swift(value: Optional[str]) -> Optional[str]:
    """空 → None；合法 → 大写规范化；非法 → SwiftError。"""
    if value is None:
        return None
    text = str(value).strip().upper().replace(" ", "")
    if not text:
        return None
    if not _SWIFT_RE.match(text):
        raise SwiftError("SWIFT 编码必须是 8 位或 11 位字母/数字（如 BKCHCNBJ 或 BKCHCNBJ220）")
    return text
