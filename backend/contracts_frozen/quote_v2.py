"""Kaas v2 · INT-R3 报价 Schema（新引擎）"""
from pydantic import BaseModel, Field
from typing import Optional


class AccessoryRequest(BaseModel):
    product_category: str
    product_type: Optional[str] = None
    height: Optional[float] = None
    bundle_size: Optional[int] = None
    quantity: int = 1


class QuoteV2Request(BaseModel):
    product_category: str
    product_type: Optional[str] = None
    wire_diameter: Optional[str] = None
    height: Optional[float] = None
    mesh_width: Optional[float] = None
    mesh_spec: Optional[str] = None
    roll_length: Optional[float] = None
    quantity: int = 1
    accessories: list[AccessoryRequest] = Field(default_factory=list)
    province: Optional[str] = None
    need_invoice: bool = False
    tax_rate: Optional[float] = None  # 前端可覆盖税率，不传则用定价策略默认值
    preferred_carrier: Optional[str] = None


class TierItem(BaseModel):
    label: str
    margin_rate: Optional[float] = None
    unit_price: float
    subtotal: float
    total: float


class FreightOption(BaseModel):
    carrier: str
    amount: float


class FreightInfo(BaseModel):
    province: str
    chosen: Optional[FreightOption] = None
    options: list[FreightOption] = Field(default_factory=list)
    status: str = "freight_missing"


class MainLine(BaseModel):
    product_category: str
    spec_summary: str
    quantity: int
    unit: str = "卷"
    weight_kg: Optional[float] = None
    base_cost: Optional[float] = None
    tiers: list[TierItem] = Field(default_factory=list)
    status: str = "matched"


class AccessoryLine(BaseModel):
    product_category: str
    spec_summary: str
    quantity: int
    unit: str
    total: Optional[float] = None
    status: str = "matched"


class Totals(BaseModel):
    low: float = 0
    standard: float = 0
    high: float = 0


class QuoteV2Response(BaseModel):
    status: str  # matched | cost_pending | pricing_profile_missing | freight_missing | no_match | too_many | unsupported_category
    product_category: str
    main_line: MainLine
    accessory_lines: list[AccessoryLine] = Field(default_factory=list)
    freight: Optional[FreightInfo] = None
    totals: Totals = Field(default_factory=Totals)
    notes: list[str] = Field(default_factory=list)
    copyable_script: str = ""
