import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  getDb: vi.fn(),
  isIndexedDbAvailable: vi.fn(() => false),
  setIndexedDbUnavailable: vi.fn(),
}));

describe('events queue (memory fallback)', () => {
  beforeEach(async () => {
    vi.resetModules();
  });

  async function getQueue() {
    return await import('../queue');
  }

  it('enqueuePending → getPendingBatch → markSent (happy path)', async () => {
    const queue = await getQueue();

    const id = await queue.enqueuePending({
      event_type: 'chat.turn',
      schema_version: 1,
      payload: { session_id: 's1', raw_text: 'hello' },
      event_source: 'frontend',
      tenant_id: 't1',
    });

    expect(id).toBeGreaterThan(0);

    const batch = await queue.getPendingBatch(10);
    expect(batch).toHaveLength(1);
    expect(batch[0]!.event_type).toBe('chat.turn');

    await queue.markSent(id);
    const after = await queue.getPendingBatch(10);
    expect(after).toHaveLength(0);
  });

  it('getPendingBatch respects limit', async () => {
    const queue = await getQueue();

    for (let i = 0; i < 5; i++) {
      await queue.enqueuePending({
        event_type: 'audit.access',
        schema_version: 1,
        payload: { resource_type: 'page', resource_id: `r${i}`, actor_id: 'a1', ip: null },
        event_source: 'frontend',
      });
    }

    const batch = await queue.getPendingBatch(3);
    expect(batch).toHaveLength(3);
  });

  it('handles all 6 event types', async () => {
    const queue = await getQueue();

    const types = [
      'audit.access',
      'capability.update',
      'chat.turn',
      'kb.edit',
      'quote.request',
      'quote.response',
    ] as const;

    for (const t of types) {
      await queue.enqueuePending({
        event_type: t,
        schema_version: 1,
        payload: {},
        event_source: 'frontend',
      });
    }

    const batch = await queue.getPendingBatch(10);
    expect(batch).toHaveLength(6);
  });

  it('moveToDead removes from pending', async () => {
    const queue = await getQueue();

    const id = await queue.enqueuePending({
      event_type: 'kb.edit',
      schema_version: 1,
      payload: { dataset_name: 'd1', chunk_id: null, action: 'create', actor_id: 'a1' },
      event_source: 'frontend',
    });

    await queue.moveToDead(id, 'test error');

    const batch = await queue.getPendingBatch(10);
    expect(batch).toHaveLength(0);
  });
});
