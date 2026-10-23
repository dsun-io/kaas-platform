"use client";

/** 运行历史（从 page.tsx 拆出；tone/文案走单一来源，DOM 不变）。 */
import { Badge } from "@/components/ui/badge";
import { EmptyState, SectionCard, StatusBadge } from "@/components/shared";
import { RUN_STATUS_TONES, toneForStatus } from "@/lib/status-tones";

import { RUN_STATUS_CN } from "../lib/status-labels";
import type { LeadgenRun } from "../lib/types";

export function LeadgenRunHistory({ runs }: { runs: LeadgenRun[] }) {
  return (
    <SectionCard title="运行历史">
      {runs.length === 0 ? (
        <EmptyState title="暂无运行记录" />
      ) : (
        <div className="space-y-1 text-sm">
          {runs.slice(0, 10).map((r) => (
            <div
              key={r.id}
              className="flex items-center gap-3 rounded border px-3 py-2"
            >
              <StatusBadge tone={toneForStatus(RUN_STATUS_TONES, r.status)}>
                {RUN_STATUS_CN[r.status] ?? r.status}
              </StatusBadge>
              <span className="text-muted-foreground">#{r.id}</span>
              <span>找到 {r.leads_found ?? "-"}</span>
              <span>保留 {r.leads_kept ?? "-"}</span>
              {r.deduplicated && <Badge variant="outline">已去重</Badge>}
              <span className="ml-auto text-xs text-muted-foreground">
                {r.started_at?.slice(0, 19) ?? ""}
              </span>
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  );
}
