/**
 * Single source of truth: backend/kaas_common/domain/schema_registry.py
 * Reference: v2 design document §3.7.5
 *
 * event_type literals must exactly match PAYLOAD_SCHEMAS keys (R0 redline).
 */
import { z } from 'zod';

export const LATEST_SCHEMA_VERSION = {
  'capability.update': 1,
  'audit.access': 1,
  'market.selected': 1,
  'lead.discovered': 1,
  'lead.enriched': 1,
  'lead.outreach_ready': 1,
  'outreach.sent': 1,
  'outreach.replied': 1,
  'quotation.converted': 1,
  'order.shipped': 1,
  'shipment.documented': 1,
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

// ── 情报与工位流转事件（v1）──

export const MarketSelectedPayloadSchema = z.object({
  market_id: z.string(),
  market_name: z.string(),
  actor_id: z.string(),
});

export const LeadDiscoveredPayloadSchema = z.object({
  lead_id: z.string(),
  source: z.string(),
  actor_id: z.string(),
});

export const LeadEnrichedPayloadSchema = z.object({
  lead_id: z.string(),
  fields_added: z.array(z.string()),
  actor_id: z.string(),
});

export const LeadOutreachReadyPayloadSchema = z.object({
  lead_id: z.string(),
  channel: z.string(),
  actor_id: z.string(),
});

export const OutreachSentPayloadSchema = z.object({
  lead_id: z.string(),
  channel: z.string(),
  actor_id: z.string(),
});

export const OutreachRepliedPayloadSchema = z.object({
  lead_id: z.string(),
  channel: z.string(),
  reply_summary: z.string().nullable(),
  actor_id: z.string(),
});

export const QuotationConvertedPayloadSchema = z.object({
  quotation_id: z.string(),
  order_id: z.string().nullable(),
  customer_id: z.string(),
  actor_id: z.string(),
});

export const OrderShippedPayloadSchema = z.object({
  order_id: z.string(),
  shipment_ref: z.string().nullable(),
  actor_id: z.string(),
});

export const ShipmentDocumentedPayloadSchema = z.object({
  order_id: z.string(),
  doc_id: z.string().nullable(),
  doc_type: z.string(),
  actor_id: z.string(),
});

/** Maps event_type:version → zod schema */
export const EVENT_PAYLOAD_SCHEMAS: Record<`${EventType}:${number}`, z.ZodSchema> = {
  'capability.update:1': CapabilityUpdatePayloadSchema,
  'audit.access:1': AuditAccessPayloadSchema,
  'market.selected:1': MarketSelectedPayloadSchema,
  'lead.discovered:1': LeadDiscoveredPayloadSchema,
  'lead.enriched:1': LeadEnrichedPayloadSchema,
  'lead.outreach_ready:1': LeadOutreachReadyPayloadSchema,
  'outreach.sent:1': OutreachSentPayloadSchema,
  'outreach.replied:1': OutreachRepliedPayloadSchema,
  'quotation.converted:1': QuotationConvertedPayloadSchema,
  'order.shipped:1': OrderShippedPayloadSchema,
  'shipment.documented:1': ShipmentDocumentedPayloadSchema,
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
