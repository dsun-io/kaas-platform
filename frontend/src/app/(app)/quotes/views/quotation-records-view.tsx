"use client";

/**
 * 报价记录（历史台账）。
 *
 * 从原 `/quotations` 页面抽出为可嵌入视图：工位内不再"页面套页面"。
 * 页面标题由工位容器统一渲染，所以这里不输出 h1。
 *
 * ⚠ 台账的写入门槛（平台升级方案 P4）：只在**业务节点**写入
 * （报价单签发 / 订单成交），试算不落账。此处的「新建」入口是手工补录，
 * 与自动入账并存 —— 是否保留待业务确认，不在本次改动中移除。
 */
import { useState } from "react";
import {
  useQuotations,
  type QuotationFilters,
  type Quotation,
} from "../../quotations/hooks/use-quotations";
import { QuotationTable } from "../../quotations/components/quotation-table";
import { QuotationFilters as FiltersBar } from "../../quotations/components/quotation-filters";
import { QuotationDetailSheet } from "../../quotations/components/quotation-detail";
import { NewQuotationForm } from "../../quotations/components/new-quotation-form";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";

export function QuotationRecordsView() {
  const [filters, setFilters] = useState<QuotationFilters>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { data, isLoading } = useQuotations(filters);

  const quotations: Quotation[] = data?.items ?? [];
  const selectedQuotation = selectedId
    ? (quotations.find((q) => q.id === selectedId) ?? null)
    : null;

  return (
    <div className="space-y-5">
      <NewQuotationForm onSuccess={() => {}} />

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">过滤条件</CardTitle>
        </CardHeader>
        <CardContent>
          <FiltersBar filters={filters} onChange={setFilters} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">
            报价列表
            {data && (
              <span className="ml-2 font-normal text-muted-foreground">
                共 {data.total} 条
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <QuotationTable
            quotations={quotations}
            onSelect={(q) => setSelectedId(q.id)}
            loading={isLoading}
          />
        </CardContent>
      </Card>

      <QuotationDetailSheet
        quotation={selectedQuotation}
        onClose={() => setSelectedId(null)}
      />
    </div>
  );
}
