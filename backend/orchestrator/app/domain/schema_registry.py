from typing import Any, Dict, Optional, Literal
from pydantic import BaseModel, Field

class QuoteRequestPayload(BaseModel):
    session_id: str
    customer_id: str
    product_category: str
    product_spec: Dict[str, Any]
    quantity: int

class QuoteResponsePayload(BaseModel):
    session_id: str
    status: Literal['matched', 'estimated', 'spec_not_supported']
    source: Literal['quotations_db', 'L1_L2_formula']
    unit_price: Optional[float]
    confidence: Literal['high', 'medium', 'low']

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

PAYLOAD_SCHEMAS: Dict[str, type[BaseModel]] = {
    "quote.request": QuoteRequestPayload,
    "quote.response": QuoteResponsePayload,
    "capability.update": CapabilityUpdatePayload,
    "audit.access": AuditAccessPayload,
}
