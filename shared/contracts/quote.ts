/**
 * Single source of truth: v2 design document §3.7 (quote flow)
 */
import { z } from 'zod';

// ── V1 (legacy) ────────────────────────────────────────────────────────────

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

// ── V2 (INT-R3+) ───────────────────────────────────────────────────────────

export const AccessoryRequestSchema = z.object({
  product_category: z.string(),
  product_type: z.string().optional(),
  height: z.number().optional(),
  bundle_size: z.number().optional(),
  quantity: z.number().int().positive().default(1),
});
export type AccessoryRequest = z.infer<typeof AccessoryRequestSchema>;

export const QuoteV2RequestSchema = z.object({
  product_category: z.string(),
  product_type: z.string().optional(),
  wire_diameter: z.string().optional(),
  height: z.number().optional(),
  mesh_width: z.number().optional(),
  mesh_spec: z.string().optional(),
  roll_length: z.number().optional(),
  quantity: z.number().int().positive().default(1),
  accessories: z.array(AccessoryRequestSchema).optional().default([]),
  province: z.string().optional(),
  need_invoice: z.boolean().optional().default(false),
  tax_rate: z.number().optional(),
  preferred_carrier: z.string().optional(),
});
export type QuoteV2Request = z.infer<typeof QuoteV2RequestSchema>;

export const TierItemSchema = z.object({
  label: z.string(),
  margin_rate: z.number().optional(),
  unit_price: z.number(),
  subtotal: z.number(),
  total: z.number(),
});
export type TierItem = z.infer<typeof TierItemSchema>;

export const FreightOptionSchema = z.object({
  carrier: z.string(),
  amount: z.number(),
});
export type FreightOption = z.infer<typeof FreightOptionSchema>;

export const FreightInfoSchema = z.object({
  province: z.string().optional(),
  chosen: FreightOptionSchema.nullable().optional(),
  options: z.array(FreightOptionSchema).default([]),
  status: z.string().default('freight_missing'),
});
export type FreightInfo = z.infer<typeof FreightInfoSchema>;

export const MainLineSchema = z.object({
  product_category: z.string(),
  spec_summary: z.string(),
  quantity: z.number(),
  unit: z.string().default('卷'),
  weight_kg: z.number().nullable().optional(),
  base_cost: z.number().optional(),
  tiers: z.array(TierItemSchema).default([]),
  status: z.string().default('matched'),
});
export type MainLine = z.infer<typeof MainLineSchema>;

export const AccessoryLineSchema = z.object({
  product_category: z.string(),
  spec_summary: z.string(),
  quantity: z.number(),
  unit: z.string(),
  total: z.number().nullable().optional(),
  status: z.string().default('matched'),
});
export type AccessoryLine = z.infer<typeof AccessoryLineSchema>;

export const TotalsSchema = z.object({
  low: z.number().default(0),
  standard: z.number().default(0),
  high: z.number().default(0),
});
export type Totals = z.infer<typeof TotalsSchema>;

export const QuoteV2ResponseSchema = z.object({
  status: z.string(),
  product_category: z.string(),
  main_line: MainLineSchema,
  accessory_lines: z.array(AccessoryLineSchema).default([]),
  freight: FreightInfoSchema.nullable().optional(),
  totals: TotalsSchema.default({ low: 0, standard: 0, high: 0 }),
  notes: z.array(z.string()).default([]),
  copyable_script: z.string().default(''),
});
export type QuoteV2Response = z.infer<typeof QuoteV2ResponseSchema>;

// ── Quotable Spec Item (tuple for client-side cascading) ────────────────────

export const QuotableSpecItemSchema = z.object({
  product_type: z.string().nullable().optional(),
  wire_diameter: z.string().nullable().optional(),
  height: z.number().nullable().optional(),
  mesh_width: z.number().nullable().optional(),
  mesh_spec: z.string().nullable().optional(),
  roll_length: z.number().nullable().optional(),
});
export type QuotableSpecItem = z.infer<typeof QuotableSpecItemSchema>;

// ── Product Specs ──────────────────────────────────────────────────────────

export const ProductSpecsOptionsSchema = z.object({
  product_category: z.string(),
  options: z.object({
    product_types: z.array(z.string()).default([]),
    wire_diameters: z.array(z.string()).default([]),
    heights: z.array(z.number()).default([]),
    mesh_widths: z.array(z.number()).default([]),
    mesh_specs: z.array(z.string()).default([]),
    roll_lengths: z.array(z.number()).default([]),
    bundle_sizes: z.array(z.number()).default([]),
  }),
  quotable_specs: z.array(QuotableSpecItemSchema).default([]),
  accessory_categories: z.array(z.string()).default([]),
  weight_kg: z.number().nullable().optional(),
});
export type ProductSpecsOptions = z.infer<typeof ProductSpecsOptionsSchema>;
