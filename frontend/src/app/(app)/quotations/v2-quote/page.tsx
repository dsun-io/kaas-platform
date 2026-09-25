"use client";

import { useState, useRef } from "react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardAction,
} from "@/components/ui/card";
import { usePageView } from "@/lib/events/use-page-view";
import { useQuoteV2 } from "./hooks/use-v2-quote";
import { QuoteForm, type QuoteFormHandle } from "./components/quote-form";
import { QuoteResult } from "./components/quote-result";
import { BulkImportPanel } from "./components/bulk-import-panel";
import { handleApiError } from "@/lib/api/error-handler";
import type { QuoteV2Request, QuoteV2Response } from "@contracts/quote";
import { Button } from "@/components/ui/button";
import { RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { PricingDataManager } from "../../pricing-data/pricing-data-manager";

type QuoteTab = "assistant" | "bulk-import" | "pricing-data";

export default function V2QuotePage() {
  usePageView({ resource_id: "/quotations/v2-quote" });

  const quoteMutation = useQuoteV2();
  const [result, setResult] = useState<QuoteV2Response | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<QuoteTab>("assistant");
  const formRef = useRef<QuoteFormHandle>(null);

  const handleSubmit = async (input: QuoteV2Request) => {
    setResult(null);
    setError(null);

    try {
      const data = await quoteMutation.mutateAsync(input);
      setResult(data);
    } catch (err: unknown) {
      if (err instanceof Error && "response" in err) {
        const msg = handleApiError(err as Parameters<typeof handleApiError>[0]);
        setError(msg);
      } else if (err instanceof Error) {
        setError(err.message);
      } else {
        setError("未知错误，请稍后重试");
      }
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">智能报价</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          选择产品规格，系统自动计算报价并生成可复制话术
        </p>
      </div>

      <div className="flex gap-2 border-b">
        {(
          [
            {
              key: "assistant",
              label: "报价助手",
            },
            {
              key: "bulk-import",
              label: "批量导入",
            },
            { key: "pricing-data", label: "报价数据" },
          ] as { key: QuoteTab; label: string }[]
        ).map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              "px-4 pb-2 text-sm border-b-2 -mb-px transition-colors",
              tab === t.key
                ? "border-primary font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "pricing-data" && <PricingDataManager />}

      {tab === "bulk-import" && <BulkImportPanel />}

      {tab === "assistant" && (
        <div className="grid gap-6 lg:grid-cols-5">
          <div className="lg:col-span-2">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">报价参数</CardTitle>
                <CardAction>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-auto px-2 py-1 text-xs text-muted-foreground"
                    onClick={() => formRef.current?.resetAll()}
                  >
                    <RotateCcw className="mr-1 size-3" />
                    清空
                  </Button>
                </CardAction>
              </CardHeader>
              <CardContent>
                <QuoteForm
                  ref={formRef}
                  onSubmit={handleSubmit}
                  isLoading={quoteMutation.isPending}
                />
              </CardContent>
            </Card>
          </div>

          <div className="lg:col-span-3">
            {(result || error) && <QuoteResult result={result} error={error} />}

            {!result && !error && (
              <Card>
                <CardContent className="flex flex-col items-center justify-center py-16 text-center">
                  <p className="text-sm text-muted-foreground">
                    请填写报价参数，点击&ldquo;获取报价&rdquo;查看结果
                  </p>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
