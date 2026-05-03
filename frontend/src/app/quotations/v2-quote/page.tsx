"use client";

import { useState } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { usePageView } from "@/lib/events/use-page-view";
import { useQuoteV2 } from "./hooks/use-v2-quote";
import { QuoteForm } from "./components/quote-form";
import { QuoteResult } from "./components/quote-result";
import { handleApiError } from "@/lib/api/error-handler";
import type { QuoteV2Request, QuoteV2Response } from "@contracts/quote";

export default function V2QuotePage() {
  usePageView({ resource_id: "/quotations/v2-quote" });

  const quoteMutation = useQuoteV2();
  const [result, setResult] = useState<QuoteV2Response | null>(null);
  const [error, setError] = useState<string | null>(null);

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

      <div className="grid gap-6 lg:grid-cols-5">
        <div className="lg:col-span-2">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">报价参数</CardTitle>
            </CardHeader>
            <CardContent>
              <QuoteForm
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
                  请在左侧填写报价参数，点击&ldquo;获取报价&rdquo;查看结果
                </p>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
