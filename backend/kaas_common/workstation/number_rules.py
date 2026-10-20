"""单据/报价/询盘编号的编辑规则（两端共用，纯函数）。

用户口径（2026-10-18）：
  · 编号默认由系统**自动生成**（生成时即带出）；
  · 下游单据/报价生成之前，可以手动修改，但必须经过二次确认；
  · 一旦下游已生成，编号锁定，不可再改：
      - 询盘：生成报价（报价单）后锁定；
      - 报价：生成 PI 等后续单证后锁定（仅报价单本身不算下游）；
      - 单证：同一链条上生成更晚的单证后锁定。
"""
from __future__ import annotations

import re
from datetime import datetime
from typing import Any, Mapping, Optional

from .inquiry_rules import derive_customer_abbr, normalize_abbr, sanitize_country

__all__ = [
    "normalize_number",
    "NumberError",
    "DOC_TYPE_PREFIX",
    "build_number",
    "customer_token",
]

# 类型代码 —— 与前端/单证前缀一致（PI / QUO / CI / PL ...）
DOC_TYPE_PREFIX = {
    "quotation": "QUO", "pi": "PI", "contract": "CON", "ci": "CI", "pl": "PL",
    "shipping_advice": "SA", "draft": "DR", "beneficiary_cert": "BEN",
    # A10：受益声明用 BD（fixture `declaration_no = BD-2026-0001`）；SASO/COC 用 COC（与 BEN/QC/MC 区分）
    "beneficiary_decl": "BD",
    "non_wood_packing": "NWP", "weight_list": "WL", "quality_cert": "QC",
    "manufacturer_cert": "MC", "bl": "BL", "co": "CO", "insurance": "INS",
    "customs_declaration": "CD", "fumigation_cert": "FUM", "saso_coc": "COC",
    # A10 P2：船公司证明 VC / 出口许可证 EL / 商检证书 CIQ
    "vessel_cert": "VC", "export_license": "EL", "ciq": "CIQ",
    "other": "DOC", "order": "ORD", "shipment": "SHP",
    "inquiry": "INQ",
}

_TOKEN_RE = re.compile(r"[^A-Z0-9]")
MAX_CUSTOMER_TOKEN = 8

# 编号允许：字母/数字/中文 + 常见分隔符；不允许空白与控制字符。
# ⚠️ 2026-10-19 回归修复：7b21e1d 重写本文件时丢了这两个常量，但 normalize_number()
# 仍在用它们 ⇒ 任何「手改编号」请求在 orchestrator / worker 两侧都会 NameError→500。
# 由 CRM parity 审计实测发现（normalize_number('INQ-1') 直接抛 NameError）。
_NUMBER_RE = re.compile(r"^[\w\u4e00-\u9fff][\w\u4e00-\u9fff._/#-]*$", re.UNICODE)
MAX_LEN = 64


def customer_token(customer: Any) -> str:
    """从客户档案生成编号里的客户段：显式缩写 > 拉丁词首 > C{id}。"""
    if customer is None:
        return "C"
    if isinstance(customer, Mapping):
        get = customer.get
    else:
        def get(key, default=None):
            return getattr(customer, key, default)
    abbr = normalize_abbr(get("abbr"))
    if abbr:
        return abbr
    token = derive_customer_abbr(
        get("name") or get("company_name"), get("id") or get("customer_id"),
    )
    token = _TOKEN_RE.sub("", str(token).upper())
    return (token or "C")[:MAX_CUSTOMER_TOKEN]


def build_number(
    doc_type: str,
    customer: Any = None,
    created_at: Optional[datetime] = None,
    *,
    suffix: int = 0,
) -> str:
    """统一编号：`类型-国家-客户-时间戳`。

    例：`PI-US-TIM-20261018193045`
      · 类型：`DOC_TYPE_PREFIX`（PI/QUO/CI/INQ/ORD/SHP…）
      · 国家：客户档案 country 的 ISO2（空/不合法 → `XX`）
      · 客户：客户缩写 > 拉丁词首（最多 8 位）> `C{id}`
      · 时间戳：本地时间 yyyyMMddHHmmss；同秒冲突由调用方用 `-2/-3` 重试
    """
    prefix = DOC_TYPE_PREFIX.get(doc_type, doc_type.upper()[:3])
    country = "XX"
    if customer is not None:
        country = sanitize_country(
            customer.get("country") if isinstance(customer, Mapping)
            else getattr(customer, "country", None)
        )
    ts = (created_at or datetime.now()).strftime("%Y%m%d%H%M%S")
    base = f"{prefix}-{country}-{customer_token(customer)}-{ts}"
    return base if suffix <= 1 else f"{base}-{suffix}"


class NumberError(ValueError):
    """编号不合法。"""


def normalize_number(value: Optional[str]) -> str:
    """去空白并校验；空/非法 → NumberError。

    手改也允许中文（如“报价-张工”），但不允许空格和换行 —— 单据号进单证/文件名，
    空白会让打印与文件命名出现不可见差异。
    """
    text = str(value or "").strip()
    if not text:
        raise NumberError("编号不能为空；留空时应由系统自动生成")
    if len(text) > MAX_LEN:
        raise NumberError(f"编号不能超过 {MAX_LEN} 个字符")
    if not _NUMBER_RE.match(text):
        raise NumberError("编号只能包含字母/数字/中文及 . _ / # -，不能含空格或控制字符")
    return text
