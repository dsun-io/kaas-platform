"use client";

/** 「运行历史」tab（从 page.tsx 拆出；字段/顺序/空态不变）。 */
import { Badge } from "@/components/ui/badge";
import { EmptyState, SectionCard, StatusBadge } from "@/components/shared";
import { RUN_STATUS_TONES, toneForStatus } from "@/lib/status-tones";
import { History } from "lucide-react";

import { RUN_STATUS_CN } from "../lib/status-labels";
import type { ResearchRun } from "../lib/types";

export function ResearchRunsSection({ runs }: { runs: ResearchRun[] }) {
  return (
    <SectionCard title="运行历史">
      {runs.length === 0 ? (
        <EmptyState icon={History} title="暂无运行记录" />
      ) : (
        <div className="space-y-1 text-sm">
          {runs.map((r) => (
            <div
              key={r.id}
              className="flex flex-wrap items-center gap-3 rounded border px-3 py-2"
            >
              <StatusBadge tone={toneForStatus(RUN_STATUS_TONES, r.status)}>
                {RUN_STATUS_CN[r.status] ?? r.status}
              </StatusBadge>
              <span className="text-muted-foreground">#{r.id}</span>
              <Badge variant="outline">
                {String((r.config ?? {}).action ?? "—")}
              </Badge>
              <span>找到 {r.products_found ?? "-"}</span>
              <span>保留 {r.products_kept ?? "-"}</span>
              <span className="ml-auto text-xs text-muted-foreground">
                {r.created_at?.slice(0, 19) ?? ""}
              </span>
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  );
}
