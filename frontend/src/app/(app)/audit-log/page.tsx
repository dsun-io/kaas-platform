"use client";

import { useState } from "react";
import { useAuditLog, type AuditEntry } from "./hooks/use-audit-log";
import { PaginationBar } from "@/components/shared/pagination-bar";

/** 与后端 `get_audit_log` 的默认 page_size 一致（上限 100） */
const AUDIT_PAGE_SIZE = 20;
import { SectionCard } from "@/components/shared/section-card";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import { usePageView } from "@/lib/events/use-page-view";
import { RouteGuard } from "@/components/route-guard";
import { PageHeader } from "@/components/shared";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { usePersistentState } from "@/lib/hooks/use-persistent-state";
import { X, ChevronDown, ChevronRight } from "lucide-react";

/** 操作名、对象类型翻成中文（内部代码只在「查看详情」里出现，设计稿 §1/§7） */
const ACTION_LABELS: Record<string, string> = {
  update: "更新",
  "tenant.reload": "重载空间配置",
  "capability.update": "更新能力配置",
  "quotation.create": "录入报价",
  "oss.upload": "上传文件",
};

const RESOURCE_LABELS: Record<string, string> = {
  feature_flag: "灰度开关",
  tenant: "空间",
  capability: "能力配置",
  quotation: "报价单",
  oss: "文件存储",
};

function actionLabel(value: string): string {
  return ACTION_LABELS[value] ?? "其他操作";
}

function resourceLabel(value: string): string {
  return RESOURCE_LABELS[value] ?? "其他对象";
}

const ACTION_OPTIONS = [
  { value: "", label: "全部操作" },
  ...Object.entries(ACTION_LABELS).map(([value, label]) => ({ value, label })),
];

const RESOURCE_OPTIONS = [
  { value: "", label: "全部对象" },
  ...Object.entries(RESOURCE_LABELS).map(([value, label]) => ({
    value,
    label,
  })),
];

function formatTime(iso: string) {
  const d = new Date(iso);
  return d.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function AuditFilters({
  filters,
  onChange,
  onReset,
}: {
  filters: {
    action: string;
    resource_type: string;
    since: string;
    until: string;
  };
  onChange: (k: string, v: string) => void;
  onReset: () => void;
}) {
  const hasFilters =
    filters.action || filters.resource_type || filters.since || filters.until;

  return (
    <div className="flex flex-wrap items-center gap-3">
      <select
        value={filters.action}
        onChange={(e) => onChange("action", e.target.value)}
        className="w-full sm:w-auto rounded-md border px-3 py-1.5 text-sm bg-background"
      >
        {ACTION_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>

      <select
        value={filters.resource_type}
        onChange={(e) => onChange("resource_type", e.target.value)}
        className="w-full sm:w-auto rounded-md border px-3 py-1.5 text-sm bg-background"
      >
        {RESOURCE_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>

      <input
        type="date"
        value={filters.since}
        onChange={(e) => onChange("since", e.target.value)}
        className="w-full sm:w-auto rounded-md border px-3 py-1.5 text-sm bg-background"
        placeholder="起始日期"
      />

      <input
        type="date"
        value={filters.until}
        onChange={(e) => onChange("until", e.target.value)}
        className="w-full sm:w-auto rounded-md border px-3 py-1.5 text-sm bg-background"
        placeholder="结束日期"
      />

      {hasFilters && (
        <Button variant="ghost" size="default" onClick={onReset}>
          <X className="size-3 mr-1" />
          清除
        </Button>
      )}
    </div>
  );
}

function ExpandRow({ entry }: { entry: AuditEntry }) {
  const [open, setOpen] = useState(false);
  // 原始数据默认折叠：运营多半只看摘要（设计稿 §1/§7）
  const [showRaw, setShowRaw] = useState(false);

  return (
    <>
      {/* X6（审计 §1.5）：折叠行必须键盘可达 —— 原来只有 onClick，
          键盘用户无法展开任何一条日志的原始 JSON。 */}
      <TableRow
        className="cursor-pointer hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/30"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setOpen((value) => !value);
          }
        }}
      >
        <TableCell className="w-8">
          {open ? (
            <ChevronDown className="size-4" />
          ) : (
            <ChevronRight className="size-4" />
          )}
        </TableCell>
        <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
          {formatTime(entry.timestamp)}
        </TableCell>
        <TableCell className="font-mono text-xs">{entry.actor_id}</TableCell>
        <TableCell>
          <span className="text-xs px-1.5 py-0.5 rounded bg-muted">
            {actionLabel(entry.action)}
          </span>
        </TableCell>
        <TableCell className="text-xs">
          {resourceLabel(entry.resource_type)}
        </TableCell>
        <TableCell className="hidden sm:table-cell font-mono text-xs">
          {entry.resource_id}
        </TableCell>
        <TableCell className="text-xs text-muted-foreground max-w-64 truncate">
          {entry.reason}
        </TableCell>
      </TableRow>
      {open && (
        <TableRow className="bg-muted/30">
          <TableCell />
          <TableCell colSpan={6}>
            <div className="space-y-2 p-2 text-xs">
              <dl className="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
                <div className="flex gap-2">
                  <dt className="shrink-0 text-muted-foreground">操作</dt>
                  <dd>{actionLabel(entry.action)}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="shrink-0 text-muted-foreground">对象</dt>
                  <dd>
                    {resourceLabel(entry.resource_type)} · {entry.resource_id}
                  </dd>
                </div>
                <div className="flex gap-2">
                  <dt className="shrink-0 text-muted-foreground">操作人</dt>
                  <dd>{entry.actor_id}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="shrink-0 text-muted-foreground">时间</dt>
                  <dd>{new Date(entry.timestamp).toLocaleString("zh-CN")}</dd>
                </div>
              </dl>
              <button
                type="button"
                className="text-muted-foreground underline decoration-dotted underline-offset-2"
                aria-expanded={showRaw}
                onClick={() => setShowRaw((value) => !value)}
              >
                查看详情（一般不需要看）
              </button>
              {showRaw && (
                <pre className="whitespace-pre-wrap rounded bg-muted p-2 font-mono text-[11px]">
                  {JSON.stringify(entry, null, 2)}
                </pre>
              )}
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

export default function AuditLogPage() {
  usePageView({ resource_id: "/audit-log" });

  // C25：页码不入持久化筛选（刷新回第 1 页）；筛选变化时也重置
  const [page, setPage] = useState(1);
  const [filters, setFilters] = usePersistentState("ui:audit-log:filters", {
    action: "",
    resource_type: "",
    since: "",
    until: "",
  });

  const updateFilter = (key: string, value: string) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
    setPage(1);
  };

  const resetFilters = () => {
    setFilters({ action: "", resource_type: "", since: "", until: "" });
    setPage(1);
  };

  const { data, isLoading, isFetching } = useAuditLog({
    ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v !== "")),
    page,
    page_size: AUDIT_PAGE_SIZE,
  });

  const items = data?.items ?? [];
  const total = data?.total ?? 0;

  return (
    <RouteGuard adminOnly>
      <div className="space-y-6">
        <PageHeader title="操作日志" description="平台操作审计与追溯" />

        <SectionCard
          title="日志筛选"
          action={
            total > 0 ? (
              <span className="text-xs text-muted-foreground">
                {total} 条记录
              </span>
            ) : undefined
          }
        >
          <AuditFilters
            filters={filters}
            onChange={updateFilter}
            onReset={resetFilters}
          />
        </SectionCard>

        <SectionCard title="操作日志" bodyClassName="p-0">
          {isLoading ? (
            <div
              className="space-y-2 p-4"
              aria-busy="true"
              aria-label="操作日志加载中"
            >
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full rounded-md" />
              ))}
            </div>
          ) : items.length === 0 ? (
            <EmptyState
              title="暂无操作记录"
              description="调整筛选条件后再试。"
              className="border-0 py-8"
            />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8" />
                    <TableHead className="text-xs">时间</TableHead>
                    <TableHead className="text-xs">操作者</TableHead>
                    <TableHead className="text-xs">操作</TableHead>
                    <TableHead className="text-xs">对象类型</TableHead>
                    <TableHead className="hidden sm:table-cell text-xs">
                      关联对象
                    </TableHead>
                    <TableHead className="text-xs">说明</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((entry) => (
                    <ExpandRow key={entry.id} entry={entry} />
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          <PaginationBar
            page={page}
            pageSize={AUDIT_PAGE_SIZE}
            total={total}
            currentCount={items.length}
            loading={isFetching}
            onPageChange={setPage}
            ariaLabel="操作日志分页"
            className="px-4 pb-4"
          />
        </SectionCard>
      </div>
    </RouteGuard>
  );
}
