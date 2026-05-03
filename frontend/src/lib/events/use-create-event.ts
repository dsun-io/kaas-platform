'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { EVENT_PAYLOAD_SCHEMAS, LATEST_SCHEMA_VERSION, type EventType } from '@contracts/events';
import { enqueuePending } from './queue';
import { triggerFlush } from './flush-worker';
import { queryKeys } from '@/lib/query/keys';

interface CreateEventInput {
  event_type: EventType;
  event_source: 'frontend';
  payload: unknown;
  tenant_id?: string;
  actor_id?: string;
  session_id?: string;
  trace_id?: string;
}

/**
 * useCreateEvent — queue-based event write mutation (§11.10).
 *
 * Flow:
 *   1. Zod-parse payload against the matching EVENT_PAYLOAD_SCHEMAS entry
 *   2. Write to IndexedDB pending queue
 *   3. Trigger flush (immediate + background)
 *   4. Invalidate events list query if on events page
 */
export function useCreateEvent() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: CreateEventInput) => {
      const schemaVersion = LATEST_SCHEMA_VERSION[input.event_type];
      const schemaKey: `${EventType}:${number}` = `${input.event_type}:${schemaVersion}`;
      const schema = EVENT_PAYLOAD_SCHEMAS[schemaKey];

      if (!schema) {
        throw new Error(`No schema registered for ${schemaKey}`);
      }

      // Zod-parse payload — throw on invalid input
      const parsedPayload = schema.parse(input.payload);

      const id = await enqueuePending({
        event_type: input.event_type,
        schema_version: schemaVersion,
        payload: parsedPayload,
        event_source: 'frontend',
        tenant_id: input.tenant_id,
        actor_id: input.actor_id,
        session_id: input.session_id,
        trace_id: input.trace_id,
      });

      // Trigger immediate flush
      triggerFlush();

      return id;
    },
    onSuccess: () => {
      // Invalidate events list to reflect new event
      queryClient.invalidateQueries({ queryKey: queryKeys.events.all });
    },
  });
}
