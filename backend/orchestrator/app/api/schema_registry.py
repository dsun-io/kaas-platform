"""
Kaas v2 · Schema Registry (§3.7.5 + §3.7.8)
──────────────────────────────────────────
(event_type, schema_version) → Pydantic BaseModel 的权威映射。
前后端共享契约，与 frontend shared/contracts/ 必须一致。
"""
from typing import Any, Dict, Optional, Literal
from pydantic import BaseModel, Field

# ─── v1 Payload Schemas (§3.7.5) ───


class ChatTurnV1(BaseModel):
    session_id: str
    raw_text: str
    agent_id: str
    customer_id: str
    response_text: str
    llm_model: str
    llm_tokens_in: int
    llm_tokens_out: int


class QuoteRequestV1(BaseModel):
    session_id: str
    customer_id: str
    product_category: str
    product_spec: Dict[str, Any]
    quantity: int


class QuoteResponseV1(BaseModel):
    session_id: str
    status: Literal["matched", "estimated", "spec_not_supported"]
    source: Literal["quotations_db", "L1_L2_formula"]
    unit_price: Optional[float] = None
    confidence: Literal["high", "medium", "low"]


class CapabilityUpdateV1(BaseModel):
    customer_id: str
    product_category: str
    spec_constraints_before: Dict[str, Any]
    spec_constraints_after: Dict[str, Any]
    actor_id: str


class KbEditV1(BaseModel):
    dataset_name: str
    chunk_id: Optional[str] = None
    action: Literal["create", "update", "delete"]
    actor_id: str


class AuditAccessV1(BaseModel):
    resource_type: Literal["page", "api", "dataset"]
    resource_id: str
    actor_id: str
    ip: Optional[str] = None


# ─── Registry: (event_type, schema_version) → BaseModel ───

PAYLOAD_SCHEMAS: Dict[str, Dict[int, type[BaseModel]]] = {
    "chat.turn": {1: ChatTurnV1},
    "quote.request": {1: QuoteRequestV1},
    "quote.response": {1: QuoteResponseV1},
    "capability.update": {1: CapabilityUpdateV1},
    "kb.edit": {1: KbEditV1},
    "audit.access": {1: AuditAccessV1},
}

VALID_EVENT_TYPES = frozenset(PAYLOAD_SCHEMAS.keys())
VALID_EVENT_SOURCES = frozenset(
    {"frontend", "orchestrator", "scheduled"}
)
MAX_PAYLOAD_BYTES = 10 * 1024  # 10KB
