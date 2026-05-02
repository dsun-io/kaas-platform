/**
 * Single source of truth: backend/orchestrator/app/domain/schema_registry.py
 * Reference: v2 design document §3.7.5
 *
 * 6 event_type 字面量必须与 PAYLOAD_SCHEMAS keys 完全一致（R0 红线）。
 */

export interface ChatTurnPayload {
  session_id: string;
  raw_text: string;
  agent_id: string;
  customer_id: string;
  response_text: string;
  llm_model: string;
  llm_tokens_in: number;
  llm_tokens_out: number;
}

export interface QuoteRequestPayload {
  session_id: string;
  customer_id: string;
  product_category: string;
  product_spec: Record<string, unknown>;
  quantity: number;
}

export interface QuoteResponsePayload {
  session_id: string;
  status: 'matched' | 'estimated' | 'spec_not_supported';
  source: 'quotations_db' | 'L1_L2_formula';
  unit_price: number | null;
  confidence: 'high' | 'medium' | 'low';
}

export interface CapabilityUpdatePayload {
  customer_id: string;
  product_category: string;
  spec_constraints_before: Record<string, unknown>;
  spec_constraints_after: Record<string, unknown>;
  actor_id: string;
}

export interface KbEditPayload {
  dataset_name: string;
  chunk_id: string | null;
  action: 'create' | 'update' | 'delete';
  actor_id: string;
}

export interface AuditAccessPayload {
  resource_type: 'page' | 'api' | 'dataset';
  resource_id: string;
  actor_id: string;
  ip: string | null;
}

/** Maps event_type string literal to its payload interface. */
export interface EventTypeMap {
  'audit.access': AuditAccessPayload;
  'capability.update': CapabilityUpdatePayload;
  'chat.turn': ChatTurnPayload;
  'kb.edit': KbEditPayload;
  'quote.request': QuoteRequestPayload;
  'quote.response': QuoteResponsePayload;
}

/** Union of all event_type literals (derived from PAYLOAD_SCHEMAS keys). */
export type EventType = keyof EventTypeMap;

/** Union of all event payload interfaces. */
export type EventPayload = EventTypeMap[EventType];
