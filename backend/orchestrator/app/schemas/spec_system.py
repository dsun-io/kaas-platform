"""Spec 系统 API response schemas。"""
from pydantic import BaseModel, Field
from typing import Optional, Any
from datetime import datetime


class AttributeValueOut(BaseModel):
    id: int
    code: str
    label: str


class SpecAttributeOut(BaseModel):
    id: int
    code: str
    name: str
    data_type: str
    group_code: str
    scope: str
    unit: Optional[str] = None
    unit_group: Optional[str] = None
    number_min: Optional[float] = None
    number_max: Optional[float] = None
    number_step: Optional[float] = None
    values: list[AttributeValueOut] = []


class BindingWithAttribute(BaseModel):
    binding_id: int
    attr_role: str
    is_required: bool
    is_locked: bool
    sort_order: int
    default_value: Optional[Any] = None
    depends_on: Optional[Any] = None
    attribute: SpecAttributeOut


class CategoryNode(BaseModel):
    id: int
    code: str
    name: str
    parent_id: Optional[int] = None
    path: str
    level: int
    industry_code: str
    is_leaf: bool
    is_active: bool
    children: list["CategoryNode"] = []


class SkuOut(BaseModel):
    id: int
    tenant_id: str
    category_id: int
    spec_values: dict
    spec_hash: str
    schema_version: int
    revision: int
    weight_kg: Optional[float] = None
    description: Optional[str] = None
    is_active: bool


class SkuPriceOut(BaseModel):
    id: int
    sku_id: int
    price: float
    currency: str
    price_unit: str
    min_qty: Optional[float] = None
    tier_rules: Optional[list] = None
    effective_from: datetime
    effective_to: Optional[datetime] = None
    status: str
    note: Optional[str] = None
    change_reason: Optional[str] = None


class PriceCreateRequest(BaseModel):
    price: float = Field(..., gt=0)
    price_unit: str = Field(..., min_length=1)
    currency: str = "CNY"
    min_qty: Optional[float] = None
    tier_rules: Optional[list] = None
    effective_from: datetime
    effective_to: Optional[datetime] = None
    note: Optional[str] = None
    change_reason: str = Field(..., min_length=1)


class PricePatchRequest(BaseModel):
    status: Optional[str] = None
    note: Optional[str] = None
    effective_to: Optional[datetime] = None


class SkuPatchRequest(BaseModel):
    spec_values: dict[str, Any]
    change_reason: str = Field(..., min_length=1)
    weight_kg: Optional[float] = None
    description: Optional[str] = None
