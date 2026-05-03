import { describe, it, expect } from 'vitest';
import { CapabilitySchema, CapabilityUpdateSchema } from '@contracts/capabilities';

describe('CapabilitySchema', () => {
  it('validates a valid capability', () => {
    const result = CapabilitySchema.safeParse({
      product_category: '牛栏网',
      spec_constraints: { wire_diameter: '2.0mm' },
      is_active: true,
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing required fields', () => {
    const result = CapabilitySchema.safeParse({
      product_category: '牛栏网',
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid is_active type', () => {
    const result = CapabilitySchema.safeParse({
      product_category: '牛栏网',
      spec_constraints: {},
      is_active: 'yes',
    });
    expect(result.success).toBe(false);
  });
});

describe('CapabilityUpdateSchema', () => {
  it('validates a complete update payload', () => {
    const result = CapabilityUpdateSchema.safeParse({
      customer_id: 'cust-1',
      product_category: '石笼网',
      spec_constraints_before: { mesh: '5cm' },
      spec_constraints_after: { mesh: '10cm' },
      actor_id: 'admin-1',
    });
    expect(result.success).toBe(true);
  });

  it('rejects empty spec_constraints', () => {
    const result = CapabilityUpdateSchema.safeParse({
      customer_id: 'cust-1',
      product_category: '石笼网',
      spec_constraints_before: 'not-a-record',
      spec_constraints_after: {},
      actor_id: 'admin-1',
    });
    expect(result.success).toBe(false);
  });
});
