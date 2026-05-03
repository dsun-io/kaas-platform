"""Kaas v2 · 报价查询 Schema"""
from pydantic import BaseModel


class QuotationItem(BaseModel):
    id: int
    customer_id: str
    product_category: str | None = None
    product_spec: dict | None = None
    spec_hash: str | None = None
    unit_price: float | None = None
    currency: str | None = None
    unit: str | None = None
    discount: float | None = None
    min_quantity: int | None = None
    source: str | None = None
    notes: str | None = None
    created_at: str | None = None


class QuotationListResponse(BaseModel):
    quotations: list[QuotationItem]
    total: int
    limit: int
