"use client";

import { useState } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { EventFilters } from "./components/event-filters";
import { EventTable } from "./components/event-table";
import { EventDetailSheet } from "./components/event-detail";
import {
  useEvents,
  type EventFilters as EventFiltersType,
} from "./hooks/use-events";
import { usePageView } from "@/lib/events/use-page-view";

export default function EventsPage() {
  usePageView({ resource_id: "/events" });
  const [filters, setFilters] = useState<EventFiltersType>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { data, isLoading } = useEvents(filters);

  const events = data?.items ?? [];
  const selectedEvent = selectedId
    ? (events.find((e) => e.id === selectedId) ?? null)
    : null;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">事件审计</h1>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle>过滤条件</CardTitle>
        </CardHeader>
        <CardContent>
          <EventFilters filters={filters} onChange={setFilters} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle>
            事件列表
            {data && (
              <span className="ml-2 text-sm font-normal text-muted-foreground">
                共 {data.total} 条
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <EventTable
            events={events.map((e) => ({
              id: e.id,
              event_type: e.event_type,
              schema_version: e.schema_version,
              actor_id: e.actor_id ?? "",
              created_at: e.created_at,
              sampled: e.sampled ?? false,
              event_source: e.event_source,
            }))}
            onSelect={(event) => setSelectedId(event.id)}
            loading={isLoading}
          />
        </CardContent>
      </Card>

      <EventDetailSheet
        event={
          selectedEvent
            ? {
                id: selectedEvent.id,
                event_type: selectedEvent.event_type,
                schema_version: selectedEvent.schema_version,
                tenant_id: selectedEvent.tenant_id,
                actor_id: selectedEvent.actor_id ?? "",
                session_id: selectedEvent.session_id ?? "",
                trace_id: selectedEvent.trace_id ?? "",
                event_source: selectedEvent.event_source,
                payload: selectedEvent.payload,
                created_at: selectedEvent.created_at,
                sampled: selectedEvent.sampled ?? false,
              }
            : null
        }
        onClose={() => setSelectedId(null)}
      />
    </div>
  );
}
