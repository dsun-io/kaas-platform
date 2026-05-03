import { z } from 'zod';

export const EventsResponseSchema = z.object({
  items: z.array(z.object({
    id: z.string(),
    event_type: z.string(),
    event_source: z.string(),
    schema_version: z.number(),
    actor_id: z.string().optional(),
    tenant_id: z.string(),
    session_id: z.string().optional(),
    trace_id: z.string().optional(),
    payload: z.record(z.unknown()),
    created_at: z.string(),
    sampled: z.boolean().optional(),
    oss_url: z.string().nullable().optional(),
  })),
  total: z.number(),
  page: z.number(),
  page_size: z.number(),
});

export const DashboardResponseSchema = z.object({
  range: z.string(),
  quotations_total: z.number(),
  quotations_sampled: z.number(),
  active_customers: z.number(),
  customers_sampled: z.number(),
  dataset_hits: z.record(z.number()),
  token_total: z.number(),
  token_sampled: z.number(),
  p95_latency_ms: z.number(),
  latency_sampled: z.number(),
});

export const CustomersResponseSchema = z.array(z.object({
  customer_id: z.string(),
  customer_name: z.string(),
  category_count: z.number(),
  updated_at: z.string(),
  locale: z.string(),
  region: z.string(),
}));

export const CapabilitiesResponseSchema = z.array(z.object({
  id: z.string(),
  product_category: z.string(),
  spec_constraints: z.record(z.unknown()),
  is_active: z.boolean(),
}));

export const QuotationsResponseSchema = z.object({
  items: z.array(z.object({
    id: z.string(),
    quotation_id: z.string(),
    customer_id: z.string(),
    product_category: z.string(),
    product_spec: z.record(z.unknown()),
    quantity: z.number(),
    unit_price: z.number().nullable(),
    unit: z.string().nullable(),
    confidence: z.string(),
    source: z.string(),
    status: z.string(),
    discount: z.number().optional(),
    notes: z.string().optional(),
    spec_hash: z.string(),
    effective_from: z.string(),
    is_active: z.boolean(),
    created_at: z.string(),
  })),
  total: z.number(),
});

export type EventsResponse = z.infer<typeof EventsResponseSchema>;
export type DashboardResponse = z.infer<typeof DashboardResponseSchema>;
export type CustomersResponse = z.infer<typeof CustomersResponseSchema>;
export type CapabilitiesResponse = z.infer<typeof CapabilitiesResponseSchema>;
export type QuotationsResponse = z.infer<typeof QuotationsResponseSchema>;
