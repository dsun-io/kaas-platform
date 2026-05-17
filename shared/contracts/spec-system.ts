/**
 * Spec System v1 — Category → Attribute → SKU → Price
 *
 * Single source of truth: Notion "Kaas Wizard + SKU + Price" §9.4
 */
import { z } from 'zod';

// ── Enums ──────────────────────────────────────────────────────────────────

export const GroupCodeSchema = z.enum([
  'identity',
  'variant',
  'spec',
  'pricing',
  'temporal',
]);
export type GroupCode = z.infer<typeof GroupCodeSchema>;

export const DataTypeSchema = z.enum([
  'number',
  'text',
  'enum',
  'boolean',
]);
export type DataType = z.infer<typeof DataTypeSchema>;

export const AttrScopeSchema = z.enum([
  'public',
  'private',
  'proposal',
]);
export type AttrScope = z.infer<typeof AttrScopeSchema>;

// ── Category ───────────────────────────────────────────────────────────────

export const CategoryNodeSchema: z.ZodType<CategoryNode> = z.lazy(() =>
  z.object({
    id: z.number(),
    code: z.string(),
    name: z.string(),
    parent_id: z.number().nullable(),
    sort_order: z.number(),
    children: z.array(CategoryNodeSchema).default([]),
  }),
) as z.ZodType<CategoryNode>;
export interface CategoryNode {
  id: number;
  code: string;
  name: string;
  parent_id: number | null;
  sort_order: number;
  children: CategoryNode[];
}

// ── Spec Attribute ─────────────────────────────────────────────────────────

export const AttributeValueOutSchema = z.object({
  id: z.number(),
  value_code: z.string(),
  label: z.string(),
  sort_order: z.number(),
});
export type AttributeValueOut = z.infer<typeof AttributeValueOutSchema>;

export const SpecAttributeOutSchema = z.object({
  id: z.number(),
  code: z.string(),
  name: z.string(),
  group_code: z.string(),
  data_type: z.string(),
  unit: z.string().nullable(),
  unit_group: z.string().nullable(),
  scope: z.string(),
  source: z.string().nullable(),
  values: z.array(AttributeValueOutSchema).default([]),
});
export type SpecAttributeOut = z.infer<typeof SpecAttributeOutSchema>;

// ── Category ↔ Attribute Binding ───────────────────────────────────────────

export const BindingWithAttributeSchema = z.object({
  id: z.number(),
  category_id: z.number(),
  attribute_id: z.number(),
  group_code: z.string(),
  is_required: z.boolean(),
  sort_order: z.number(),
  default_value: z.unknown().nullable(),
  validation_rules: z.unknown().nullable(),
  attribute: SpecAttributeOutSchema,
});
export type BindingWithAttribute = z.infer<typeof BindingWithAttributeSchema>;

// ── SKU ────────────────────────────────────────────────────────────────────

export const SkuPriceOutSchema = z.object({
  id: z.number(),
  price: z.number(),
  price_unit: z.string(),
  effective_from: z.string(),
  effective_to: z.string().nullable(),
  status: z.string(),
  min_qty: z.number().nullable(),
  tier_rules: z.unknown().nullable(),
});
export type SkuPriceOut = z.infer<typeof SkuPriceOutSchema>;

export const SkuOutSchema = z.object({
  id: z.number(),
  category_id: z.number(),
  spec_values: z.record(z.unknown()),
  spec_hash: z.string(),
  revision: z.number(),
  schema_version: z.number().nullable(),
  weight_kg: z.number().nullable(),
  price: SkuPriceOutSchema.nullable(),
});
export type SkuOut = z.infer<typeof SkuOutSchema>;

// ── Wizard Submit ──────────────────────────────────────────────────────────

export const SpecValueEntrySchema = z.object({
  attribute_id: z.number(),
  value: z.unknown(),
  value_code: z.string().nullable().optional(),
});
export type SpecValueEntry = z.infer<typeof SpecValueEntrySchema>;

export const PricingPayloadSchema = z.object({
  price: z.number().positive(),
  price_unit: z.string(),
  effective_from: z.string(),
  effective_to: z.string().nullable().optional(),
  min_qty: z.number().positive().nullable().optional(),
  tier_rules: z.unknown().nullable().optional(),
  note: z.string().nullable().optional(),
  change_reason: z.string().min(1),
});
export type PricingPayload = z.infer<typeof PricingPayloadSchema>;

export const WizardSubmitRequestSchema = z.object({
  category_id: z.number(),
  spec_values: z.record(SpecValueEntrySchema),
  pricing: PricingPayloadSchema.nullable().optional(),
  weight_kg: z.number().positive().nullable().optional(),
  description: z.string().nullable().optional(),
});
export type WizardSubmitRequest = z.infer<typeof WizardSubmitRequestSchema>;

export const WizardSubmitResponseSchema = z.object({
  sku_id: z.number(),
  price_id: z.number().nullable(),
  spec_hash: z.string(),
  is_new_sku: z.boolean(),
  revision: z.number(),
});
export type WizardSubmitResponse = z.infer<typeof WizardSubmitResponseSchema>;

// ── Attribute Proposal ─────────────────────────────────────────────────────

export const AttributeProposalRequestSchema = z.object({
  category_id: z.number(),
  group_code: z.string(),
  proposed_name: z.string().min(1),
  proposed_type: z.string(),
  proposed_unit: z.string().nullable().optional(),
  proposed_unit_group: z.string().nullable().optional(),
  sample_values: z.array(z.string()).nullable().optional(),
});
export type AttributeProposalRequest = z.infer<typeof AttributeProposalRequestSchema>;

export const AttributeProposalResponseSchema = z.object({
  id: z.number(),
  status: z.string(),
});
export type AttributeProposalResponse = z.infer<typeof AttributeProposalResponseSchema>;

// ── Quote Record (from v_quote_records view) ──────────────────────────────

export const QuoteRecordSchema = z.object({
  id: z.number(),
  tenant_id: z.string(),
  customer_id: z.string().nullable(),
  category_code: z.string(),
  category_name: z.string(),
  spec_values: z.record(z.unknown()),
  spec_hash: z.string(),
  sku_id: z.number().nullable(),
  price_id: z.number().nullable(),
  schema_version: z.number().nullable(),
  quantity: z.number(),
  unit_price: z.number().nullable(),
  total_price: z.number().nullable(),
  status: z.string(),
  created_at: z.string(),
});
export type QuoteRecord = z.infer<typeof QuoteRecordSchema>;
