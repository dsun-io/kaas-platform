"use client";

/**
 * 汇率历史卡片（C36 下期 #5）——挂在税务管理页，紧邻「手工汇率」卡片。
 *
 * 能力：按 base/quote 过滤、时间倒序、limit 可选 30/90/365（后端 clamp 到 1..365）；
 * `source` / `is_stale` 如实展示（历史里也可能有旧缓存行，不能都当"正常"）。
 *
 * 入口位置理由：汇率是税务/报价的输入参数，和税档同页维护；手工录入卡负责"写"，
 * 这里负责"看历史/核对"，两个动作在同一屏完成。
 */
import { useState } from "react";

import { Input } from "@/components/ui/input";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge } from "@/components/shared/status-badge";
import { normalizeApiError } from "@/lib/api/api-error";
import { FX_HISTORY_MAX, useFxHistory } from "@/lib/fx/use-fx-history";

const LIMIT_OPTIONS = [30, 90, 365] as const;

export function FxHistoryCard() {
  const [base, setBase] = useState("USD");
  const [quote, setQuote] = useState("CNY");
  const [limit, setLimit] = useState<number>(30);
  const history = useFxHistory({ base, quote, limit });
  const rows = history.data ?? [];

  return (
    <SectionCard
      title="汇率历史"
      description={`按币种对查历史汇率（时间倒序，最多返回 ${FX_HISTORY_MAX} 条；后端 limit 上限即 ${FX_HISTORY_MAX}）。`}
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

      {history.isLoading ? (
        <p className="py-4 text-sm text-muted-foreground">正在读取汇率历史…</p>
      ) : history.isError ? (
        <p role="alert" className="py-4 text-sm text-destructive">
          汇率历史读取失败：{normalizeApiError(history.error).message}
        </p>
      ) : rows.length === 0 ? (
        <p className="py-4 text-sm text-muted-foreground">
          该币种对还没有历史记录（{base}/{quote}
          ）。外部源首次刷新或手工录入后会出现在这里。
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th scope="col" className="p-2">
                  日期
                </th>
                <th scope="col" className="p-2">
                  币种对
                </th>
                <th scope="col" className="p-2">
                  汇率
                </th>
                <th scope="col" className="p-2">
                  来源
                </th>
                <th scope="col" className="p-2">
                  状态
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={`${row.base_currency}-${row.quote_currency}-${row.rate_date}`}
                  className="border-b last:border-0"
                >
                  <td className="p-2 font-mono text-xs">{row.rate_date}</td>
                  <td className="p-2">
                    {row.base_currency}/{row.quote_currency}
                  </td>
                  <td className="p-2 font-mono">{row.rate}</td>
                  <td className="p-2 text-xs text-muted-foreground">
                    {row.source ?? "unknown"}
                  </td>
                  <td className="p-2">
                    {row.is_stale ? (
                      <StatusBadge tone="warning">
                        缓存（外部源不可用）
                      </StatusBadge>
                    ) : (
                      <StatusBadge tone="success">正常</StatusBadge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-xs text-muted-foreground">
            共 {rows.length} 条（本次查询上限 {limit} 条 / 后端上限{" "}
            {FX_HISTORY_MAX} 条）。
          </p>
        </div>
      )}
    </SectionCard>
  );
}
