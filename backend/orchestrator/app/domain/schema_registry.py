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

PAYLOAD_SCHEMAS: Dict[str, type[BaseModel]] = {
    "capability.update": CapabilityUpdatePayload,
    "audit.access": AuditAccessPayload,
}
