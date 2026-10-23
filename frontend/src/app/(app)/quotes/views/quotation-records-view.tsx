"use client";

/**
 * 报价记录（历史台账）。
 *
 * X7（审计 §1.5）：这一页原来四层堆叠同屏 —— quote_orders 表 + 手工录入表单 +
 * 过滤条件 + 旧 quotations 台账表，用户分不清"哪个才是报价记录"。
 * 现在的主视图只有 **quote_orders（报价单记录）**；旧台账与手工补录收进
 * 「独立折叠区」，默认收起（有容器、有明确标题），数据来源一行没改：
 *   · 主视图：GET /quotes（quote_orders + 行项）
 *   · 旧台账：GET /quotations（旧报价事实表，仍可过滤/查看详情）
 *   · 手工补录：POST /quotations（仍写旧事实表）
 *
 * ⚠ 台账的写入门槛（平台升级方案 P4）：只在**业务节点**写入
 * （报价单签发 / 订单成交），试算不落账。手工补录与自动入账并存 —— 是否保留
 * 待业务确认，不在本次改动中移除，只是不再占据主视图首屏。
 */
import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/shared";
import { normalizeApiError } from "@/lib/api/api-error";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  useQuotations,
  type QuotationFilters,
  type Quotation,
} from "../hooks/use-quotations";
import { QuotationTable } from "../components/quotation-table";
import { QuotationFilters as FiltersBar } from "../components/quotation-filters";
import { QuotationDetailSheet } from "../components/quotation-detail";
import { NewQuotationForm } from "../components/new-quotation-form";
import { QuoteOrderRecords } from "../components/quote-order-records";

export function QuotationRecordsView() {
  const [filters, setFilters] = useState<QuotationFilters>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // 旧台账 / 手工补录：默认收起（主视图只留 quote_orders）
  const [legacyOpen, setLegacyOpen] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);

  const { data, isLoading, isError, error, refetch } = useQuotations(filters);

  const quotations: Quotation[] = data?.items ?? [];
  const selectedQuotation = selectedId
    ? (quotations.find((q) => q.id === selectedId) ?? null)
    : null;

  return (
    <div className="space-y-5">
      {/* 主视图：报价单记录（quote_orders 全信息视图：客户/时间/报价人/
          产品/规格/数量/价格，internal 另有成本/利润列） */}
      <QuoteOrderRecords />

      {/* 旧台账 + 手工补录：独立折叠容器（不再与主视图平铺争首屏） */}
      <section className="rounded-xl border border-border/70 bg-card">
        <div className="flex flex-col gap-2 border-b px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold">
              历史台账（旧 quotations 表）
            </h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              旧报价事实表与手工补录，默认收起；上方「报价单记录」才是当前主视图。
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setManualOpen(true)}
            >
              手工补录
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-expanded={legacyOpen}
              onClick={() => setLegacyOpen((value) => !value)}
            >
              {legacyOpen ? (
                <ChevronDown className="mr-1 size-4" />
              ) : (
                <ChevronRight className="mr-1 size-4" />
              )}
              {legacyOpen ? "收起旧台账" : "展开旧台账"}
            </Button>
          </div>
        </div>

        {legacyOpen && (
          <div className="space-y-4 px-4 py-4">
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">
                过滤条件
              </p>
              <FiltersBar filters={filters} onChange={setFilters} />
            </div>

            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">
                报价列表
                {data ? `（共 ${data.total} 条）` : null}
              </p>
              {/* 失败 ≠ 空台账（P0-B2 口径保留）：错误可读可重试 */}
              {isError ? (
                <ErrorState
                  title="历史台账读取失败"
                  message={normalizeApiError(error).message}
                  onRetry={() => void refetch()}
                  className="border-0 py-6"
                />
              ) : (
                <QuotationTable
                  quotations={quotations}
                  onSelect={(q) => setSelectedId(q.id)}
                  loading={isLoading}
                />
              )}
            </div>
          </div>
        )}
      </section>

      {/* 手工补录：Dialog（不占主视图版面；仍写旧 quotations 事实表） */}
      <Dialog open={manualOpen} onOpenChange={setManualOpen}>
        <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>手工补录报价（旧台账）</DialogTitle>
            <DialogDescription>
              补录写入旧 quotations
              事实表（历史对账用）。当前报价单请走「产品报价 /
              批量报价」；补录不会生成报价单记录，也不参与转订单。
            </DialogDescription>
          </DialogHeader>
          {/* Q15：录入成功后显式 refetch（key 已在 hooks 里统一，双保险） */}
          <NewQuotationForm
            onSuccess={() => {
              setManualOpen(false);
              void refetch();
            }}
          />
        </DialogContent>
      </Dialog>

      <QuotationDetailSheet
        quotation={selectedQuotation}
        onClose={() => setSelectedId(null)}
      />
    </div>
  );
}
