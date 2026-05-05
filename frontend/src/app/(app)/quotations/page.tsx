"use client";

import { useState } from "react";
import {
  useQuotations,
  type QuotationFilters,
  type Quotation,
} from "./hooks/use-quotations";
import { QuotationTable } from "./components/quotation-table";
import { QuotationFilters as FiltersBar } from "./components/quotation-filters";
import { QuotationDetailSheet } from "./components/quotation-detail";
import { NewQuotationForm } from "./components/new-quotation-form";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { usePageView } from "@/lib/events/use-page-view";

export default function QuotationsPage() {
  usePageView({ resource_id: "/quotations" });
  const [filters, setFilters] = useState<QuotationFilters>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { data, isLoading } = useQuotations(filters);

  const quotations = data?.items ?? [];
  const selectedQuotation = selectedId
    ? (quotations.find((q) => q.id === selectedId) ?? null)
    : null;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">报价历史</h1>

      <NewQuotationForm onSuccess={() => {}} />

      <Card>
        <CardHeader className="pb-3">
          <CardTitle>过滤条件</CardTitle>
        </CardHeader>
        <CardContent>
          <FiltersBar filters={filters} onChange={setFilters} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle>
            报价列表
            {data && (
              <span className="ml-2 text-sm font-normal text-muted-foreground">
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
