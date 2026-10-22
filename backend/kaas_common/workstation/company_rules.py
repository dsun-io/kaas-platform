"""企业抬头 / 收款信息规则（两端共用，纯函数 / 标准库）。

用户口径（2026-10-18）：
  · 企业抬头设置区只允许**团队管理员**修改（权限判定在调用方，本文件只做字段规则）；
  · PNG 公章沿用既有 `validate_seal_image`；
  · SWIFT/BIC 必须是 8 位或 11 位字母数字（银行主码 4 + 国家 2 + 地区 2 + 可选分行 3）。
"""
from __future__ import annotations

import re
from typing import Optional

__all__ = ["normalize_swift", "SwiftError", "normalize_tax_id", "TaxIdError"]

_SWIFT_RE = re.compile(r"^[A-Z0-9]{8}([A-Z0-9]{3})?$")
# 统一社会信用代码 18 位；这里放宽到 6–32 位字母/数字（境外税号也走同一列）
_TAX_ID_RE = re.compile(r"^[0-9A-Z]{6,32}$")
_TAX_ID_DETAIL = "税号必须是 6–32 位字母/数字（统一社会信用代码 18 位）"


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


class TaxIdError(ValueError):
    """税号不合法（错误码/提示与 TS 门面 normalizeTaxId 逐字一致）。"""

    def __init__(self, code: str = "INVALID_TAX_ID", detail: str = _TAX_ID_DETAIL):
        super().__init__(detail)
        self.code = code
        self.detail = detail


def normalize_tax_id(value: Optional[str]) -> Optional[str]:
    """空 → None；合法 → 去空格转大写；非法 → TaxIdError。

    用户口径（2026-10-22）：税号列存**规范化后的统一大写**，避免同一税号
    "大小写两副面孔"；空串/纯空白按"未填"处理（列可空），不是校验错误。
    """
    if value is None:
        return None
    text = str(value).strip().upper()
    if not text:
        return None
    if not _TAX_ID_RE.match(text):
        raise TaxIdError(detail=_TAX_ID_DETAIL)
    return text
