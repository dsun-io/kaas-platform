"use client";

/**
 * 金额摘要条（A5-W3）—— **只读**
 *
 * 用户原话（A5-W3 计划）：编辑面板顶部加「整单金额摘要条」——行合计 / 合计大写 /
 * 与上游订单差额；改 qty/price（或汇率/运费）即时重算，超容差红标。
 *
 * 三条纪律
 * --------
 * 1. **只读**：金额的真源是单据 payload（后端单一来源推导，A7 闸门兜底）。这里任何一个
 *    输入框都会让"界面上改的金额"与"落库的金额"分叉 —— 所以整条只有文本。
 * 2. **同口径**：换算/舍入/应付总额全部来自 `render.ts::computeFxBreakdown`
 *    （见 `lib/trade-doc/amount-summary.ts` 的 import），不重写公式。
 * 3. **跨币种不硬比**：上游订单币种既不是 USD 也不是单据币种、又没有对应汇率时，
 *    只显示上游金额、不显示差额（硬比出来的差值没有意义）。
 */
import { Lock, Receipt } from "lucide-react";

import {
  summarizeAmounts,
  type AmountDiff,
  type UpstreamSnapshot,
} from "@/lib/trade-doc/amount-summary";
import { cn } from "@/lib/utils";

function money(amount: number | null, currency: string): string {
  if (amount === null || !Number.isFinite(amount)) return "—";
  return `${currency} ${amount.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function signed(amount: number): string {
  const prefix = amount > 0 ? "+" : amount < 0 ? "-" : "";
  return `${prefix}${Math.abs(amount).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function DiffBadge({ diff }: { diff: AmountDiff }) {
  const same = Math.abs(diff.amount) < 0.005;
  if (!diff.overTolerance) {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-success-muted px-2 py-0.5 text-xs text-success-muted-foreground">
        {same
          ? "与订单一致"
          : `与订单差 ${signed(diff.amount)} ${diff.currency}`}
        <span className="text-[10px] opacity-70">
          （容差 ±{diff.tolerance}）
        </span>
      </span>
    );
  }
  return (
    <span
      role="alert"
      className="inline-flex items-center gap-1 rounded-md bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive"
    >
      与订单差 {signed(diff.amount)} {diff.currency}
      <span className="text-[10px] font-normal">
        （超容差 ±{diff.tolerance}，签发前请核对）
      </span>
    </span>
  );
}

export function AmountSummaryBar({
  docType,
  data,
  sources,
  className,
}: {
  docType: string;
  /** 装配后的渲染数据 + 正在编辑的 custom（见 `effectivePayload`） */
  data: Record<string, unknown> | null | undefined;
  /** `raw_payload.sources`：有 order/quote 时显示「与上游订单差额」 */
  sources?: UpstreamSnapshot | null;
  className?: string;
}) {
  const summary = summarizeAmounts({ docType, data, sources });

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-4 gap-y-1 border-b bg-muted/20 px-3 py-2 text-xs",
        className,
      )}
      aria-label="金额摘要（只读）"
    >
      <span className="flex items-center gap-1 font-medium">
        <Receipt className="h-3.5 w-3.5" />
        金额摘要
        <span className="flex items-center gap-0.5 rounded bg-muted px-1 text-[10px] font-normal text-muted-foreground">
          <Lock className="h-2.5 w-2.5" />
          只读
        </span>
      </span>

      {summary.hasFx ? (
        <>
          <span>
            <span className="text-muted-foreground">行合计 </span>
            {money(summary.lineCny, "CNY")}
            <span className="text-muted-foreground"> · </span>
            {money(summary.lineUsd, "USD")}
            <span className="text-muted-foreground">
              （{summary.lineCount} 行）
            </span>
          </span>
          <span>
            <span className="text-muted-foreground">应付 </span>
            <b>{money(summary.payableUsd, "USD")}</b>
            {summary.payableCny !== null && (
              <span className="text-muted-foreground">
                {" "}
                / {money(summary.payableCny, "CNY")}
              </span>
            )}
          </span>
        </>
      ) : (
        <span>
          <span className="text-muted-foreground">行合计 </span>
          {money(
            summary.single?.amount ?? null,
            summary.single?.currency ?? "—",
          )}
          <span className="text-muted-foreground">
            （{summary.lineCount} 行 · 无汇率，仅单币种摘要）
          </span>
        </span>
      )}

      {summary.upstream && (
        <span>
          <span className="text-muted-foreground">
            上游{summary.upstream.label === "order" ? "订单" : "报价"}{" "}
          </span>
          {money(summary.upstream.total, summary.upstream.currency)}
        </span>
      )}
      {summary.diff && <DiffBadge diff={summary.diff} />}

      {summary.words.text && (
        <span
          className="w-full text-[11px] text-muted-foreground"
          title="金额大写（USD 应付总额口径；报关与信用证审单使用）"
        >
          {summary.words.text}
        </span>
      )}
    </div>
  );
}
