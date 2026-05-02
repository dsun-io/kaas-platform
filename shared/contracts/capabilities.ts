/**
 * Single source of truth: v2 design document §3.7 (capability management)
 */

export interface Capability {
  product_category: string;
  spec_constraints: Record<string, unknown>;
  is_active: boolean;
}

export interface CapabilityUpdate {
  customer_id: string;
  product_category: string;
  spec_constraints_before: Record<string, unknown>;
  spec_constraints_after: Record<string, unknown>;
  actor_id: string;
}
