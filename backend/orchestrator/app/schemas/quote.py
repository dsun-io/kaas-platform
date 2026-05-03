"""Kaas v2 · 报价 Schema"""
from pydantic import BaseModel, Field


class QuoteResponse(BaseModel):
    status: str
    unit_price: float | None = None
    currency: str = "CNY"
    unit: str = "meter"
    confidence: float | None = None
    source: str = "stub"
    spec_hash: str | None = None
    notes: str = ""
    script: str = ""


class QuoteRequest(BaseModel):
    customer_id: str = Field("", max_length=64)
    product_category: str = ""
    product_spec: dict | None = None
    raw_text: str = Field("", max_length=2000)
    session_id: str = ""
    quantity: int = 1
