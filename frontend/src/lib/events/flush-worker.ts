import { apiClient } from '@/lib/api/client';
import { getPendingBatch, markSent, moveToDead } from './queue';
import { captureException } from '@/lib/error/sentry';
const MAX_ATTEMPTS = 10;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 300_000; // 5 min

let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushing = false;

function backoffDelay(attempts: number): number {
  return Math.min(Math.pow(2, attempts) * BASE_DELAY_MS, MAX_DELAY_MS);
}

async function flushBatch(): Promise<void> {
  if (flushing) return;
  flushing = true;

  try {
    const batch = await getPendingBatch(10);

    for (const event of batch) {
      if (event.id == null) continue;

      try {
        await apiClient.post('/events', {
          schema_version: event.schema_version,
          event_type: event.event_type,
          event_source: event.event_source,
          tenant_id: event.tenant_id,
          actor_id: event.actor_id,
          session_id: event.session_id,
          trace_id: event.trace_id,
          payload: event.payload,
        });

        await markSent(event.id);
      } catch (err) {
        const attempts = event.attempts + 1;
        const message = err instanceof Error ? err.message : String(err);

        if (attempts > MAX_ATTEMPTS) {
          captureException(new Error('event_dead_letter'), {
            event_type: event.event_type,
            attempts,
            last_error: message,
          });
          await moveToDead(event.id, message);
        } else {
          // Update retry with exponential backoff
          try {
            const db = (await import('./db')).getDb();
            (await db).put('pending', {
              ...event,
              attempts,
              next_retry_at: Date.now() + backoffDelay(attempts),
            });
          } catch {
            // IndexedDB may be unavailable; event will retry on next boot
          }
        }
      }
    }
  } catch (err) {
    captureException(err, { context: 'events-flush-batch' });
  } finally {
    flushing = false;
  }
}

/** Trigger a flush cycle. Debounced — multiple calls within 1s only fire once. */
export function triggerFlush(): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(flushBatch, 100);
}

/** Start periodic flush (30s interval). Call once on app boot. */
export function startFlushWorker(): void {
  if (typeof window === 'undefined') return;

  // Flush on boot
  triggerFlush();

  // Flush on online event
  window.addEventListener('online', triggerFlush);

  // Periodic flush every 30s
  setInterval(triggerFlush, 30_000);
}
