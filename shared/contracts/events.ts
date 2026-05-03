/**
 * Single source of truth: backend/orchestrator/app/domain/schema_registry.py
 * Reference: v2 design document §3.7.5
 *
 * 6 event_type literals must exactly match PAYLOAD_SCHEMAS keys (R0 redline).
 */
import { z } from 'zod';

export const LATEST_SCHEMA_VERSION = {
  'chat.turn': 1,
  'quote.request': 1,
  'quote.response': 1,
  'capability.update': 1,
  'kb.edit': 1,
  'audit.access': 1,
} as const;

export type EventType = keyof typeof LATEST_SCHEMA_VERSION;

// ── Payload schemas per event_type:version ──

export const ChatTurnPayloadSchema = z.object({
  session_id: z.string(),
  raw_text: z.string(),
  agent_id: z.string(),
  customer_id: z.string(),
  response_text: z.string(),
  llm_model: z.string(),
  llm_tokens_in: z.number().int(),
  llm_tokens_out: z.number().int(),
});

export const QuoteRequestPayloadSchema = z.object({
  session_id: z.string(),
  customer_id: z.string(),
  product_category: z.string(),
  product_spec: z.record(z.unknown()),
  quantity: z.number().int().positive(),
});

export const QuoteResponsePayloadSchema = z.object({
  session_id: z.string(),
  status: z.enum(['matched', 'estimated', 'spec_not_supported']),
  source: z.enum(['quotations_db', 'L1_L2_formula']),
  unit_price: z.number().nullable(),
  confidence: z.enum(['high', 'medium', 'low']),
});

export const CapabilityUpdatePayloadSchema = z.object({
  customer_id: z.string(),
  product_category: z.string(),
  spec_constraints_before: z.record(z.unknown()),
  spec_constraints_after: z.record(z.unknown()),
  actor_id: z.string(),
});

export const KbEditPayloadSchema = z.object({
  dataset_name: z.string(),
  chunk_id: z.string().nullable(),
  action: z.enum(['create', 'update', 'delete']),
  actor_id: z.string(),
});

export const AuditAccessPayloadSchema = z.object({
  resource_type: z.enum(['page', 'api', 'dataset']),
  resource_id: z.string(),
  actor_id: z.string(),
  ip: z.string().nullable(),
});

/** Maps event_type:version → zod schema */
export const EVENT_PAYLOAD_SCHEMAS: Record<`${EventType}:${number}`, z.ZodSchema> = {
  'chat.turn:1': ChatTurnPayloadSchema,
  'quote.request:1': QuoteRequestPayloadSchema,
  'quote.response:1': QuoteResponsePayloadSchema,
  'capability.update:1': CapabilityUpdatePayloadSchema,
  'kb.edit:1': KbEditPayloadSchema,
  'audit.access:1': AuditAccessPayloadSchema,
};

// ── EventCreate interface (what frontend sends to POST /api/v1/events) ──

export interface EventCreate {
  schema_version: number;
  event_type: EventType;
  event_source: 'frontend' | 'backend';
  tenant_id?: string;
  actor_id?: string;
  session_id?: string;
  trace_id?: string;
  payload: unknown;
}
