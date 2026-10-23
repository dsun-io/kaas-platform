"use client";

/**
 * 汇率历史卡片（C36 下期 #5）——挂在税务档案页，紧邻「手工汇率」卡片。
 *
 * 能力：按 base/quote 过滤、时间倒序、limit 可选 30/90/365（后端 clamp 到 1..365）；
 * `source` / `is_stale` 如实展示（历史里也可能有旧缓存行，不能都当"正常"）。
 *
 * 入口位置理由：汇率是税务/报价的输入参数，和税档同页维护；手工录入卡负责"写"，
 * 这里负责"看历史/核对"，两个动作在同一屏完成。
 */
import { useState } from "react";

import {
  DataTable,
  type DataTableColumn,
} from "@/components/shared/data-table";
import { EmptyState } from "@/components/shared/empty-state";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge } from "@/components/shared/status-badge";
import { Input } from "@/components/ui/input";
import { normalizeApiError } from "@/lib/api/api-error";
import { FX_HISTORY_MAX, useFxHistory } from "@/lib/fx/use-fx-history";
import type { FxRateHistoryRow } from "@/lib/fx/use-latest-fx";

const LIMIT_OPTIONS = [30, 90, 365] as const;

/** 来源显示文案（接口枚举仍是 manual/external）。 */
const SOURCE_LABELS: Record<string, string> = {
  manual: "手工录入",
  external: "外部汇率源",
};

const COLUMNS: readonly DataTableColumn<FxRateHistoryRow>[] = [
  {
    key: "rate_date",
    header: "日期",
    className: "font-mono text-xs",
    render: (row) => row.rate_date,
  },
  {
    key: "pair",
    header: "币种对",
    render: (row) => `${row.base_currency}/${row.quote_currency}`,
  },
  {
    key: "rate",
    header: "汇率",
    className: "font-mono",
    render: (row) => row.rate,
  },
  {
    key: "source",
    header: "来源",
    className: "text-xs text-muted-foreground",
    render: (row) => SOURCE_LABELS[row.source ?? ""] ?? "未知来源",
  },
  {
    key: "status",
    header: "状态",
    render: (row) =>
      row.is_stale ? (
        <StatusBadge tone="warning">备用数据（外部汇率源暂不可用）</StatusBadge>
      ) : (
        <StatusBadge tone="success">正常</StatusBadge>
      ),
  },
];

export function FxHistoryCard() {
  const [base, setBase] = useState("USD");
  const [quote, setQuote] = useState("CNY");
  const [limit, setLimit] = useState<number>(30);
  const history = useFxHistory({ base, quote, limit });
  const rows = history.data ?? [];

  return (
    <SectionCard
      title="汇率历史"
      description={`按币种对查历史汇率（时间倒序，最多显示 ${FX_HISTORY_MAX} 条）。`}
    >
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <label className="space-y-1">
          <span className="text-sm font-medium">基准币种</span>
          <Input
            className="w-24"
            value={base}
            onChange={(e) => setBase(e.target.value.toUpperCase())}
            placeholder="USD"
          />
        </label>
        <label className="space-y-1">
          <span className="text-sm font-medium">报价币种</span>
          <Input
            className="w-24"
            value={quote}
            onChange={(e) => setQuote(e.target.value.toUpperCase())}
            placeholder="CNY"
          />
        </label>
        <label className="space-y-1">
          <span className="text-sm font-medium">条数</span>
          <select
            aria-label="历史条数"
            className="h-9 rounded-lg border border-input bg-background px-2 text-sm"
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value))}
          >
            {LIMIT_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option} 条
              </option>
            ))}
          </select>
        </label>
      </div>

      <DataTable
        columns={COLUMNS}
        rows={rows}
        getRowKey={(row) =>
          `${row.base_currency}-${row.quote_currency}-${row.rate_date}`
        }
        loading={history.isLoading}
        error={
          history.isError ? normalizeApiError(history.error).message : null
        }
        onRetry={() => void history.refetch()}
        emptySlot={
          <EmptyState
            title="还没有历史记录"
            description={`该币种对（${base}/${quote}）首次刷新外部源或手工录入后会出现在这里。`}
            className="py-4"
          />
        }
        paginationSlot={
          <p className="mt-2 text-xs text-muted-foreground">
            共 {rows.length} 条（本次显示上限 {limit} 条 / 最多 {FX_HISTORY_MAX}{" "}
            条）。
          </p>
        }
      />
    </SectionCard>
  );
}
