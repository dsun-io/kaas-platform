from pydantic import BaseModel, Field


class ChatRequest(BaseModel):
    platform: str = Field(..., description="qianniu | pdd")
    buyer_id: str
    message: str
    conversation_id: str | None = None


class ChatResponse(BaseModel):
    reply: str
    conversation_id: str
    should_transfer: bool
    response_time_ms: int
    ai_source: str = Field(default="unknown", description="fastgpt | fallback | transfer")
    status: str = Field(default="sent", description="sent | send_failed | ai_failed | transfer | skipped")
