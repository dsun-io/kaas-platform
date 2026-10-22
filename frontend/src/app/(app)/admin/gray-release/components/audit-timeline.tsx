"use client";

import { Badge } from "@/components/ui/badge";
import { LoadingBlock } from "@/components/shared/loading-block";
import { flagLabel } from "../flag-labels";

interface AuditEntry {
  id: string;
  action: string;
  actor_id: string;
  flag_key: string;
  enabled_before: boolean;
  enabled_after: boolean;
  reason: string;
  timestamp: string;
}

interface Props {
  entries: AuditEntry[];
  loading?: boolean;
  /**
   * 接口不可用（如生产按设计 404）。必须和"暂无记录"分开渲染：
   * 空时间线会被读成"近 7 天没有变更"，而事实是"根本没读到"。
   */
  unavailable?: boolean;
}

export function AuditTimeline({ entries, loading, unavailable }: Props) {
  if (loading) {
    return <LoadingBlock rows={3} className="py-4" />;
  }

  if (unavailable) {
    return (
      <div className="rounded-lg border border-dashed p-4 text-sm">
        <p className="font-medium">发布审计暂不可用</p>
        <p className="mt-1 text-muted-foreground">
          当前环境还没有这项记录，所以不显示空时间线冒充「暂无记录」。
          灰度开关的实际变更仍可在「审计日志」页查看；如需在本页恢复历史，
          请联系平台管理员开通发布审计记录。
        </p>
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <p className="py-4 text-sm text-muted-foreground">
        近 7 天没有变更记录。
      </p>
    );
  }

  return (
    <div className="relative border-l pl-6 space-y-4">
      {entries.map((entry) => (
        <div key={entry.id} className="relative">
          <div className="absolute -left-[calc(1.5rem+2px)] top-1 h-2 w-2 rounded-full bg-border" />
          <div className="flex items-center gap-2">
            <Badge
              variant="outline"
              className="text-xs"
              title={entry.flag_key}
            >
              {flagLabel(entry.flag_key)}
            </Badge>
            <span className="text-xs">
              {entry.enabled_before ? "已开启" : "已关闭"} →{" "}
              {entry.enabled_after ? "已开启" : "已关闭"}
            </span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{entry.reason}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {entry.actor_id} ·{" "}
            {new Date(entry.timestamp).toLocaleString("zh-CN")}
          </p>
        </div>
      ))}
    </div>
  );
}
