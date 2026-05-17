"""Wizard 提交 Pydantic schemas (方案 8.6 节)。"""
from pydantic import BaseModel, Field
from typing import Optional, Any
from datetime import datetime
from decimal import Decimal


class SpecValueEntry(BaseModel):
    v: Any
    u: Optional[str] = None
    g: Optional[str] = None


class PricingPayload(BaseModel):
    price: Decimal
    currency: str = "CNY"
    price_unit: str
    min_qty: Optional[Decimal] = None
    tier_rules: Optional[list[dict]] = None
    effective_from: datetime
    effective_to: Optional[datetime] = None
    note: Optional[str] = None
    change_reason: str = Field(..., min_length=1)


class WizardSubmitRequest(BaseModel):
    category_id: int = Field(..., description="G1 必填，叶子类目")
    spec_values: dict[str, SpecValueEntry] = Field(..., description="G2 + G3 合并")
    pricing: Optional[PricingPayload] = None
    weight_kg: Optional[Decimal] = None
    description: Optional[str] = None


class WizardSubmitResponse(BaseModel):
    sku_id: int
    price_id: Optional[int] = None
    spec_hash: str
    is_new_sku: bool
    schema_version: int


class AttributeProposalRequest(BaseModel):
    category_id: int
    proposed_name: str = Field(..., min_length=1)
    proposed_type: str = Field(..., min_length=1)
    group_code: str = Field(..., pattern="^(variant|spec)$")
    proposed_unit: Optional[str] = None
    proposed_unit_group: Optional[str] = None
    sample_values: Optional[list[Any]] = None
    reason: Optional[str] = None


class AttributeProposalResponse(BaseModel):
    id: int
    status: str
