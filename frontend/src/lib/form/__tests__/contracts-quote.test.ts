import { describe, it, expect } from 'vitest';
import { QuoteRequestSchema, QuoteResponseSchema, QuoteItemSchema } from '@contracts/quote';

describe('QuoteRequestSchema', () => {
  it('validates a valid quote request', () => {
    const result = QuoteRequestSchema.safeParse({
      session_id: 's1',
      customer_id: 'cust-1',
      items: [{
        product_category: '牛栏网',
        product_spec: {},
        quantity: 100,
        unit_price: null,
        confidence: 'high',
      }],
    });
    expect(result.success).toBe(true);
  });

  it('rejects negative quantity', () => {
    const result = QuoteRequestSchema.safeParse({
      session_id: 's1',
      customer_id: 'cust-1',
      items: [{
        product_category: '牛栏网',
        product_spec: {},
        quantity: -1,
        unit_price: null,
        confidence: 'high',
      }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid confidence value', () => {
    const result = QuoteRequestSchema.safeParse({
      session_id: 's1',
      customer_id: 'cust-1',
      items: [{
        product_category: '牛栏网',
        product_spec: {},
        quantity: 100,
        unit_price: 50,
        confidence: 'super_high',
      }],
    });
    expect(result.success).toBe(false);
  });
});

describe('QuoteResponseSchema', () => {
  it('validates matched response with unit_price', () => {
    const result = QuoteResponseSchema.safeParse({
      session_id: 's1',
      customer_id: 'cust-1',
      items: [{
        product_category: '牛栏网',
        product_spec: {},
        quantity: 100,
        unit_price: 12.5,
        confidence: 'high',
      }],
      status: 'matched',
      source: 'quotations_db',
    });
    expect(result.success).toBe(true);
  });

  it('validates estimated response with null unit_price', () => {
    const result = QuoteResponseSchema.safeParse({
      session_id: 's1',
      customer_id: 'cust-1',
      items: [{
        product_category: '石笼网',
        product_spec: { mesh: '10cm' },
        quantity: 50,
        unit_price: null,
        confidence: 'low',
      }],
      status: 'estimated',
      source: 'L1_L2_formula',
    });
    expect(result.success).toBe(true);
  });

  it('rejects unknown status', () => {
    const result = QuoteResponseSchema.safeParse({
      session_id: 's1',
      customer_id: 'cust-1',
      items: [],
      status: 'pending',
      source: 'quotations_db',
    });
    expect(result.success).toBe(false);
  });
});

describe('QuoteItemSchema', () => {
  it('validates item with nullable unit_price', () => {
    const result = QuoteItemSchema.safeParse({
      product_category: '镀锌',
      product_spec: { thickness: '2mm' },
      quantity: 200,
      unit_price: null,
      confidence: 'medium',
    });
    expect(result.success).toBe(true);
  });
});
