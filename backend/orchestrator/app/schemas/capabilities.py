"""Kaas v2 · 客户能力 Schema"""
from pydantic import BaseModel


class CapabilityItem(BaseModel):
    id: int
    customer_id: str
    customer_name: str | None = None
    product_category: str
    spec_constraints: dict | None = None
    notes: str | None = None
    effective_from: str | None = None
    updated_at: str | None = None


class CapabilityListResponse(BaseModel):
    capabilities: list[CapabilityItem]


class CapabilityUpsertRequest(BaseModel):
    customer_id: str
    customer_name: str = ""
    product_category: str
    spec_constraints: dict | None = None
    notes: str | None = None
