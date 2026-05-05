"use client";

import { apiClient } from "@/lib/api/client";
import { queryKeys } from "@/lib/query/keys";
import { useSafeQuery } from "@/lib/query/safe-query";
import { EventsResponseSchema } from "@/lib/schemas/responses";
import type { EventsResponse } from "@/lib/schemas/responses";

export interface EventFilters {
  tenant_id?: string;
  event_type?: string;
  schema_version?: number;
  created_at_from?: string;
  created_at_to?: string;
  sampled?: boolean;
  actor_id?: string;
  event_source?: string;
}

export function useEvents(filters: EventFilters = {}) {
  return useSafeQuery({
    queryKey: queryKeys.events.list(filters as Record<string, unknown>),
    queryFn: async () => {
      const params = new URLSearchParams();
      Object.entries(filters).forEach(([key, value]) => {
        if (value !== undefined && value !== "" && value !== null) {
          params.set(key, String(value));
        }
      });
      const query = params.toString();
      const { data } = await apiClient.get<EventsResponse>(
        `/events${query ? `?${query}` : ""}`,
      );
      return data;
    },
    schema: EventsResponseSchema,
  });
}
