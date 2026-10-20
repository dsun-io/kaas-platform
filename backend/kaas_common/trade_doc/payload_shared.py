"""单证数据装配（共享版）—— 纯函数、零三方依赖。

orchestrator 与 Worker 共用；任何适配层不得另写一份判定。
与 kaas_common.trade_doc.rules 同一原则。
"""
from typing import Any, Optional

__all__ = [
    "DOC_NO_FIELDS", "TRADE_TERM_FIELDS", "item_from_source",
    "buyer_block", "seller_block", "clean", "trade_terms_of", "build_render_data",
    "PROTECTED_CUSTOM_FIELDS", "protected_custom_fields", "diff_custom", "append_audit",
    "AUDIT_KEY",
]

DOC_NO_FIELDS = {
    "quotation": ("quote_no", "quote_date"),
    "pi": ("pi_no", "pi_date"),
    "contract": ("contract_no", "contract_date"),
    "ci": ("invoice_no", "invoice_date"),
    "pl": ("pl_no", "pl_date"),
    "shipping_advice": ("advice_no", "advice_date"),
    "draft": ("draft_no", "draft_date"),
    "beneficiary_cert": ("cert_no", "cert_date"),
    # A10：字段名与 frontend/src/lib/trade-doc/manifest.json 逐字一致
    "beneficiary_decl": ("declaration_no", "declaration_date"),
    "non_wood_packing": ("declaration_no", "declaration_date"),
    "weight_list": ("weight_list_no", "weight_list_date"),
    "quality_cert": ("quality_cert_no", "quality_cert_date"),
    "manufacturer_cert": ("mfr_cert_no", "mfr_cert_date"),
    "bl": ("bl_no", None),
    "co": ("co_no", None),
    "insurance": ("policy_no", None),
    "customs_declaration": ("customs_decl_no", "customs_decl_date"),
    "fumigation_cert": ("fumi_cert_no", "fumi_cert_date"),
    "saso_coc": ("cert_no", "cert_date"),
    "other": (None, None),
}

TRADE_TERM_FIELDS = (
    "incoterm", "payment_terms", "port_of_loading",
    "port_of_destination", "shipping_marks", "country_of_origin",
)

_SPEC_FIELDS = ("specification", "hs_code", "package", "gross_weight", "net_weight", "volume")

# ── 手工内容（custom）的边界 ────────────────────────────────────────────────
#
# 2026-10-11 用户裁决：`custom` **不得覆盖行项与总金额**。
# 背景：装配顺序是「上游快照 → 企业主体 → 默认条款 → custom 最后覆盖」，
# 因此 custom 能盖掉任何键 —— 包括 `items` / `total_amount`。
# 一份对外单据的**金额若可被手填内容改写**，单证与订单就对不上，
# 而银行/海关正是按这两项审单。所以它们只能来自上游快照或系统计算。
#
# 两层防护（缺一不可）：
# 1. 写路径显式拒绝（orchestrator / worker 的 POST、PATCH）→ 不让脏数据落库；
# 2. `build_render_data` 再跳过一遍 → 即便库里已有历史脏数据，**渲染出来的单据也不会被骗**。
PROTECTED_CUSTOM_FIELDS = ("items", "total_amount")

AUDIT_KEY = "_audit"
_AUDIT_MAX = 20


def protected_custom_fields(custom) -> list:
    """custom 里试图覆盖受保护字段的键（升序）。非 dict / 空 → 空列表。"""
    if not isinstance(custom, dict):
        return []
    return sorted(k for k in PROTECTED_CUSTOM_FIELDS if k in custom)


def _value_digest(value):
    """审计里**不存原值**：图片是 data URI（一张 PI 约 1.4MB），抄进审计会把它撑爆。
    长字符串/容器只留摘要，短标量原样保留 —— 审计是给"谁改了什么"用的，不是备份。"""
    if isinstance(value, str):
        return value if len(value) <= 64 else f"<str {len(value)} chars>"
    if isinstance(value, (dict, list)):
        return f"<{type(value).__name__} {len(value)}>"
    return value


def diff_custom(before, after) -> dict:
    """逐字段 diff（只比 custom 子集）：`{field: {"from": …, "to": …}}`；无改动 → {}"""
    before = before if isinstance(before, dict) else {}
    after = after if isinstance(after, dict) else {}
    changed = {}
    for key in sorted(set(before) | set(after)):
        if before.get(key) != after.get(key):
            changed[key] = {"from": _value_digest(before.get(key)),
                            "to": _value_digest(after.get(key))}
    return changed


def append_audit(payload, *, previous_payload, actor_id, before_custom, after_custom, at):
    """返回**新** payload：把这次 custom 改动追加到 `_audit`（最多 20 条，最新在末尾）。

    - 审计只从 `previous_payload` 续写：**新 payload 里客户端自带的 `_audit` 一律丢弃**
      （否则调用方可以伪造/清空自己的审计）。
    - 无实际改动则不新增条目（避免"点一次保存就多一条"的噪音）。
    """
    new = dict(payload or {})
    new.pop(AUDIT_KEY, None)
    entries = [e for e in ((previous_payload or {}).get(AUDIT_KEY) or [])
               if isinstance(e, dict)]
    changed = diff_custom(before_custom, after_custom)
    if changed:
        entries.append({"at": at, "by": actor_id, "changed": changed})
    new[AUDIT_KEY] = entries[-_AUDIT_MAX:]
    return new


def _clean(value):
    if value is None:
        return None
    if isinstance(value, str) and not value.strip():
        return None
    return value


def _spec_to_text(spec):
    if not spec:
        return None
    if isinstance(spec, str):
        return spec.strip() or None
    if not isinstance(spec, dict):
        return None
    parts = []
    for key in ("specification", "spec", "size", "mesh", "wire_diameter", "height", "length"):
        value = _clean(spec.get(key))
        if value is not None:
            parts.append(str(value))
    if parts:
        return ", ".join(parts)
    fallback = [f"{k}: {v}" for k, v in spec.items() if _clean(v) is not None]
    return ", ".join(fallback) or None


def item_from_source(raw):
    spec = raw.get("spec_snapshot") if isinstance(raw, dict) else None
    item = {
        "product_name": raw.get("product_name"),
        "qty": raw.get("qty"),
        "qty_unit": raw.get("qty_unit"),
        "unit_price": raw.get("unit_price"),
        "line_amount": raw.get("line_amount"),
    }
    item["specification"] = _spec_to_text(spec)
    if isinstance(spec, dict):
        for field in _SPEC_FIELDS:
            if field == "specification":
                continue
            value = _clean(spec.get(field))
            if value is not None:
                item[field] = value
    for field in _SPEC_FIELDS:
        value = _clean(raw.get(field))
        if value is not None:
            item[field] = value
    return {k: v for k, v in item.items() if v is not None}


def buyer_block(customer, contact=None):
    out = {}
    if customer is None:
        return out
    src = customer if isinstance(customer, dict) else {}
    for field in ("name", "address", "country", "phone", "email"):
        value = _clean(src.get(field)) if isinstance(customer, dict) else _clean(getattr(customer, field, None))
        if value is not None:
            out[field] = value
    if contact is not None:
        cname = _clean(contact.get("name")) if isinstance(contact, dict) else _clean(getattr(contact, "name", None))
        cpos = _clean(contact.get("position")) if isinstance(contact, dict) else _clean(getattr(contact, "position", None))
        if cname:
            out["contact"] = cname
        if cpos:
            out["contact_position"] = cpos
    return out


def seller_block(profile):
    """企业主体信息 → 单证渲染器认识的卖方区块。

    渲染器对卖方区块的字段名是固定的（company/address/phone/email/bank/account/swift），
    这里做一次**显式映射**，避免渲染层与数据库列名耦合。

    真源原先只在 orchestrator 的 `app/api/company_profile.py`（操作 ORM 对象）；
    Worker 的单证装配也要同一份映射，故上收到共享内核并兼容 dict 行
    （Worker 的 db 封装返回 dict）。两处各写一份必然漂移：改了字段名只有一端生效。
    """
    if profile is None:
        return {}

    def get(field):
        if isinstance(profile, dict):
            return profile.get(field)
        return getattr(profile, field, None)

    out = {}
    for key, field in (
        ("company", "name_en"), ("address", "address_en"),
        ("phone", "phone"), ("email", "email"),
        ("bank", "bank_name"), ("account", "bank_account"),
        ("swift", "swift_code"),
    ):
        value = _clean(get(field))
        if value is not None:
            out[key] = value
    return out


def clean(value):
    """空串/纯空白视为 None（写入快照前统一过滤，避免前端拿到空字符串）。"""
    return _clean(value)


def trade_terms_of(source):
    out = {}
    if source is None:
        return out
    data = source if isinstance(source, dict) else {}
    for field in TRADE_TERM_FIELDS:
        value = _clean(data.get(field))
        if value is not None:
            out[field] = value
    return out


def build_render_data(
    *,
    doc_type,
    doc_no,
    doc_status,
    currency,
    total_amount,
    created_at=None,
    issued_at=None,
    seller=None,
    buyer=None,
    bank_info=None,
    sources=None,
    trade_terms=None,
    custom=None,
    defaults=None,
):
    data = {}
    for key, value in (defaults or {}).items():
        if _clean(value) is not None:
            data[key] = value
    sources = sources or {}
    upstream = sources.get("order") or sources.get("quote") or {}
    items = [item_from_source(i) for i in (upstream.get("items") or [])]
    if items:
        data["items"] = items
    if _clean(upstream.get("currency")) is not None:
        data["currency"] = upstream["currency"]
    for key, value in (trade_terms or {}).items():
        data[key] = value
    if seller:
        data["seller"] = seller
        data["shipper"] = seller
        data["exporter"] = seller
    if buyer:
        data["buyer"] = buyer
        data["consignee"] = buyer
        data["insured"] = buyer
    if bank_info:
        data["bank_info"] = bank_info
    no_field, date_field = DOC_NO_FIELDS.get(doc_type, (None, None))
    if no_field:
        data[no_field] = doc_no
    if date_field:
        data[date_field] = issued_at or created_at
    data["currency"] = data.get("currency") or currency
    if _clean(total_amount) is not None:
        data["total_amount"] = total_amount
    for key, value in (custom or {}).items():
        if key in PROTECTED_CUSTOM_FIELDS:
            # 受保护字段不接受 custom 覆盖：金额/行项只能来自上游快照或系统计算。
            # 写路径已拒绝（422），这里再挡一次 —— 历史脏数据也骗不了渲染。
            continue
        data[key] = value
    return data
