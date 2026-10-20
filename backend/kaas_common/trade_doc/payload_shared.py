"""单证数据装配（共享版）—— 纯函数、零三方依赖。

orchestrator 与 Worker 共用；任何适配层不得另写一份判定。
与 kaas_common.trade_doc.rules 同一原则。
"""
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import Any, Optional

__all__ = [
    "DOC_NO_FIELDS", "TRADE_TERM_FIELDS", "item_from_source",
    "buyer_block", "seller_block", "clean", "trade_terms_of", "build_render_data",
    "PROTECTED_CUSTOM_FIELDS", "protected_custom_fields", "diff_custom", "append_audit",
    "AUDIT_KEY",
    # A5-W2：draft 单的行项受控覆盖通道（custom.items_override）
    "ITEMS_OVERRIDE_KEYS", "ITEMS_OVERRIDE_AMOUNT_KEYS",
    "items_override_of", "validate_items_override", "apply_items_override",
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
    # A10 P2：字段名与 frontend manifest 逐字一致
    "vessel_cert": ("cert_no", "cert_date"),
    "export_license": ("license_no", "license_date"),
    "ciq": ("cert_no", "cert_date"),
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


# ── A5-W2：draft 单行项受控覆盖（`custom.items_override`）────────────────────
#
# 背景（2026-10-21 b-accept 取证）：`custom.items` 被 PROTECTED_CUSTOM_FIELDS 硬拒，
# 渲染又只认 sources —— 于是"批量编辑行项"要么改 sources（绕过 A7 护栏、不进审计），
# 要么根本改不了。裁决 A：新增**受控通道** —— 允许 draft 单在 custom 里挂
# `items_override`，由内核在**副本**上覆盖渲染行项；被覆盖行的事实标
# manual/unverified（签发时被 FACT_UNVERIFIED 拦住，与"改完要确认"一致）。
#
# 契约（固定，前端 `lib/trade-doc/item-batch.ts` 已按此实现）：
#   items_override = [{index, qty?, unit_price?, unit?, spec?, origin?}]
# - 仅 draft（非 draft 由调用方报 422 ITEMS_OVERRIDE_DRAFT_ONLY）；
# - index 必填、自然数、**不得越界**（422 ITEMS_OVERRIDE_INDEX）；
# - 不接受金额键（amount/line_amount/total_amount/line_total）——
#   金额只能由 数量×单价 推导（422 ITEMS_OVERRIDE_AMOUNT_FORBIDDEN）；
# - qty>0、unit_price≥0（与内核 `validate_items` 同口径）。
ITEMS_OVERRIDE_KEYS = ("index", "qty", "unit_price", "unit", "spec", "origin")
ITEMS_OVERRIDE_AMOUNT_KEYS = ("amount", "line_amount", "total_amount", "line_total")
_OVERRIDE_AMOUNT_QUANT = Decimal("0.0001")


def items_override_of(custom) -> list:
    """从 custom 取 `items_override`（非数组/缺失 → []；空数组=清除覆盖）。"""
    if not isinstance(custom, dict):
        return []
    raw = custom.get("items_override")
    return list(raw) if isinstance(raw, list) else []


def _is_number(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _override_amount(qty, unit_price):
    """行金额一律由 数量×单价 重算（4 位，与前端 item-batch 同口径）。"""
    try:
        amount = Decimal(str(qty)) * Decimal(str(unit_price))
        return float(amount.quantize(_OVERRIDE_AMOUNT_QUANT, rounding=ROUND_HALF_UP))
    except (InvalidOperation, ValueError, TypeError):
        return None


def validate_items_override(override, *, item_count: Optional[int] = None) -> Optional[dict]:
    """校验 `items_override`；非法返回 `{code, detail}`，合法返回 None。

    **不做 draft 判定**（那是端点层：`doc.status != "draft"` ⇒ 422
    `ITEMS_OVERRIDE_DRAFT_ONLY`）—— 纯函数只校验结构与行号，便于内核/前端同口径。
    """
    if not isinstance(override, list):
        return {"code": "ITEMS_OVERRIDE_INDEX", "detail": "items_override 必须是数组"}
    for position, entry in enumerate(override):
        if not isinstance(entry, dict):
            return {
                "code": "ITEMS_OVERRIDE_INDEX",
                "detail": f"items_override[{position}] 必须是对象",
            }
        for key in ITEMS_OVERRIDE_AMOUNT_KEYS:
            if key in entry:
                return {
                    "code": "ITEMS_OVERRIDE_AMOUNT_FORBIDDEN",
                    "detail": f"行项覆盖不接受金额字段（{key}）：金额只能由 数量×单价 推导",
                }
        index = entry.get("index")
        if not isinstance(index, int) or isinstance(index, bool) or index < 0:
            return {
                "code": "ITEMS_OVERRIDE_INDEX",
                "detail": f"行项下标非法：{index!r}（必须是非负整数）",
            }
        if item_count is not None and index >= item_count:
            return {
                "code": "ITEMS_OVERRIDE_INDEX",
                "detail": f"行项下标越界：{index}（本单共 {item_count} 行）",
            }
        if "qty" in entry and not (_is_number(entry["qty"]) and entry["qty"] > 0):
            return {
                "code": "ITEMS_OVERRIDE_QTY",
                "detail": f"行项覆盖数量必须为正数：{entry.get('qty')!r}",
            }
        if "unit_price" in entry and not (
            _is_number(entry["unit_price"]) and entry["unit_price"] >= 0
        ):
            return {
                "code": "ITEMS_OVERRIDE_PRICE",
                "detail": f"行项覆盖单价不能为负：{entry.get('unit_price')!r}",
            }
        for key in ("unit", "spec", "origin"):
            if key in entry and not isinstance(entry[key], str):
                return {
                    "code": "ITEMS_OVERRIDE_VALUE",
                    "detail": f"行项覆盖 {key} 必须是字符串",
                }
    return None


def apply_items_override(items, override) -> list:
    """在行项**副本**上应用覆盖（不改入参）；返回新列表。

    映射与前端/MSW 同口径：`unit→qty_unit`、`spec→specification`、
    `origin→country_of_origin`；`line_amount` 由 数量×单价 重算（不读调用方金额）。
    """
    rows = [
        dict(row) if isinstance(row, dict) else row
        for row in (items or [])
    ]
    for entry in items_override_of({"items_override": list(override or [])}):
        if not isinstance(entry, dict):
            continue
        index = entry.get("index")
        if not isinstance(index, int) or isinstance(index, bool) or not (0 <= index < len(rows)):
            continue
        row = rows[index]
        if not isinstance(row, dict):
            continue
        changed_amount = False
        if "qty" in entry and _is_number(entry["qty"]):
            row["qty"] = entry["qty"]
            changed_amount = True
        if "unit_price" in entry and _is_number(entry["unit_price"]):
            row["unit_price"] = entry["unit_price"]
            changed_amount = True
        if isinstance(entry.get("unit"), str):
            row["qty_unit"] = entry["unit"]
        if isinstance(entry.get("spec"), str):
            row["specification"] = entry["spec"]
        if isinstance(entry.get("origin"), str):
            row["country_of_origin"] = entry["origin"]
        if changed_amount:
            amount = _override_amount(row.get("qty"), row.get("unit_price"))
            if amount is not None:
                row["line_amount"] = amount
    return rows


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
    # A5-W2：draft 单的行项覆盖应用到**副本**（sources 不动；行金额重算）
    override = items_override_of(custom)
    if override and items:
        items = apply_items_override(items, override)
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
        if key in PROTECTED_CUSTOM_FIELDS or key == "items_override":
            # 受保护字段不接受 custom 覆盖：金额/行项只能来自上游快照或系统计算。
            # 写路径已拒绝（422），这里再挡一次 —— 历史脏数据也骗不了渲染。
            # `items_override` 是**受控通道**（已按契约校验并应用到行项副本），
            # 不作为一个顶层渲染键输出。
            continue
        data[key] = value
    return data
