"use client";

import { useState } from "react";
import { EventFilters } from "./components/event-filters";
import { EventTable } from "./components/event-table";
import { EventDetailSheet } from "./components/event-detail";
import {
  useEvents,
  type EventFilters as EventFiltersType,
} from "./hooks/use-events";
import { usePageView } from "@/lib/events/use-page-view";
import { RouteGuard } from "@/components/route-guard";
import { PageHeader, SectionCard } from "@/components/shared";
import { usePersistentState } from "@/lib/hooks/use-persistent-state";
import { PaginationBar } from "@/components/shared/pagination-bar";

/** 与后端 `list_events_api` 的默认 page_size 一致（上限 100） */
const EVENTS_PAGE_SIZE = 20;

export default function EventsPage() {
  usePageView({ resource_id: "/events" });
  const [filters, setFilters] = usePersistentState<EventFiltersType>(
    "ui:events:filters",
    {},
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // C25：页码不入持久化筛选（刷新回到第 1 页）；筛选变化时也回到第 1 页
  const [page, setPage] = useState(1);

  const { data, isLoading, isFetching } = useEvents({
    ...filters,
    page,
    page_size: EVENTS_PAGE_SIZE,
  });

  const events = data?.items ?? [];
  const selectedEvent = selectedId
    ? (events.find((e) => e.id === selectedId) ?? null)
    : null;

  return (
    <RouteGuard adminOnly>
      <div className="space-y-6">
        <PageHeader title="事件审计" description="系统事件与操作审计记录" />

        <SectionCard title="过滤条件">
          <EventFilters
            filters={filters}
            onChange={(next) => {
              setFilters(next);
              setPage(1);
            }}
          />
        </SectionCard>

        <SectionCard
          title="事件列表"
          action={
            data ? (
              <span className="text-sm font-normal text-muted-foreground">
                共 {data.total} 条
              </span>
            ) : undefined
          }
        >
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
          <PaginationBar
            page={page}
            pageSize={EVENTS_PAGE_SIZE}
            total={data?.total ?? 0}
            currentCount={events.length}
            loading={isFetching}
            onPageChange={setPage}
            ariaLabel="事件列表分页"
          />
        </SectionCard>

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
    </RouteGuard>
  );
}
