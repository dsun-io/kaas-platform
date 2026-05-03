import type { EventType } from '@contracts/events';

/** Pending event stored in IndexedDB pending store (§11.9 Schema). */
export interface PendingEvent {
  id?: number;
  event_type: EventType;
  schema_version: number;
  payload: unknown;
  created_at: number;
  attempts: number;
  next_retry_at: number;
  event_source: 'frontend' | 'backend';
  tenant_id?: string;
  actor_id?: string;
  session_id?: string;
  trace_id?: string;
}

/** Dead-letter event stored in IndexedDB dead_letter store. */
export interface DeadLetterEvent extends PendingEvent {
  original_id: number;
  moved_at: number;
  last_error: string;
}
