"""单证数据装配（共享版）—— 纯函数、零三方依赖。

orchestrator 与 Worker 共用；任何适配层不得另写一份判定。
与 kaas_common.trade_doc.rules 同一原则。
"""
from typing import Any, Optional

__all__ = [
    "DOC_NO_FIELDS", "TRADE_TERM_FIELDS", "item_from_source",
    "buyer_block", "seller_block", "clean", "trade_terms_of", "build_render_data",
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
    "non_wood_packing": ("declaration_no", "declaration_date"),
    "weight_list": ("weight_list_no", "weight_list_date"),
    "quality_cert": ("quality_cert_no", "quality_cert_date"),
    "manufacturer_cert": ("mfr_cert_no", "mfr_cert_date"),
    "bl": ("bl_no", None),
    "co": ("co_no", None),
    "insurance": ("policy_no", None),
    "customs_declaration": ("customs_decl_no", "customs_decl_date"),
    "fumigation_cert": ("fumi_cert_no", "fumi_cert_date"),
    "other": (None, None),
}

TRADE_TERM_FIELDS = (
    "incoterm", "payment_terms", "port_of_loading",
    "port_of_destination", "shipping_marks", "country_of_origin",
)

_SPEC_FIELDS = ("specification", "hs_code", "package", "gross_weight", "net_weight", "volume")


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
        data[key] = value
    return data
