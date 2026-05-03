/**
 * Single source of truth: v2 design document §3.7 (capability management)
 */
import { z } from 'zod';

export const CapabilitySchema = z.object({
  product_category: z.string(),
  spec_constraints: z.record(z.unknown()),
  is_active: z.boolean(),
});

export const CapabilityUpdateSchema = z.object({
  customer_id: z.string(),
  product_category: z.string(),
  spec_constraints_before: z.record(z.unknown()),
  spec_constraints_after: z.record(z.unknown()),
  actor_id: z.string(),
});

export type Capability = z.infer<typeof CapabilitySchema>;
export type CapabilityUpdate = z.infer<typeof CapabilityUpdateSchema>;
