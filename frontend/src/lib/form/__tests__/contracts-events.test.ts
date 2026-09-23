import { describe, it, expect } from 'vitest';
import { EVENT_PAYLOAD_SCHEMAS, LATEST_SCHEMA_VERSION, AuditAccessPayloadSchema } from '@contracts/events';
import type { EventType } from '@contracts/events';

describe('EVENT_PAYLOAD_SCHEMAS', () => {
  it('registers all 11 event types with their latest version', () => {
    const types = Object.keys(LATEST_SCHEMA_VERSION) as EventType[];
    expect(types).toHaveLength(11);

    for (const t of types) {
      const version = LATEST_SCHEMA_VERSION[t];
      const key = `${t}:${version}` as const;
      expect(EVENT_PAYLOAD_SCHEMAS[key]).toBeDefined();
    }
  });

  it('each schema key matches known event types', () => {
    const keys = Object.keys(EVENT_PAYLOAD_SCHEMAS);
    for (const k of keys) {
      const [type, version] = k.split(':') as [EventType, string];
      expect(LATEST_SCHEMA_VERSION[type]).toBe(Number(version));
    }
  });
});

describe('workstation & intel event payloads', () => {
  const cases: Array<[string, unknown]> = [
    ['market.selected', { market_id: 'm1', market_name: '华北丝网', actor_id: 'a1' }],
    ['lead.discovered', { lead_id: 'l1', source: 'manual', actor_id: 'a1' }],
    ['lead.enriched', { lead_id: 'l1', fields_added: ['phone'], actor_id: 'a1' }],
    ['lead.outreach_ready', { lead_id: 'l1', channel: 'wechat', actor_id: 'a1' }],
    ['outreach.sent', { lead_id: 'l1', channel: 'wechat', actor_id: 'a1' }],
    ['outreach.replied', { lead_id: 'l1', channel: 'wechat', reply_summary: null, actor_id: 'a1' }],
    ['quotation.converted', { quotation_id: 'q1', order_id: null, customer_id: 'c1', actor_id: 'a1' }],
    ['order.shipped', { order_id: 'o1', shipment_ref: null, actor_id: 'a1' }],
    ['shipment.documented', { order_id: 'o1', doc_id: null, doc_type: 'packing_list', actor_id: 'a1' }],
    ['capability.update', {
      customer_id: 'c1', product_category: 'niulanwang',
      spec_constraints_before: {}, spec_constraints_after: { mesh: '5x10' }, actor_id: 'a1',
    }],
  ];

  it.each(cases)('%s payload validates', (type, payload) => {
    const version = LATEST_SCHEMA_VERSION[type as EventType];
    const schema = EVENT_PAYLOAD_SCHEMAS[`${type}:${version}` as keyof typeof EVENT_PAYLOAD_SCHEMAS];
    expect(schema!.safeParse(payload).success).toBe(true);
  });
});

describe('AuditAccessPayloadSchema', () => {
  it('validates a page access payload', () => {
    const result = AuditAccessPayloadSchema.safeParse({
      resource_type: 'page',
      resource_id: '/dashboard',
      actor_id: 'admin-1',
      ip: null,
    });
    expect(result.success).toBe(true);
  });

  it('validates an api access payload with ip', () => {
    const result = AuditAccessPayloadSchema.safeParse({
      resource_type: 'api',
      resource_id: 'admin/tenants/reload',
      actor_id: 'admin-1',
      ip: '192.168.1.1',
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid resource_type', () => {
    const result = AuditAccessPayloadSchema.safeParse({
      resource_type: 'file',
      resource_id: '/tmp/x',
      actor_id: 'admin-1',
      ip: null,
    });
    expect(result.success).toBe(false);
  });
});
