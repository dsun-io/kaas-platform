from pydantic import BaseModel, Field
from typing import Literal, List, Optional


class ChatRequest(BaseModel):
    platform: str = Field(
        ...,
        description="平台标识: qianniu | pdd | douyin | weixin | xiaohongshu | other"
    )
    buyer_id: str = Field(..., description="买家/用户 ID（平台内唯一）")
    message: str = Field(..., description="消息内容")
    conversation_id: str | None = Field(
        None,
        description="会话 ID（可选，如 qn_xxx / pdd_xxx 格式）"
    )

    # 新增可选字段（向后兼容）
    shop_id: str | None = Field(
        None,
        description="店铺/商家 ID（多店铺场景使用）"
    )
    buyer_nick: str | None = Field(
        None,
        description="买家昵称（原始显示名）"
    )
    session_id: str | None = Field(
        None,
        description="跨平台唯一会话 ID（如 qn_buyer123 / pdd_buyer456）"
    )
    message_type: Literal["text", "image", "order", "system", "other"] = Field(
        "text",
        description="消息类型"
    )
    extra: dict | None = Field(
        None,
        description="平台特有附加数据"
    )


class ChatResponse(BaseModel):
    reply: str = Field(..., description="AI 回复内容")
    conversation_id: str = Field(..., description="会话 ID")
    should_transfer: bool = Field(..., description="是否建议转人工")
    response_time_ms: int = Field(..., description="响应耗时（毫秒）")

    # 新增可选字段（向后兼容）
    session_id: str | None = Field(
        None,
        description="跨平台唯一会话 ID"
    )
    transfer_reason: str | None = Field(
        None,
        description="转人工原因（如敏感词触发、AI无响应等）"
    )
    reply_type: Literal["text", "image", "template"] = Field(
        "text",
        description="回复类型"
    )
    # 安全过滤相关字段
    filtered: bool = Field(
        False,
        description="是否经过安全过滤处理"
    )
    filter_log: dict | None = Field(
        None,
        description="过滤日志（包含原始回复、过滤动作等）"
    )


# ============================================================
# 报价引擎相关 Schema（纯计算器模式）
# ============================================================

class QuoteItemRequest(BaseModel):
    """报价明细项请求"""
    name: str = Field(..., description="商品名称")
    pricing_method: Literal["per_kg", "per_sqm", "per_piece"] = Field(
        ..., description="计价方式：per_kg(按重量) / per_sqm(按面积) / per_piece(按件)"
    )
    unit_price: float = Field(..., description="单价（由FastGPT从知识库查到）")
    billing_qty: float = Field(..., description="计费数量（重量kg/面积㎡/件数）")
    weight_kg: float = Field(0.0, description="单件重量（用于运费计算）")
    count: int = Field(1, description="数量")


class ShippingRequest(BaseModel):
    """运费请求"""
    carrier: Literal["sf_ltl", "sf_ganpei", "yuantong", "jd"] = Field(
        ..., description="物流公司：sf_ltl(顺丰零担) / sf_ganpei(顺丰干配) / yuantong(圆通) / jd(京东)"
    )
    province: str = Field(..., description="目的省份")
    total_weight_kg: Optional[float] = Field(None, description="总重量（可选，不传则自动汇总）")


class QuoteRequest(BaseModel):
    """报价请求（纯计算器模式）"""
    items: List[QuoteItemRequest] = Field(..., description="商品列表")
    shipping: ShippingRequest = Field(..., description="运费信息")
    need_invoice: bool = Field(False, description="是否需要开票")


class QuoteItemResponse(BaseModel):
    """报价明细项响应"""
    name: str
    pricing_method: str
    unit_price: float
    billing_qty: float
    weight_kg: float
    count: int
    subtotal: float


class QuoteSummaryResponse(BaseModel):
    """报价汇总响应"""
    items_total: float = Field(..., description="商品总价")
    shipping_cost: float = Field(..., description="运费")
    subtotal_before_tax: float = Field(..., description="税前小计")
    invoice_tax: float = Field(..., description="开票加税金额")
    total: float = Field(..., description="最终总价")


class QuoteResponse(BaseModel):
    """报价响应"""
    status: str = Field(..., description="状态：success / error")
    items: List[QuoteItemResponse] = Field(default_factory=list, description="商品明细")
    summary: Optional[QuoteSummaryResponse] = Field(None, description="报价汇总")
    error_message: str = Field("", description="错误信息")
