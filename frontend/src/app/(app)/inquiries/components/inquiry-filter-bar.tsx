"use client";

/**
 * 询盘筛选栏（阶段 / 状态 / 渠道 / 客户 / 时间范围 / 关键字）。
 *
 * 取舍：
 *  · 用**显式「查询」按钮**而不是输入即查：时间范围两格 + 关键字，边输边查会打出
 *    一串必然 422 的中间态（如 2026-1），也浪费请求（与 intel/shipments-table 同范式）；
 *  · 客户筛选复用 `useCustomerOptions()`（/customers?page_size=200），不手输 id；
 *  · 参数名与内核 Query 名逐字一致（date_from/date_to/customer_id），映射在
 *    `lib/inquiries/filters.ts` 的纯函数里，组件只维护表单态。
 */
import { useState } from "react";
import { RotateCcw, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  EMPTY_INQUIRY_FILTERS,
  toInquiryQueryParams,
  validateInquiryFilters,
  type InquiryFilters,
} from "@/lib/inquiries/filters";
import { CHANNEL_LABEL } from "@/lib/inquiries/format";
import { INQUIRY_STATUS_LABEL, STAGE_LABEL } from "@/lib/inquiries/stage";
import { INQUIRY_STAGES, INQUIRY_STATUSES } from "@/lib/inquiries/types";
import {
  customerOptionName,
  useCustomerOptions,
} from "@/lib/workstation/use-upstream";

const SELECT_CLASS =
  "h-9 min-w-[8.5rem] rounded-md border border-input bg-background px-2 text-sm";

export function InquiryFilterBar({
  value,
  onApply,
  disabled = false,
  resultCount,
}: {
  value: InquiryFilters;
  onApply: (next: InquiryFilters) => void;
  disabled?: boolean;
  resultCount?: number;
}) {
  // 表单态与「已生效筛选」分离：点查询才生效，避免边输边查
  const [draft, setDraft] = useState<InquiryFilters>(value);
  const [error, setError] = useState<string | null>(null);
  const customers = useCustomerOptions();

  const patchDraft = (patch: Partial<InquiryFilters>) => {
    setDraft((prev) => ({ ...prev, ...patch }));
    setError(null);
  };

  const handleSearch = () => {
    const message = validateInquiryFilters(draft);
    if (message) {
      setError(message);
      return;
    }
    setError(null);
    onApply(draft);
  };

  const handleReset = () => {
    setDraft(EMPTY_INQUIRY_FILTERS);
    setError(null);
    onApply(EMPTY_INQUIRY_FILTERS);
  };

  const activeCount = Object.keys(toInquiryQueryParams(value)).length;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          阶段
          <select
            aria-label="阶段筛选"
            className={SELECT_CLASS}
            value={draft.stage ?? ""}
            onChange={(e) =>
              patchDraft({ stage: e.target.value as InquiryFilters["stage"] })
            }
          >
            <option value="">全部阶段</option>
            {INQUIRY_STAGES.map((stage) => (
              <option key={stage} value={stage}>
                {STAGE_LABEL[stage]}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          状态
          <select
            aria-label="状态筛选"
            className={SELECT_CLASS}
            value={draft.status ?? ""}
            onChange={(e) => patchDraft({ status: e.target.value })}
          >
            <option value="">全部状态</option>
            {INQUIRY_STATUSES.map((status) => (
              <option key={status} value={status}>
                {INQUIRY_STATUS_LABEL[status]}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          渠道
          <select
            aria-label="渠道筛选"
            className={SELECT_CLASS}
            value={draft.channel ?? ""}
            onChange={(e) => patchDraft({ channel: e.target.value })}
          >
            <option value="">全部渠道</option>
            {Object.entries(CHANNEL_LABEL).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          客户
          <select
            aria-label="客户筛选"
            className={SELECT_CLASS}
            value={draft.customerId ?? ""}
            onChange={(e) => patchDraft({ customerId: e.target.value })}
          >
            <option value="">全部客户</option>
            {(customers.data ?? []).map((customer) => (
              <option key={customer.id} value={String(customer.id)}>
                {customerOptionName(customer)}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          开始日期
          <Input
            type="date"
            aria-label="开始日期"
            className="h-9 w-[9.5rem]"
            value={draft.dateFrom ?? ""}
            onChange={(e) => patchDraft({ dateFrom: e.target.value })}
          />
        </label>

        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          结束日期
          <Input
            type="date"
            aria-label="结束日期"
            className="h-9 w-[9.5rem]"
            value={draft.dateTo ?? ""}
            onChange={(e) => patchDraft({ dateTo: e.target.value })}
          />
        </label>

        <label className="flex min-w-[14rem] flex-1 flex-col gap-1 text-xs text-muted-foreground">
          关键字
          <Input
            aria-label="关键字"
            placeholder="询盘号 / 产品 / 客户"
            className="h-9"
            value={draft.q ?? ""}
            onChange={(e) => patchDraft({ q: e.target.value })}
          />
        </label>

        <div className="flex items-center gap-2">
          <Button size="sm" onClick={handleSearch} disabled={disabled}>
            <Search className="mr-1 size-4" />
            查询
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={handleReset}
            disabled={disabled}
          >
            <RotateCcw className="mr-1 size-4" />
            重置
          </Button>
        </div>
      </div>

      <p
        className="text-xs text-muted-foreground"
        role={error ? "alert" : undefined}
      >
        {error ? (
          <span className="text-destructive">{error}</span>
        ) : activeCount > 0 ? (
          `已应用 ${activeCount} 个筛选条件`
        ) : (
          "未筛选：显示全部可见询盘"
        )}
        {typeof resultCount === "number" && !error ? (
          <span className="ml-2">共 {resultCount} 条</span>
        ) : null}
      </p>
    </div>
  );
}
