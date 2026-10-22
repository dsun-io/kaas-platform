"""业务枚举字典（docs/WORKSTATION_DESIGN.md §10.4）

前后端共用的唯一合法值清单。数据库存开放字符串，写入前必须经
``validate_enum`` 校验（不变量11）。前端应通过 /api/v1/enums 获取同一份
常量渲染下拉/标签，禁止前端硬编码另一份。
"""
from fastapi import HTTPException

# ── 询盘状态（2026-10-18 用户口径：未报价 / 已报价 / 已关闭）──────────────
#   unquoted：新建默认；
#   quoted：生成报价单时自动推进；
#   closed：仅手动切换（关闭后不再被报价事件自动改回）。
INQUIRY_STATUS = ("unquoted", "quoted", "closed")

# ── 客户阶段（2026-10-18 用户口径）───────────────────────────────────────────
# 只有三种：活跃 / 沉寂 / 已下单。
#   · active / inactive：手动状态，存在 customers.stage；
#   · ordered：推导值（名下存在开启中的订单时），不落库、不允许手动写。
# 询盘/报价/订单的 lead→inquiry→quoted→won→lost 属于**单据阶段**，不是客户阶段。
CUSTOMER_STAGE = ("active", "inactive", "ordered")

# ── 报价单状态 ───────────────────────────────────────────────────────────────
QUOTE_STATUS = ("draft", "sent", "accepted", "rejected", "expired", "closed")

# ── 订单状态 ─────────────────────────────────────────────────────────────────
ORDER_STATUS = ("pending", "confirmed", "producing", "shipped", "completed", "cancelled")

# ── 订单来源类型（2026-10-22 设计 §3.2 / D-1）────────────────────────────────
#   inquiry：询盘转化（含经报价转化）—— 必须关联询盘，DB 层 CHECK
#            ck_orders_source_inquiry 兜底；
#   direct ：直接下单（线下电话单、老客户返单、展会现场单等），不要求询盘。
# 订单是一等公民：两种来源都能独立存在，`inquiry` 只是多一条溯源链，不是存在前提。
ORDER_SOURCE_TYPE = ("inquiry", "direct")

# ── 订单确认来源（2026-10-22 设计 §5.1 / D-16）──────────────────────────────
#   manual          ：人工点「确认订单」（先确认后打款 / 线下已确认）；
#   deposit_receipt ：业务人工登记定金到账后**联动**确认。
# ⚠️ 两者都是**人工触发**——定金收款登记本身没有自动识别能力（D-17）。
ORDER_CONFIRM_SOURCE = ("manual", "deposit_receipt")

# ── 出运状态 ─────────────────────────────────────────────────────────────────
SHIPMENT_STATUS = ("booking", "in_transit", "arrived", "customs", "delivered")

# ── 询盘渠道（= 订单 source_channel 复用同一份，2026-10-22 设计 §4 / D-7）──────
# 2026-10-22：去掉 `quote`（那是「来源类型」不是「渠道」，与 source_type 重复表达），
# 新增 `phone`（电话/线下电话单）与 `referral`（老客户转介绍）。
# 存量 channel='quote' 的询盘由迁移 `202610220004` 回填为 `other`。
INQUIRY_CHANNEL = ("email", "whatsapp", "alibaba", "expo", "website", "phone", "referral", "other")

# 订单渠道与询盘渠道是同一份清单（同一客户可能先从邮件来、后从展会返单），
# 不另立第二份，避免两处漂移；仅别名以便调用点语义清晰。
ORDER_CHANNEL = INQUIRY_CHANNEL

# ── 单证类型（§6.3 单证类型×生成阶段）────────────────────────────────────────
# 必须与前端模板清单（frontend/src/lib/trade-doc/manifest.json）逐项一致：
# 模板有而这里没有 → 该类型无法开单；这里多了 → 开出单来渲染不出。
# 由 scripts/contracts-check.ts 的 R3 规则强制校验（防前后端漂移）。
# 分三组：出口商自制 / 第三方签发（本系统出申报或申请信息） / 通用。
DOC_TYPE = (
    # 出口商自制
    "quotation", "pi", "contract", "ci", "pl",
    "shipping_advice", "draft", "beneficiary_cert", "beneficiary_decl",
    "non_wood_packing", "weight_list", "quality_cert", "manufacturer_cert",
    # 第三方签发
    "bl", "co", "insurance", "customs_declaration", "fumigation_cert",
    "saso_coc", "vessel_cert", "export_license", "ciq",
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
# 收款期次类型：定金 / 尾款 / 全额 / 其他（2026-10-22 设计 §13.3 新增 other：
# 「期次类型（定金/尾款/其他）」，运费后补等场景需要非标准期次）。
SCHEDULE_TYPE = ("deposit", "balance", "full", "other")
# 收款期次状态：pending 未收 / partial 部分实收 / paid 已收清 / overdue 逾期未收
# 2026-10-22（设计 §13.3）：新增 partial —— 「一次收款一行」的实收登记后，
# 期次已收金额 > 0 且 < 应收金额 ⇒ partial；已 paid 的历史行不回退。
SCHEDULE_STATUS = ("pending", "partial", "paid", "overdue")

# ── 应收状态 ─────────────────────────────────────────────────────────────────
RECEIVABLE_STATUS = ("unpaid", "partial", "paid")

# ── 提单类型 ─────────────────────────────────────────────────────────────────
BL_TYPE = ("original", "telex", "seaway")

ENUMS: dict[str, tuple[str, ...]] = {
    "inquiry_status": INQUIRY_STATUS,
    "customer_stage": CUSTOMER_STAGE,
    "quote_status": QUOTE_STATUS,
    "order_status": ORDER_STATUS,
    "order_source_type": ORDER_SOURCE_TYPE,
    "order_confirm_source": ORDER_CONFIRM_SOURCE,
    "shipment_status": SHIPMENT_STATUS,
    "inquiry_channel": INQUIRY_CHANNEL,
    # 订单渠道与询盘渠道同源；前端 /api/v1/enums 两个 key 都能取到同一份清单。
    "source_channel": ORDER_CHANNEL,
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
