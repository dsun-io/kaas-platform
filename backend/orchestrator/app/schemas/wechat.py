"""
Kaas v2 · AUTH-WX-R1: WeChat / Conversation Pydantic schemas
"""
from pydantic import BaseModel
from typing import Optional, List, Any


# ── WeChat Bot ──

class WechatBotCreateRequest(BaseModel):
    customer_id: int
    tenant_id: str
    bot_name: str
    bot_type: str = "clawbot"
    bot_token: str  # plaintext, will be encrypted before storage


class WechatBotResponse(BaseModel):
    id: int
    customer_id: int
    tenant_id: str
    bot_name: str
    bot_type: str
    status: str
    created_by: Optional[str] = None
    created_at: str
    updated_at: str


class WechatBotListResponse(BaseModel):
    bots: List[WechatBotResponse]


# ── Channel Link ──

class ChannelLinkCreateRequest(BaseModel):
    customer_id: int
    tenant_id: str
    channel: str
    name: Optional[str] = None
    scenario: Optional[str] = None


class ChannelLinkResponse(BaseModel):
    id: int
    customer_id: int
    tenant_id: str
    channel: str
    name: Optional[str] = None
    scenario: Optional[str] = None
    link_token: Optional[str] = None
    enabled: bool
    expires_at: Optional[str] = None
    created_at: str


# ── Inbound Message ──

class InboundMessageRequest(BaseModel):
    """微信消息进入 Kaas 后的归一化消息"""
    customer_id: int
    tenant_id: str
    channel: str = "wechat_clawbot"
    conversation_id: Optional[int] = None
    sender_id: str
    content_type: str = "text"
    text: str
    # 预留字段
    voice_file: Optional[str] = None
    asr_text: Optional[str] = None
    image_url: Optional[str] = None


class QuoteReplyResponse(BaseModel):
    conversation_id: int
    message_id: int
    reply_text: str
    intent: str
    quote_status: str
    product_category: Optional[str] = None
    extracted_params: Optional[dict] = None
    latency_ms: int


# ── Conversation ──

class ConversationResponse(BaseModel):
    id: int
    customer_id: int
    tenant_id: str
    channel: str
    status: str
    created_at: str
    updated_at: str


class ConversationMessageResponse(BaseModel):
    id: int
    conversation_id: int
    role: str
    raw_content: Optional[str] = None
    normalized_content: Optional[str] = None
    intent: Optional[str] = None
    product_category: Optional[str] = None
    quote_status: Optional[str] = None
    latency_ms: Optional[int] = None
    error_code: Optional[str] = None
    created_at: str


class ConversationDetailResponse(BaseModel):
    conversation: ConversationResponse
    messages: List[ConversationMessageResponse]
