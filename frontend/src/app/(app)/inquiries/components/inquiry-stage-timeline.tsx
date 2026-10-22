"use client";

/**
 * 阶段时间线（`GET /inquiries/{id}` 的 stage_log[]）。
 *
 * 这是「谁、在什么时候、因为哪个事件把询盘从哪推到哪」的唯一可查记录
 * （真源 inquiry_stage.py 每次真实变更写一条；历史行可能一条都没有）。
 * 只读，不提供"手动改阶段"—— 阶段由业务事件推进，人工动作只有「关闭」。
 */
import { formatInquiryDateTime } from "@/lib/inquiries/format";
import { stageTimeline, type StageTimelineEntry } from "@/lib/inquiries/stage";
import type { InquiryStageLog } from "@/lib/inquiries/types";

function Entry({ entry }: { entry: StageTimelineEntry }) {
  return (
    <li className="relative pl-5">
      <span
        aria-hidden
        className="absolute left-0 top-1.5 size-2 rounded-full bg-primary/60"
      />
      <p className="text-sm">
        {entry.fromLabel ? `${entry.fromLabel} → ` : "进入 "}
        <span className="font-medium">{entry.toLabel}</span>
        <span className="ml-2 text-xs text-muted-foreground">
          {entry.sourceLabel}
        </span>
      </p>
      <p className="mt-0.5 text-xs text-muted-foreground">
        {formatInquiryDateTime(entry.createdAt)}
        {entry.actorId ? ` · 操作人 #${entry.actorId}` : ""}
        {entry.note ? ` · ${entry.note}` : ""}
      </p>
    </li>
  );
}

export function InquiryStageTimeline({ logs }: { logs: InquiryStageLog[] }) {
  const entries = stageTimeline(logs);
  if (entries.length === 0) {
    return (
      <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
        暂无阶段流水（历史询盘没有记录）。之后创建报价、转订单、手动关闭都会自动记一条。
      </p>
    );
  }
  return (
    <ol className="space-y-3 border-l border-border/70 pl-1">
      {entries.map((entry) => (
        <Entry key={entry.id} entry={entry} />
      ))}
    </ol>
  );
}
