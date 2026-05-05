"use client";

import { useState } from "react";
import { useAuditLog, type AuditEntry } from "./hooks/use-audit-log";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
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
import { Search, X, ChevronDown, ChevronRight } from "lucide-react";

const ACTION_OPTIONS = [
  { value: "", label: "全部操作" },
  { value: "update", label: "更新" },
  { value: "tenant.reload", label: "租户重载" },
  { value: "capability.update", label: "能力更新" },
  { value: "quotation.create", label: "报价录入" },
  { value: "oss.upload", label: "OSS 上传" },
];

const RESOURCE_OPTIONS = [
  { value: "", label: "全部资源" },
  { value: "feature_flag", label: "灰度开关" },
  { value: "tenant", label: "租户" },
  { value: "capability", label: "能力配置" },
  { value: "quotation", label: "报价" },
  { value: "oss", label: "对象存储" },
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

  return (
    <>
      <TableRow
        className="cursor-pointer hover:bg-muted/50"
        onClick={() => setOpen(!open)}
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
          <span className="text-xs px-1.5 py-0.5 rounded bg-muted font-mono">
            {entry.action}
          </span>
        </TableCell>
        <TableCell className="text-xs">{entry.resource_type}</TableCell>
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
            <pre className="text-xs whitespace-pre-wrap p-2">
              {JSON.stringify(entry, null, 2)}
            </pre>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

export default function AuditLogPage() {
  usePageView({ resource_id: "/audit-log" });

  const [filters, setFilters] = useState({
    action: "",
    resource_type: "",
    since: "",
    until: "",
  });

  const updateFilter = (key: string, value: string) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
  };

  const resetFilters = () => {
    setFilters({ action: "", resource_type: "", since: "", until: "" });
  };

  const { data, isLoading } = useAuditLog(
    Object.fromEntries(Object.entries(filters).filter(([, v]) => v !== "")),
  );

  const items = data?.items ?? [];
  const total = data?.total ?? 0;

  return (
    <RouteGuard adminOnly>
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold">操作日志</h1>

        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2">
                <Search className="size-4" />
                日志筛选
              </CardTitle>
              {total > 0 && (
                <span className="text-xs text-muted-foreground">
                  {total} 条记录
                </span>
              )}
            </div>
          </CardHeader>
          <CardContent>
            <AuditFilters
              filters={filters}
              onChange={updateFilter}
              onReset={resetFilters}
            />
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="p-8 text-center text-sm text-muted-foreground">
                加载中...
              </div>
            ) : items.length === 0 ? (
              <div className="p-8 text-center text-sm text-muted-foreground">
                暂无操作记录
              </div>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-8" />
                      <TableHead className="text-xs">时间</TableHead>
                      <TableHead className="text-xs">操作者</TableHead>
                      <TableHead className="text-xs">操作</TableHead>
                      <TableHead className="text-xs">资源类型</TableHead>
                      <TableHead className="hidden sm:table-cell text-xs">
                        资源 ID
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
          </CardContent>
        </Card>
      </div>
    </RouteGuard>
  );
}
