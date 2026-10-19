from typing import Any, Dict, Optional, Literal
from pydantic import BaseModel, Field

class CapabilityUpdatePayload(BaseModel):
    customer_id: str
    product_category: str
    spec_constraints_before: Dict[str, Any]
    spec_constraints_after: Dict[str, Any]
    actor_id: str

class AuditAccessPayload(BaseModel):
    resource_type: Literal['page', 'api', 'dataset']
    resource_id: str
    actor_id: str
    ip: Optional[str]

class MarketSelectedPayload(BaseModel):
    market_id: str
    market_name: str
    actor_id: str

class LeadDiscoveredPayload(BaseModel):
    lead_id: str
    source: str
    actor_id: str

class LeadEnrichedPayload(BaseModel):
    lead_id: str
    fields_added: list[str]
    actor_id: str

class LeadOutreachReadyPayload(BaseModel):
    lead_id: str
    channel: str
    actor_id: str

class OutreachSentPayload(BaseModel):
    lead_id: str
    channel: str
    actor_id: str

class OutreachRepliedPayload(BaseModel):
    lead_id: str
    channel: str
    reply_summary: Optional[str]
    actor_id: str

class QuotationConvertedPayload(BaseModel):
    quotation_id: str
    order_id: Optional[str]
    customer_id: str
    actor_id: str

class OrderShippedPayload(BaseModel):
    order_id: str
    shipment_ref: Optional[str]
    actor_id: str

class ShipmentDocumentedPayload(BaseModel):
    order_id: str
    doc_id: Optional[str]
    doc_type: str
    actor_id: str

PAYLOAD_SCHEMAS: Dict[str, type[BaseModel]] = {
    "capability.update": CapabilityUpdatePayload,
    "audit.access": AuditAccessPayload,
    "market.selected": MarketSelectedPayload,
    "lead.discovered": LeadDiscoveredPayload,
    "lead.enriched": LeadEnrichedPayload,
    "lead.outreach_ready": LeadOutreachReadyPayload,
    "outreach.sent": OutreachSentPayload,
    "outreach.replied": OutreachRepliedPayload,
    "quotation.converted": QuotationConvertedPayload,
    "order.shipped": OrderShippedPayload,
    "shipment.documented": ShipmentDocumentedPayload,
}
