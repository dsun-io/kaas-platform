"""
Kaas v2 · Schema Registry (§3.7.5 + §3.7.8)
──────────────────────────────────────────
(event_type, schema_version) → Pydantic BaseModel 的权威映射。
前后端共享契约，与 frontend shared/contracts/ 必须一致。
"""
from typing import Any, Dict, Optional, Literal
from pydantic import BaseModel, Field

# ─── v1 Payload Schemas (§3.7.5) ───


class CapabilityUpdateV1(BaseModel):
    customer_id: str
    product_category: str
    spec_constraints_before: Dict[str, Any]
    spec_constraints_after: Dict[str, Any]
    actor_id: str


class AuditAccessV1(BaseModel):
    resource_type: Literal["page", "api", "dataset"]
    resource_id: str
    actor_id: str
    ip: Optional[str] = None


class MarketSelectedV1(BaseModel):
    market_id: str
    market_name: str
    actor_id: str


class LeadDiscoveredV1(BaseModel):
    lead_id: str
    source: str
    actor_id: str


class LeadEnrichedV1(BaseModel):
    lead_id: str
    fields_added: list[str]
    actor_id: str


class LeadOutreachReadyV1(BaseModel):
    lead_id: str
    channel: str
    actor_id: str


class OutreachSentV1(BaseModel):
    lead_id: str
    channel: str
    actor_id: str


class OutreachRepliedV1(BaseModel):
    lead_id: str
    channel: str
    reply_summary: Optional[str] = None
    actor_id: str


class QuotationConvertedV1(BaseModel):
    quotation_id: str
    order_id: Optional[str] = None
    customer_id: str
    actor_id: str


class OrderShippedV1(BaseModel):
    order_id: str
    shipment_ref: Optional[str] = None
    actor_id: str


class ShipmentDocumentedV1(BaseModel):
    order_id: str
    doc_id: Optional[str] = None
    doc_type: str
    actor_id: str


# ─── Registry: (event_type, schema_version) → BaseModel ───

PAYLOAD_SCHEMAS: Dict[str, Dict[int, type[BaseModel]]] = {
    "capability.update": {1: CapabilityUpdateV1},
    "audit.access": {1: AuditAccessV1},
    "market.selected": {1: MarketSelectedV1},
    "lead.discovered": {1: LeadDiscoveredV1},
    "lead.enriched": {1: LeadEnrichedV1},
    "lead.outreach_ready": {1: LeadOutreachReadyV1},
    "outreach.sent": {1: OutreachSentV1},
    "outreach.replied": {1: OutreachRepliedV1},
    "quotation.converted": {1: QuotationConvertedV1},
    "order.shipped": {1: OrderShippedV1},
    "shipment.documented": {1: ShipmentDocumentedV1},
}

VALID_EVENT_TYPES = frozenset(PAYLOAD_SCHEMAS.keys())
VALID_EVENT_SOURCES = frozenset(
    {"frontend", "orchestrator", "scheduled"}
)
MAX_PAYLOAD_BYTES = 10 * 1024  # 10KB
