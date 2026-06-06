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
    reply: str
    conversation_id: str
    should_transfer: bool
    response_time_ms: int
    ai_source: str = Field(default="unknown", description="fastgpt | fallback | transfer")
    status: str = Field(default="sent", description="sent | send_failed | ai_failed | transfer | skipped")
