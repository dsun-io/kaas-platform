"use client";

/**
 * 算价结果展示。
 *
 * 两个刻意的设计：
 *  1. **提示语必须显式展示**（引擎回在 meta.diagnostics 里）。典型如
 *     「退税率未核实，暂按进项税额全额可回收计算」—— 这直接影响整张报价的
 *     金额水平，引擎刻意不替业务猜，前端就不能把它吞掉。
 *  2. 客户视图与内部视图用**同一套表格渲染**，靠后端返回的列集合区分。
 *     客户视图的列里根本不含成本/利润/税额，所以「给客户看」是安全的。
 */
import { AlertTriangle, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { ExportQuoteResponse, QuoteTable } from "@contracts/export-quote";
import { triggerBlobDownload } from "@/lib/export-quote/import-file";

/**
 * 单元格文本：数值按列声明的位数显示（金额两位、丝径一位…）。
 *
 * `decimals` 为 null/undefined 时保留原行为（最多 6 位小数）——
 * 那类列（如评分、系数）本来就没有固定口径，硬套位数反而会误导。
 *
 * 屏幕与导出**共用这一个函数**：否则界面上是 301.00、下载下来是 301，
 * 用户会当成两个 bug 分别报一次。
 */
function formatCell(
  value: number | string | boolean | null,
  decimals?: number | null,
): string {
  if (value === null || value === undefined) return "";
  if (typeof value !== "number") return String(value);
  return value.toLocaleString("zh-CN", {
    minimumFractionDigits: decimals ?? 0,
    maximumFractionDigits: decimals ?? 6,
  });
}

/** 单元格：数值右对齐（金额/数量/评分不应与文本左对齐混排）。 */
function Cell({
  value,
  decimals,
}: {
  value: number | string | boolean | null;
  decimals?: number | null;
}) {
  if (value === null || value === undefined) {
    return <td className="px-2 py-1.5 text-right text-muted-foreground">—</td>;
  }
  if (typeof value === "number") {
    return (
      <td className="px-2 py-1.5 text-right tabular-nums">
        {formatCell(value, decimals)}
      </td>
    );
  }
  return <td className="px-2 py-1.5 whitespace-nowrap">{String(value)}</td>;
}

function QuoteTableView({ table }: { table: QuoteTable }) {
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full border-collapse text-xs">
        <thead className="bg-muted/50">
          <tr>
            {table.header.map((h, i) => (
              <th
                scope="col"
                key={`${h}-${i}`}
                className="whitespace-nowrap px-2 py-2 text-left font-medium text-muted-foreground"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, ri) => (
            <tr key={ri} className="border-t hover:bg-muted/30">
              {row.map((cell, ci) => (
                <Cell key={ci} value={cell} decimals={table.decimals?.[ci]} />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function toCsv(table: QuoteTable): string {
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  // 与屏幕一致的位数：见 formatCell 的说明。
  const line = (cells: (number | string | boolean | null)[]) =>
    cells
      .map((c, i) =>
        esc(typeof c === "number" ? formatCell(c, table.decimals?.[i]) : c),
      )
      .join(",");
  return [line(table.header), ...table.rows.map((r) => line(r))].join("\n");
}

interface Props {
  result: ExportQuoteResponse;
  view: "customer" | "internal";
}

export function EngineQuoteResult({ result, view }: Props) {
  const { meta, customer, internal } = result;
  const table = view === "internal" && internal ? internal : customer;
  const diagnostics = meta.diagnostics ?? [];

  return (
    <div className="space-y-4">
      {diagnostics.length > 0 && (
        <div className="flex gap-2 rounded-lg border border-warning/40 bg-warning-muted px-3 py-2.5 text-xs text-warning-muted-foreground">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <div className="space-y-1">
            {diagnostics.map((d, i) => (
              <p key={i}>{d}</p>
            ))}
          </div>
        </div>
      )}

      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-base">
              {meta.product_name} 报价
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                {view === "internal"
                  ? "内部视图（含成本与利润）"
                  : "客户视图（不含成本与利润）"}
              </span>
            </CardTitle>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 text-xs"
              onClick={() =>
                triggerBlobDownload(
                  new Blob(["\uFEFF" + toCsv(table)], {
                    type: "text/csv;charset=utf-8",
                  }),
                  `${meta.product_key}-${meta.quote_date ?? "quote"}-${view}.csv`,
                )
              }
            >
              <Download className="size-3.5" />
              导出
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-4">
            {[
              ["报价日期", meta.quote_date ?? "—"],
              ["有效期至", meta.valid_until ?? "—"],
              [
                "汇率",
                `${meta.fx_rate} ${meta.currency}→${meta.quote_currency}`,
              ],
              ["规格组合", `${meta.combo_count} 种`],
              ["税务档案", meta.rate_set_code || "未指定"],
              ["贸易术语", (meta.term_codes ?? []).join(" / ") || "—"],
            ].map(([k, v]) => (
              <div key={k}>
                <dt className="text-muted-foreground">{k}</dt>
                <dd className="tabular-nums">{v}</dd>
              </div>
            ))}
          </dl>

          <QuoteTableView table={table} />

          {(meta.orders?.length ?? 0) > 0 && (
            <p className="text-[11px] text-muted-foreground">
              订单量：
              {meta.orders
                .map((o) => `${o.label || o.name} ${o.total}${o.unit}`)
                .join(" · ")}
            </p>
          )}
        </CardContent>
      </Card>

      {view === "customer" && (
        <p className={cn("text-[11px] text-muted-foreground")}>
          客户视图不含成本、利润与税额，可直接对外提供。
        </p>
      )}
    </div>
  );
}
