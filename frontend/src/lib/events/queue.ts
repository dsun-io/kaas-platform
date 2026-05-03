import { getDb, isIndexedDbAvailable, setIndexedDbUnavailable } from './db';
import type { PendingEvent, DeadLetterEvent } from './types';

// ── Memory fallback queue (private mode / IndexedDB unavailable) ──

let memoryQueue: PendingEvent[] = [];
let memoryIdCounter = 0;

// ── Public API ──────────────────────────────────────────────────────

export async function enqueuePending(
  event: Omit<PendingEvent, 'id' | 'created_at' | 'attempts' | 'next_retry_at'>,
): Promise<number> {
  const record: PendingEvent = {
    ...event,
    created_at: Date.now(),
    attempts: 0,
    next_retry_at: Date.now(),
  };

  try {
    if (!isIndexedDbAvailable()) {
      return memoryEnqueue(record);
    }

    const db = await getDb();
    const id = await db.add('pending', record);
    return id as number;
  } catch (err) {
    console.warn('[events/queue] IndexedDB enqueue failed, falling back to memory:', err);
    setIndexedDbUnavailable();
    return memoryEnqueue(record);
  }
}

export async function getPendingBatch(limit: number = 10): Promise<PendingEvent[]> {
  try {
    if (!isIndexedDbAvailable()) {
      return memoryGetBatch(limit);
    }

    const db = await getDb();
    const now = Date.now();
    const tx = db.transaction('pending', 'readonly');
    const index = tx.store.index('next_retry_at');
    const range = IDBKeyRange.upperBound(now);
    const items: PendingEvent[] = [];
    let cursor = await index.openCursor(range, 'next');

    while (cursor && items.length < limit) {
      items.push(cursor.value);
      cursor = await cursor.continue();
    }

    await tx.done;
    return items;
  } catch (err) {
    console.warn('[events/queue] IndexedDB read failed, falling back to memory:', err);
    setIndexedDbUnavailable();
    return memoryGetBatch(limit);
  }
}

export async function markSent(id: number): Promise<void> {
  try {
    if (!isIndexedDbAvailable()) {
      memoryMarkSent(id);
      return;
    }

    const db = await getDb();
    await db.delete('pending', id);
  } catch (err) {
    console.warn('[events/queue] IndexedDB delete failed:', err);
    setIndexedDbUnavailable();
    memoryMarkSent(id);
  }
}

export async function moveToDead(id: number, lastError: string): Promise<void> {
  try {
    if (!isIndexedDbAvailable()) {
      memoryMoveToDead(id, lastError);
      return;
    }

    const db = await getDb();
    const record = await db.get('pending', id);
    if (!record) return;

    const deadRecord: DeadLetterEvent = {
      ...record,
      original_id: record.id ?? id,
      moved_at: Date.now(),
      last_error: lastError,
    };

    await db.add('dead_letter', deadRecord);
    await db.delete('pending', id);
  } catch (err) {
    console.error('[events/queue] IndexedDB moveToDead failed:', err);
  }
}

// ── Memory queue implementation ────────────────────────────────────

function memoryEnqueue(record: PendingEvent): number {
  const id = ++memoryIdCounter;
  memoryQueue.push({ ...record, id });
  return id;
}

function memoryGetBatch(limit: number): PendingEvent[] {
  const now = Date.now();
  const batch = memoryQueue
    .filter((e) => e.next_retry_at <= now)
    .sort((a, b) => a.created_at - b.created_at)
    .slice(0, limit);
  return batch;
}

function memoryMarkSent(id: number): void {
  memoryQueue = memoryQueue.filter((e) => e.id !== id);
}

function memoryMoveToDead(id: number, lastError: string): void {
  const idx = memoryQueue.findIndex((e) => e.id === id);
  if (idx !== -1) {
    console.error('event_dead_letter', { ...memoryQueue[idx], last_error: lastError });
    memoryQueue.splice(idx, 1);
  }
}
