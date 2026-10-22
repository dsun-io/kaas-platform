"use client";

/**
 * 新旧明细对比表（审批详情用）。
 *
 * 不做"两张表并排"：审批人要看的是**差异**，并排两表会让人自己找不同。
 * 逐行 compare，变化字段显示「旧 → 新」，新增/删除行单独标色（同时有文案，
 * 不只靠颜色——docs/UI_STANDARDS.md §2）。
 */
import { StatusBadge } from "@/components/shared/status-badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  diffChangeLines,
  summarizeChangeDiffs,
  type ChangeLineDiff,
  type LineChangeKind,
} from "@/lib/approvals/diff";
import {
  formatMoney,
  formatQuantity,
  lineProductName,
  lineSpecText,
} from "@/lib/approvals/format";
import type { ChangeLine } from "@/lib/approvals/types";
import type { StatusTone } from "@/components/shared";

const KIND_META: Record<LineChangeKind, { label: string; tone: StatusTone }> = {
  changed: { label: "修改", tone: "warning" },
  added: { label: "新增", tone: "success" },
  removed: { label: "删除", tone: "danger" },
  same: { label: "未变", tone: "default" },
};

function renderValue(
  line: ChangeLine | null,
  pick: (line: ChangeLine) => string,
): string {
  return line ? pick(line) : "—";
}

/** 单字段单元格：未变单值；新增/删除/修改分别呈现（修改 = 旧 → 新）。 */
function FieldCell({
  diff,
  pick,
}: {
  diff: ChangeLineDiff;
  pick: (line: ChangeLine) => string;
}) {
  if (diff.kind === "same") {
    return <span>{renderValue(diff.after, pick)}</span>;
  }
  if (diff.kind === "added") {
    return <span className="font-medium">{renderValue(diff.after, pick)}</span>;
  }
  if (diff.kind === "removed") {
    return (
      <span className="text-muted-foreground line-through">
        {renderValue(diff.before, pick)}
      </span>
    );
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <span className="text-muted-foreground line-through">
        {renderValue(diff.before, pick)}
      </span>
      <span aria-hidden className="text-muted-foreground">
        →
      </span>
      <span className="font-medium">{renderValue(diff.after, pick)}</span>
    </span>
  );
}

export function ChangeDiffTable({
  before,
  after,
}: {
  before: readonly ChangeLine[] | null | undefined;
  after: readonly ChangeLine[] | null | undefined;
}) {
  const diffs = diffChangeLines(before, after);
  const summary = summarizeChangeDiffs(diffs);

  if (diffs.length === 0) {
    return (
      <p className="rounded-lg border px-3 py-2 text-sm text-muted-foreground">
        这份申请没有货物明细（新旧都为空）。
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        共 {diffs.length} 行：修改 {summary.changed} · 新增 {summary.added} ·
        删除 {summary.removed} · 未变 {summary.same}
      </p>
      <Table aria-label="新旧货物明细对比">
        <TableHeader>
          <TableRow>
            <TableHead>变更</TableHead>
            <TableHead>货物</TableHead>
            <TableHead>数量</TableHead>
            <TableHead>单价</TableHead>
            <TableHead>行金额</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {diffs.map((diff) => {
            const meta = KIND_META[diff.kind];
            const spec = lineSpecText(diff.after ?? diff.before);
            return (
              <TableRow key={diff.key} data-kind={diff.kind}>
                <TableCell>
                  <StatusBadge tone={meta.tone} dot={false}>
                    {meta.label}
                  </StatusBadge>
                </TableCell>
                <TableCell className="max-w-[18rem] whitespace-normal">
                  <div className="font-medium">
                    {lineProductName(diff.after ?? diff.before)}
                  </div>
                  {diff.changedFields.length > 0 ? (
                    <div className="mt-0.5 text-xs text-warning-muted-foreground">
                      改动字段：{diff.changedFields.join(" / ")}
                    </div>
                  ) : null}
                  {spec ? (
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {spec}
                    </div>
                  ) : null}
                </TableCell>
                <TableCell>
                  <FieldCell
                    diff={diff}
                    pick={(line) => formatQuantity(line.qty, line.qty_unit)}
                  />
                </TableCell>
                <TableCell>
                  <FieldCell
                    diff={diff}
                    pick={(line) => formatMoney(line.unit_price, line.currency)}
                  />
                </TableCell>
                <TableCell>
                  <FieldCell
                    diff={diff}
                    pick={(line) =>
                      formatMoney(line.line_amount, line.currency)
                    }
                  />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
