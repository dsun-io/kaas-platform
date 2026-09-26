"""单证数据装配 —— 把「上游快照 + 企业主体 + 买方 + 手工填写」合成渲染数据。

业务位置
--------
    询盘 → 报价单 → 订单 → 单证
                 ↑        ↑
              谈定条款   继承条款

单证不是孤立表单，它必须**继承**上游谈定的内容（货描、规格、金额、贸易术语、付款方式），
否则就会出现「单证与合同不一致」——在信用证下这直接是「不符点」，会被银行拒付。

一致性策略（重要取舍）
----------------------
- **开单时冻结快照**：`trade_docs.raw_payload.sources` 保存上游当时的快照，
  上游后来改动**不会污染**已开出的单据（否则历史单据会失真）。
- **draft 阶段可重新带入**：未签发的单据允许从上游重新拉快照覆盖（见 refresh 端点）。
- **issued 阶段彻底冻结**：已签发单据是法律凭证，任何上游变更都不影响。

字段优先级（后者覆盖前者）
--------------------------
    单据默认值 → 上游条款 → 买方/卖方主体 → 手工填写(custom) → 单据自身金额

为什么手工填写优先：业务员在单据上手工改过的内容，不能被自动带入悄悄覆盖掉。
"""
from typing import Any, Optional

# 各单证类型的「本单编号 / 本单日期」字段名。
# 说明：模板里占位符的名字是按单证惯例定的（发票 $invoice_no、装箱单 $pl_no…），
# 不能用「第一个以 _no 结尾的字段」这类启发式规则去猜 —— 例如商业发票同时有
# contract_no / lc_no，猜错就会把合同号印成发票号。
DOC_NO_FIELDS: dict[str, tuple[Optional[str], Optional[str]]] = {
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

# 贸易条款字段：上游（报价单/订单）谈定的，单证要继承
TRADE_TERM_FIELDS = (
    "incoterm",
    "payment_terms",
    "port_of_loading",
    "port_of_destination",
    "shipping_marks",
    "country_of_origin",
)

# 行项里可由规格快照带出的字段（报关/装箱必需的申报要素）
_SPEC_FIELDS = ("specification", "hs_code", "package", "gross_weight", "net_weight", "volume")


def _clean(value: Any) -> Any:
    """空串视为"未填写"，避免覆盖上游值。"""
    if value is None:
        return None
    if isinstance(value, str) and not value.strip():
        return None
    return value


def _spec_to_text(spec: Any) -> Optional[str]:
    """规格快照 → 单行规格描述。

    规格在库里是 JSONB（结构化），但单据上必须是一行可读文本。
    取 known 字段优先，其余键值按 "键: 值" 拼接，跳过空值。
    """
    if not spec:
        return None
    if isinstance(spec, str):
        return spec.strip() or None
    if not isinstance(spec, dict):
        return None

    parts: list[str] = []
    for key in ("specification", "spec", "size", "mesh", "wire_diameter", "height", "length"):
        value = _clean(spec.get(key))
        if value is not None:
            parts.append(str(value))
    if parts:
        return ", ".join(parts)
    # 无 known 字段时退化为键值拼接（保证不丢信息，而不是渲染空白）
    fallback = [f"{k}: {v}" for k, v in spec.items() if _clean(v) is not None]
    return ", ".join(fallback) or None


def item_from_source(raw: dict) -> dict:
    """上游行项（订单/报价行）→ 渲染行项。

    规格快照里的申报要素（HS Code、包装、毛净重、体积）要摊平到行项上，
    否则商业发票/装箱单/报关表的核心列全是空的。
    """
    spec = raw.get("spec_snapshot") if isinstance(raw, dict) else None
    item: dict[str, Any] = {
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
    # 行项上直接带的申报要素（来源表若已展开）
    for field in _SPEC_FIELDS:
        value = _clean(raw.get(field))
        if value is not None:
            item[field] = value
    return {k: v for k, v in item.items() if v is not None}


def buyer_block(customer: Any, contact: Any = None) -> dict:
    """客户档案 + 主联系人 → 单证买方区块。

    Consignee 只有公司名是清关大忌：目的国海关要求收货人名称与地址齐全，
    联系人/电话用于到港通知。因此地址、联系人都要带出来。
    """
    block: dict[str, Any] = {}
    if customer is not None:
        block["company"] = getattr(customer, "name", None)
        block["address"] = getattr(customer, "address", None)
    if contact is not None:
        block["contact"] = getattr(contact, "name", None)
        block["phone"] = getattr(contact, "phone", None)
        block["email"] = getattr(contact, "email", None)
    return {k: v for k, v in block.items() if _clean(v) is not None}


def trade_terms_of(source: Any) -> dict:
    """从报价单/订单行取出贸易条款（G3：这些列是 202609260001 新增的正列）。

    同时支持 ORM 行对象与快照字典 —— 开单时已把条款冻进快照，
    渲染时读快照才能保证「单据上的条款 == 开单当时的条款」。
    """
    if source is None:
        return {}
    if isinstance(source, dict):
        terms = {field: source.get(field) for field in TRADE_TERM_FIELDS}
    else:
        terms = {field: getattr(source, field, None) for field in TRADE_TERM_FIELDS}
    return {k: v for k, v in terms.items() if _clean(v) is not None}


def build_render_data(
    *,
    doc_type: str,
    doc_no: str,
    doc_status: str,
    currency: str,
    total_amount: Any,
    created_at: Any = None,
    issued_at: Any = None,
    seller: Optional[dict] = None,
    buyer: Optional[dict] = None,
    bank_info: Optional[dict] = None,
    sources: Optional[dict] = None,
    trade_terms: Optional[dict] = None,
    custom: Optional[dict] = None,
    defaults: Optional[dict] = None,
) -> dict:
    """装配渲染数据（纯函数，便于两侧复用与单测）。"""
    data: dict[str, Any] = {}

    # ① 公司级默认条款（省去每张单据重填）
    for key, value in (defaults or {}).items():
        if _clean(value) is not None:
            data[key] = value

    # ② 上游快照：货物与条款
    sources = sources or {}
    upstream = sources.get("order") or sources.get("quote") or {}
    items = [item_from_source(i) for i in (upstream.get("items") or [])]
    if items:
        data["items"] = items
    if _clean(upstream.get("currency")) is not None:
        data["currency"] = upstream["currency"]
    for key, value in (trade_terms or {}).items():
        data[key] = value

    # ③ 交易双方（企业主体 / 客户档案）
    if seller:
        data["seller"] = seller
        # 卖方同时是托运人/出口商/受益人（各单证叫法不同，指向同一主体）
        data["shipper"] = seller
        data["exporter"] = seller
    if buyer:
        data["buyer"] = buyer
        data["consignee"] = buyer
        data["insured"] = buyer
    if bank_info:
        data["bank_info"] = bank_info

    # ④ 单据自身信息（编号 / 日期 / 金额）
    no_field, date_field = DOC_NO_FIELDS.get(doc_type, (None, None))
    if no_field:
        data[no_field] = doc_no
    if date_field:
        # 已签发用签发日，否则用创建日（与纸质单据「开单日」语义一致）
        data[date_field] = issued_at or created_at
    data["currency"] = data.get("currency") or currency
    if _clean(total_amount) is not None:
        data["total_amount"] = total_amount

    # ⑤ 手工填写覆盖最后应用（业务员改过的内容不被自动带入覆盖）
    for key, value in (custom or {}).items():
        data[key] = value

    return data
