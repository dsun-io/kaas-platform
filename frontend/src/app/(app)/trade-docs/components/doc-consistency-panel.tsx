"use client";

/**
 * 跨单证一致性面板（A7-3）
 *
 * 后端只返回**差异**（一致项逐条返回会让一屏都是 ✓），三档语义见
 * `CONSISTENCY_META`（冲突红 / 等价措辞黄 / 缺失灰）—— 文案必须区分，
 * 因为"等价措辞"和"冲突"对业务是完全不同的处置（改措辞 vs 改数）。
 *
 * 「签发前预检」是**手工触发**：后端每次要跑四类检查（含跨单证 diff），
 * 挂载即跑会在每次打开面板时白算一遍。
 */
import { AlertTriangle, CheckCircle2, ListChecks, ShieldX } from "lucide-react";

import { LoadingBlock } from "@/components/shared/loading-block";
import { StatusBadge } from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
import {
  CONSISTENCY_META,
  type ConsistencyItem,
  type ConsistencyStatus,
} from "@/lib/trade-doc/hardening";
import { cn } from "@/lib/utils";

import { useDocConsistency, useDocLint } from "../hooks/use-doc-hardening";

/** 三档的固定展示顺序（红 → 黄 → 灰），空档不渲染。 */
const ORDER: ConsistencyStatus[] = ["conflict", "equivalent", "missing"];

function ConsistencyRow({ item }: { item: ConsistencyItem }) {
  const meta = CONSISTENCY_META[item.status] ?? CONSISTENCY_META.missing;
  return (
    <li
      className={cn(
        "px-3 py-2 text-sm",
        // 底色按三档 status：冲突红 / 等价黄 / 缺失灰（severity 只用于顶部 ok）
        item.status === "conflict"
          ? "bg-destructive/5"
          : item.status === "equivalent"
            ? "bg-warning-muted/60"
            : "bg-muted/20",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs text-muted-foreground">
          {item.key}
        </span>
        <StatusBadge tone={meta.tone}>{meta.label}</StatusBadge>
        <span className="text-xs text-muted-foreground">
          基线 {item.baseline_doc}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {Object.entries(item.values ?? {}).map(([docId, value]) => (
          <span key={docId}>
            <span className="text-muted-foreground">#{docId}：</span>
            {value}
          </span>
        ))}
      </div>
      {item.detail && (
        <p className="mt-1 text-xs text-muted-foreground">{item.detail}</p>
      )}
    </li>
  );
}

export function DocConsistencyPanel({ docId }: { docId: number }) {
  const consistency = useDocConsistency(docId);
  const lint = useDocLint(docId);

  if (consistency.isLoading) return <LoadingBlock rows={4} />;
  if (consistency.isError) {
    return (
      <p className="py-6 text-sm text-destructive">
        读取一致性结果失败（跨单证比对依赖同一交易域的上游单证）。
      </p>
    );
  }

  const data = consistency.data;
  const items = data?.items ?? [];
  // 三档计数按 `status` 而不是 `severity`：后端对"缺失"也可能标 error（承继核对只报
  // 不可改写事实的缺失），但产品口径是灰档、不按红色吓人（见 CONSISTENCY_META）。
  const conflicts = items.filter((item) => item.status === "conflict").length;
  const equivalents = items.filter(
    (item) => item.status === "equivalent",
  ).length;
  const missings = items.filter((item) => item.status === "missing").length;
  const grouped = ORDER.map((status) => ({
    status,
    items: items.filter((item) => item.status === status),
  })).filter((group) => group.items.length > 0);

  return (
    <div className="space-y-3">
      <div
        className={cn(
          "flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm",
          data?.ok
            ? "border-success/40 bg-success-muted text-success-muted-foreground"
            : "border-destructive/30 bg-destructive/5 text-destructive",
        )}
      >
        {data?.ok ? (
          <CheckCircle2 className="h-4 w-4" />
        ) : (
          <AlertTriangle className="h-4 w-4" />
        )}
        <span>
          {data?.ok
            ? "跨单证一致：没有冲突级差异"
            : `存在差异：冲突 ${conflicts} / 等价 ${equivalents} / 缺失 ${missings}（冲突会阻断导出与签发）`}
        </span>
        <span className="text-xs opacity-70">
          交易域：{data?.domain.root ?? "—"}（{data?.domain.doc_ids.length ?? 0}{" "}
          张单证）
        </span>
        <Button
          size="sm"
          variant="outline"
          className="ml-auto"
          disabled={lint.isPending}
          onClick={() => void lint.mutateAsync()}
        >
          <ListChecks className="mr-1 h-4 w-4" />
          签发前预检
        </Button>
      </div>

      {grouped.map((group) => {
        const meta = CONSISTENCY_META[group.status];
        return (
          <section key={group.status}>
            <h4 className="mb-1 flex items-center gap-2 text-sm font-medium">
              <StatusBadge tone={meta.tone}>{meta.label}</StatusBadge>
              <span className="text-xs text-muted-foreground">
                {group.items.length} 项 · {meta.hint}
              </span>
            </h4>
            <ul className="divide-y rounded-md border">
              {group.items.map((item) => (
                <ConsistencyRow
                  key={`${item.status}-${item.code}-${item.key}`}
                  item={item}
                />
              ))}
            </ul>
          </section>
        );
      })}

      {items.length === 0 && (
        <p className="rounded-md border px-3 py-6 text-center text-sm text-muted-foreground">
          没有需要核对的一致性差异。
        </p>
      )}

      {lint.data && (
        <div className="space-y-2 rounded-md border p-3">
          <div className="flex items-center gap-2 text-sm font-medium">
            <ShieldX className="h-4 w-4" />
            预检结论：
            {lint.data.ok ? (
              <StatusBadge tone="success">可以签发</StatusBadge>
            ) : (
              <StatusBadge tone="danger">
                {lint.data.summary.blocking} 项阻断
              </StatusBadge>
            )}
            {lint.data.summary.warnings > 0 && (
              <StatusBadge tone="warning">
                {lint.data.summary.warnings} 项提示
              </StatusBadge>
            )}
          </div>
          {lint.data.blocking.length > 0 && (
            <ul className="space-y-1">
              {lint.data.blocking.map((item, index) => (
                <li
                  key={`${item.code}-${index}`}
                  className="rounded-md bg-destructive/5 px-2 py-1 text-xs text-destructive"
                >
                  <span className="font-mono">{item.code}</span>
                  {item.keys?.length ? `：${item.keys.join(", ")}` : ""}
                  <span className="ml-1 text-muted-foreground">
                    {item.detail}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {lint.data.warnings.length > 0 && (
            <ul className="space-y-1">
              {lint.data.warnings.map((item, index) => (
                <li
                  key={`${item.code}-${index}`}
                  className="rounded-md bg-warning-muted px-2 py-1 text-xs text-warning-muted-foreground"
                >
                  <span className="font-mono">{item.code}</span>
                  <span className="ml-1 text-muted-foreground">
                    {item.detail}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
