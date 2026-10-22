"use client";

/**
 * 事件审计（/events）—— 管理员视角的系统事件总表。
 *
 * 筛选口径（U-P1E / 审计 E3）：
 *  - **筛选进 URL**（`?tenant_id=&event_type=&actor_id=&event_source=`）：
 *    刷新/分享/浏览器前进后退都不丢筛选（原来放在 localStorage，刷新看似保留，
 *    但链接分享出去对方看到的是"全部"，且前后退不同步）；
 *  - **输入类筛选防抖 300ms**（空间 ID / 操作人）：原来每击键都打一次 /events；
 *  - 切换筛选回第 1 页（页码不持久化，见下方派生 page）。
 */
import { useMemo, useState } from "react";
import { EventFilters } from "./components/event-filters";
import { EventTable } from "./components/event-table";
import { EventDetailSheet } from "./components/event-detail";
import {
  useEvents,
  type EventFilters as EventFiltersType,
} from "./hooks/use-events";
import { usePageView } from "@/lib/events/use-page-view";
import { RouteGuard } from "@/components/route-guard";
import { ErrorState, PageHeader, SectionCard } from "@/components/shared";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import { useUrlState } from "@/lib/hooks/use-url-state";
import { PaginationBar } from "@/components/shared/pagination-bar";
import { normalizeApiError } from "@/lib/api/api-error";

/** 与后端 `list_events_api` 的默认 page_size 一致（上限 100） */
const EVENTS_PAGE_SIZE = 20;

/** 输入类筛选的防抖时长（毫秒）：停顿后才发请求，连续击键只落最后一次 */
const EVENTS_SEARCH_DEBOUNCE_MS = 300;

export default function EventsPage() {
  usePageView({ resource_id: "/events" });

  // 筛选入 URL：键名与后端查询参数一致，排障时可直观对照请求
  const [tenantId, setTenantId] = useUrlState("tenant_id", "");
  const [actorId, setActorId] = useUrlState("actor_id", "");
  const [eventType, setEventType] = useUrlState("event_type", "");
  const [eventSource, setEventSource] = useUrlState("event_source", "");
  // 输入即时回显（受控），查询用防抖后的值
  const debouncedTenantId = useDebouncedValue(
    tenantId,
    EVENTS_SEARCH_DEBOUNCE_MS,
  );
  const debouncedActorId = useDebouncedValue(
    actorId,
    EVENTS_SEARCH_DEBOUNCE_MS,
  );

  const [selectedId, setSelectedId] = useState<string | null>(null);

  // 页码不持久化；筛选签名变了就把 page「派生」回 1（不写 effect，避免多一轮渲染
  // 与 react-hooks/set-state-in-effect 告警；点下一页时再用当前签名落 page）。
  const filterKey = [
    debouncedTenantId,
    debouncedActorId,
    eventType,
    eventSource,
  ].join("\u0000");
  const [pageState, setPageState] = useState<{ key: string; page: number }>({
    key: filterKey,
    page: 1,
  });
  const page = pageState.key === filterKey ? pageState.page : 1;
  const setPage = (next: number) =>
    setPageState({ key: filterKey, page: Math.max(1, next) });

  const filters = useMemo<EventFiltersType>(
    () => ({
      ...(debouncedTenantId ? { tenant_id: debouncedTenantId } : {}),
      ...(debouncedActorId ? { actor_id: debouncedActorId } : {}),
      ...(eventType ? { event_type: eventType } : {}),
      ...(eventSource ? { event_source: eventSource } : {}),
      page,
      page_size: EVENTS_PAGE_SIZE,
    }),
    [debouncedTenantId, debouncedActorId, eventType, eventSource, page],
  );

  const { data, isLoading, isFetching, isError, error, refetch } =
    useEvents(filters);

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
            // 控件展示用**立即**值（输入即回显）；查询用防抖值，两者只在输入中途短暂不同
            filters={{
              tenant_id: tenantId || undefined,
              actor_id: actorId || undefined,
              event_type: eventType || undefined,
              event_source: eventSource || undefined,
            }}
            onChange={(next) => {
              // 一次写全 4 个键：清空筛选时要把 URL 里的筛选参数一起清掉
              setTenantId(next.tenant_id ?? null);
              setActorId(next.actor_id ?? null);
              setEventType(next.event_type ?? null);
              setEventSource(next.event_source ?? null);
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
          {isError ? (
            // B3：请求失败必须显式可读、可重试 —— 不能渲染成「暂无事件数据」
            <ErrorState
              title="事件读取失败"
              message={normalizeApiError(error).message}
              onRetry={() => void refetch()}
            />
          ) : (
            <>
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
            </>
          )}
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
