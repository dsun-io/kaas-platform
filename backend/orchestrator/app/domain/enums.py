"""业务枚举字典（docs/WORKSTATION_DESIGN.md §10.4）

前后端共用的唯一合法值清单。数据库存开放字符串，写入前必须经
``validate_enum`` 校验（不变量11）。前端应通过 /api/v1/enums 获取同一份
常量渲染下拉/标签，禁止前端硬编码另一份。
"""
from fastapi import HTTPException

# ── 询盘状态（§10.1 状态机）─────────────────────────────────────────────────
INQUIRY_STATUS = ("open", "quoted", "won", "lost")

# ── 客户阶段（被询盘驱动）───────────────────────────────────────────────────
CUSTOMER_STAGE = ("lead", "inquiry", "quoted", "won", "lost", "inactive")

# ── 报价单状态 ───────────────────────────────────────────────────────────────
QUOTE_STATUS = ("draft", "sent", "accepted", "rejected", "expired")

# ── 订单状态 ─────────────────────────────────────────────────────────────────
ORDER_STATUS = ("pending", "confirmed", "producing", "shipped", "completed", "cancelled")

# ── 出运状态 ─────────────────────────────────────────────────────────────────
SHIPMENT_STATUS = ("booking", "in_transit", "arrived", "customs", "delivered")

# ── 询盘渠道 ─────────────────────────────────────────────────────────────────
INQUIRY_CHANNEL = ("email", "whatsapp", "alibaba", "expo", "website", "other")

# ── 单证类型（§6.3 单证类型×生成阶段）────────────────────────────────────────
# 必须与前端模板清单（frontend/src/lib/trade-doc/manifest.json）逐项一致：
# 模板有而这里没有 → 该类型无法开单；这里多了 → 开出单来渲染不出。
# 由 scripts/contracts-check.ts 的 R3 规则强制校验（防前后端漂移）。
# 分三组：出口商自制 / 第三方签发（本系统出申报或申请信息） / 通用。
DOC_TYPE = (
    # 出口商自制
    "quotation", "pi", "contract", "ci", "pl",
    "shipping_advice", "draft", "beneficiary_cert", "non_wood_packing",
    "weight_list", "quality_cert", "manufacturer_cert",
    # 第三方签发
    "bl", "co", "insurance", "customs_declaration", "fumigation_cert",
    # 通用
    "other",
)

# ── 单证状态 ─────────────────────────────────────────────────────────────────
DOC_STATUS = ("draft", "issued", "void")

# ── 币种（以 fx_rates 实际支持为准，这里是初始白名单）────────────────────────
CURRENCY = ("USD", "CNY", "EUR", "GBP", "JPY", "AUD", "CAD", "HKD")

# ── 数据可见范围（§10.3）─────────────────────────────────────────────────────
OWNER_SCOPE = ("private", "tenant")

# ── 付款计划 ─────────────────────────────────────────────────────────────────
SCHEDULE_TYPE = ("deposit", "balance", "full")
SCHEDULE_STATUS = ("pending", "paid", "overdue")

# ── 应收状态 ─────────────────────────────────────────────────────────────────
RECEIVABLE_STATUS = ("unpaid", "partial", "paid")

# ── 提单类型 ─────────────────────────────────────────────────────────────────
BL_TYPE = ("original", "telex", "seaway")

ENUMS: dict[str, tuple[str, ...]] = {
    "inquiry_status": INQUIRY_STATUS,
    "customer_stage": CUSTOMER_STAGE,
    "quote_status": QUOTE_STATUS,
    "order_status": ORDER_STATUS,
    "shipment_status": SHIPMENT_STATUS,
    "inquiry_channel": INQUIRY_CHANNEL,
    "doc_type": DOC_TYPE,
    "doc_status": DOC_STATUS,
    "currency": CURRENCY,
    "owner_scope": OWNER_SCOPE,
    "schedule_type": SCHEDULE_TYPE,
    "schedule_status": SCHEDULE_STATUS,
    "receivable_status": RECEIVABLE_STATUS,
    "bl_type": BL_TYPE,
}


def validate_enum(field: str, value: str | None) -> str | None:
    """校验枚举合法值；None 原样返回（可空字段）。

    非法值抛 422，error body 符合 §10.10 统一错误格式约定语义。
    """
    if value is None:
        return None
    allowed = ENUMS.get(field)
    if allowed is None:
        raise HTTPException(status_code=500, detail=f"unknown enum field: {field}")
    if value not in allowed:
        raise HTTPException(
            status_code=422,
            detail={
                "error": "invalid_enum_value",
                "code": "INVALID_ENUM",
                "field": field,
                "value": value,
                "allowed": list(allowed),
            },
        )
    return value
