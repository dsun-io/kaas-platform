import { describe, it, expect } from 'vitest';
import { EVENT_PAYLOAD_SCHEMAS, LATEST_SCHEMA_VERSION, AuditAccessPayloadSchema } from '@contracts/events';
import type { EventType } from '@contracts/events';

describe('EVENT_PAYLOAD_SCHEMAS', () => {
  it('registers all 6 event types with their latest version', () => {
    const types = Object.keys(LATEST_SCHEMA_VERSION) as EventType[];
    expect(types).toHaveLength(6);

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
