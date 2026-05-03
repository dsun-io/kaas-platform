import { describe, it, expect } from 'vitest';
import {
  EventsResponseSchema,
  DashboardResponseSchema,
  CustomersResponseSchema,
  CapabilitiesResponseSchema,
  QuotationsResponseSchema,
} from '../responses';

describe('EventsResponseSchema', () => {
  it('validates a valid events paginated response', () => {
    const result = EventsResponseSchema.safeParse({
      items: [
        {
          id: 'evt-1', event_type: 'chat.turn', event_source: 'backend',
          schema_version: 1, actor_id: 'user-1', tenant_id: 't1',
          session_id: 's1', trace_id: 'tr-1',
          payload: { raw_text: 'hello' },
          created_at: new Date().toISOString(), sampled: false,
        },
      ],
      total: 1, page: 1, page_size: 20,
    });
    expect(result.success).toBe(true);
  });

  it('rejects events response with missing total', () => {
    const result = EventsResponseSchema.safeParse({
      items: [],
      page: 1, page_size: 20,
    });
    expect(result.success).toBe(false);
  });

  it('validates items with optional fields omitted', () => {
    const result = EventsResponseSchema.safeParse({
      items: [
        {
          id: 'evt-2', event_type: 'quote.request', event_source: 'frontend',
          schema_version: 1, tenant_id: 't1',
          payload: {}, created_at: new Date().toISOString(),
        },
      ],
      total: 1, page: 1, page_size: 20,
    });
    expect(result.success).toBe(true);
  });
});

describe('DashboardResponseSchema', () => {
  it('validates a valid dashboard summary', () => {
    const result = DashboardResponseSchema.safeParse({
      range: '7d', quotations_total: 310, quotations_sampled: 75,
      active_customers: 8, customers_sampled: 3,
      dataset_hits: { L1_共通: 15, L2_牛栏网_产品: 20 },
      token_total: 125000, token_sampled: 30000,
      p95_latency_ms: 320, latency_sampled: 80,
    });
    expect(result.success).toBe(true);
  });

  it('rejects dashboard with string token_total', () => {
    const result = DashboardResponseSchema.safeParse({
      range: 'today', quotations_total: 42, quotations_sampled: 10,
      active_customers: 5, customers_sampled: 2,
      dataset_hits: {}, token_total: '125000', token_sampled: 30000,
      p95_latency_ms: 320, latency_sampled: 80,
    });
    expect(result.success).toBe(false);
  });
});

describe('CustomersResponseSchema', () => {
  it('validates a valid customers array', () => {
    const result = CustomersResponseSchema.safeParse([
      { customer_id: 'cust-1', customer_name: '联佳五金', category_count: 2,
        updated_at: new Date().toISOString(), locale: 'zh-CN', region: 'cn-north' },
      { customer_id: 'cust-2', customer_name: '客户B', category_count: 1,
        updated_at: new Date().toISOString(), locale: 'zh-CN', region: 'cn-south' },
    ]);
    expect(result.success).toBe(true);
  });

  it('rejects non-array input', () => {
    const result = CustomersResponseSchema.safeParse({ items: [] });
    expect(result.success).toBe(false);
  });
});

describe('QuotationsResponseSchema', () => {
  it('validates a valid quotations paginated response', () => {
    const result = QuotationsResponseSchema.safeParse({
      items: [
        {
          id: 'q-1', quotation_id: 'Q-2025-0001', customer_id: 'cust-1',
          product_category: '牛栏网', product_spec: { 丝径: '2.5mm' },
          quantity: 1000, unit_price: 3.85, unit: 'm', confidence: 'high',
          source: 'quotations_db', status: 'matched',
          spec_hash: 'abc123', effective_from: new Date().toISOString(),
          is_active: true, created_at: new Date().toISOString(),
        },
      ],
      total: 1,
    });
    expect(result.success).toBe(true);
  });

  it('rejects quotation item with negative quantity', () => {
    const result = QuotationsResponseSchema.safeParse({
      items: [
        {
          id: 'q-1', quotation_id: 'Q-2025-0001', customer_id: 'cust-1',
          product_category: '牛栏网', product_spec: {},
          quantity: -5, unit_price: 3.85, confidence: 'high',
          source: 'quotations_db', status: 'matched',
          spec_hash: 'abc', effective_from: new Date().toISOString(),
          is_active: true, created_at: new Date().toISOString(),
        },
      ],
      total: 1,
    });
    expect(result.success).toBe(false);
  });
});

describe('CapabilitiesResponseSchema', () => {
  it('validates a valid capabilities array', () => {
    const result = CapabilitiesResponseSchema.safeParse([
      { id: 'cap-1', product_category: '牛栏网', spec_constraints: { 丝径: '1.5-4.0' }, is_active: true },
      { id: 'cap-2', product_category: '立柱', spec_constraints: { 高度: '1.5-3.0m' }, is_active: false },
    ]);
    expect(result.success).toBe(true);
  });

  it('rejects capability with boolean product_category', () => {
    const result = CapabilitiesResponseSchema.safeParse([
      { id: 'cap-1', product_category: true, spec_constraints: {}, is_active: true },
    ]);
    expect(result.success).toBe(false);
  });
});
