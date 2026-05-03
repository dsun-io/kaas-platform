/**
 * Single source of truth: v2 design document §3.7 (quote flow)
 */
import { z } from 'zod';

export const QuoteItemSchema = z.object({
  product_category: z.string(),
  product_spec: z.record(z.unknown()),
  quantity: z.number().int().positive(),
  unit_price: z.number().nullable(),
  confidence: z.enum(['high', 'medium', 'low']),
});

export const QuoteRequestSchema = z.object({
  session_id: z.string(),
  customer_id: z.string(),
  items: z.array(QuoteItemSchema),
});

export const QuoteResponseSchema = z.object({
  session_id: z.string(),
  customer_id: z.string(),
  items: z.array(QuoteItemSchema),
  status: z.enum(['matched', 'estimated', 'spec_not_supported']),
  source: z.enum(['quotations_db', 'L1_L2_formula']),
});

export type QuoteItem = z.infer<typeof QuoteItemSchema>;
export type QuoteRequest = z.infer<typeof QuoteRequestSchema>;
export type QuoteResponse = z.infer<typeof QuoteResponseSchema>;
