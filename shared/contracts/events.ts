/**
 * Single source of truth: backend/orchestrator/app/domain/schema_registry.py
 * Reference: v2 design document §3.7.5
 *
 * event_type literals must exactly match PAYLOAD_SCHEMAS keys (R0 redline).
 */
import { z } from 'zod';

export const LATEST_SCHEMA_VERSION = {
  'capability.update': 1,
  'audit.access': 1,
} as const;

export type EventType = keyof typeof LATEST_SCHEMA_VERSION;

// ── Payload schemas per event_type:version ──

export const CapabilityUpdatePayloadSchema = z.object({
  customer_id: z.string(),
  product_category: z.string(),
  spec_constraints_before: z.record(z.unknown()),
  spec_constraints_after: z.record(z.unknown()),
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
  'capability.update:1': CapabilityUpdatePayloadSchema,
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
