"use client";

/**
 * 四阶段商机漏斗（M3 设计 §7）。
 *
 * 只展示内核算好的数字：阶段计数 / 成交金额 / 阶段间转化率 / 综合商机分。
 * 条形宽度是**纯视觉**（相对首阶段询盘数），这里用 `stageBarWidthPercent`
 * 让「漏斗收窄」一眼可见，不参与任何业务判定。
 */
import {
  formatAmount,
  formatPercent,
  stageBarWidthPercent,
} from "@/lib/dashboard/funnel";
import type { DashboardFunnelResponse } from "@/lib/schemas/responses";

type ConversionRates = DashboardFunnelResponse["funnel"]["conversion_rates"];

const CONVERSION_ITEMS: ReadonlyArray<{
  key: keyof ConversionRates;
  label: string;
}> = [
  { key: "inquiry_to_quote", label: "询盘 → 报价" },
  { key: "quote_to_order", label: "报价 → 下单" },
  { key: "order_to_completed", label: "下单 → 成笔" },
  { key: "inquiry_to_completed", label: "询盘 → 成笔" },
];

export function FunnelStages({
  funnel,
}: {
  funnel: DashboardFunnelResponse["funnel"];
}) {
  const baseCount = funnel.stages[0]?.count ?? 0;

  return (
    <div className="space-y-4">
      <ol className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {funnel.stages.map((stage, index) => {
          const width = stageBarWidthPercent(stage.count, baseCount);
          return (
            <li
              key={stage.name}
              data-testid="funnel-stage"
              className="rounded-lg border bg-muted/30 p-4"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium">{stage.label}</span>
                <span className="text-[11px] text-muted-foreground">
                  第 {index + 1} 阶段
                </span>
              </div>
              <p
                className="mt-2 text-2xl font-semibold tabular-nums"
                data-testid={`funnel-stage-count-${stage.name}`}
              >
                {stage.count}
              </p>
              {typeof stage.amount === "number" ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  成交金额 {formatAmount(stage.amount)}
                </p>
              ) : null}
              <div
                className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted"
                aria-hidden="true"
              >
                <div
                  className="h-full rounded-full bg-primary"
                  style={{ width: `${width}%` }}
                />
              </div>
            </li>
          );
        })}
      </ol>

      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {CONVERSION_ITEMS.map((item) => (
          <div
            key={item.key}
            className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-xs"
          >
            <span className="text-muted-foreground">{item.label}</span>
            <span
              className="font-medium tabular-nums"
              data-testid={`conversion-${item.key}`}
            >
              {formatPercent(funnel.conversion_rates[item.key])}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** 综合商机分徽标（权重口径固定在后端：询盘×1 + 报价×2 + 订单×10）。 */
export function CompositeScore({ score }: { score: number }) {
  return (
    <div className="rounded-lg border px-3 py-2 text-xs">
      <div className="flex items-baseline gap-2">
        <span className="text-muted-foreground">综合商机分</span>
        <span
          className="text-base font-semibold tabular-nums"
          data-testid="composite-score"
        >
          {score}
        </span>
      </div>
      <p className="mt-0.5 text-[11px] text-muted-foreground">
        询盘×1 + 报价×2 + 订单×10
      </p>
    </div>
  );
}
