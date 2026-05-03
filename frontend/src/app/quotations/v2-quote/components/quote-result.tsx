"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { Copy, Check, AlertCircle, Info, Truck, Package } from "lucide-react";
import type { QuoteV2Response } from "@contracts/quote";

interface Props {
  result: QuoteV2Response | null;
  error: string | null;
}

const STATUS_CONFIG: Record<
  string,
  {
    variant: "default" | "destructive" | "secondary" | "outline";
    label: string;
  }
> = {
  matched: { variant: "default", label: "已匹配" },
  no_match: { variant: "destructive", label: "未匹配" },
  too_many: { variant: "destructive", label: "匹配过多" },
  cost_pending: { variant: "secondary", label: "成本待处理" },
  pricing_profile_missing: { variant: "secondary", label: "定价策略缺失" },
  freight_missing: { variant: "outline", label: "运费未配置" },
  unsupported_category: { variant: "destructive", label: "暂不支持品类" },
};

function StatusMessage({ status }: { status: string }) {
  switch (status) {
    case "no_match":
      return (
        <div className="flex items-start gap-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-200">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>当前规格未匹配到报价规则，请调整规格参数后重新尝试。</span>
        </div>
      );
    case "too_many":
      return (
        <div className="flex items-start gap-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-200">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>当前规格匹配到多条记录，请细化筛选条件后重新尝试。</span>
        </div>
      );
    case "cost_pending":
      return (
        <div className="flex items-start gap-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-200">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>
            当前规格成本待维护，暂不能自动报价。请联系管理员维护成本数据。
          </span>
        </div>
      );
    case "unsupported_category":
      return (
        <div className="flex items-start gap-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-200">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>当前品类暂不支持自动报价。仅支持牛栏网品类。</span>
        </div>
      );
    case "pricing_profile_missing":
    case "freight_missing":
      return (
        <div className="flex items-start gap-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-200">
          <Info className="mt-0.5 size-4 shrink-0" />
          <span>
            当前配置不完整（
            {status === "pricing_profile_missing" ? "定价策略" : "运费配置"}
            ），请联系管理员处理。
          </span>
        </div>
      );
    default:
      return null;
  }
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // fallback
      const textarea = document.createElement("textarea");
      textarea.value = text;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={handleCopy}
      className="text-xs"
    >
      {copied ? (
        <>
          <Check className="mr-1 size-3 text-green-500" />
          已复制
        </>
      ) : (
        <>
          <Copy className="mr-1 size-3" />
          一键复制话术
        </>
      )}
    </Button>
  );
}

export function QuoteResult({ result, error }: Props) {
  if (error) {
    return (
      <Card>
        <CardContent className="pt-6">
          <div className="flex items-start gap-2 rounded-lg bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <div>
              <p className="font-medium">报价失败</p>
              <p className="mt-1">{error}</p>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!result) return null;

  const statusConfig = STATUS_CONFIG[result.status] ?? {
    variant: "secondary" as const,
    label: result.status,
  };
  const { main_line } = result;

  return (
    <div className="space-y-4">
      {/* Status Banner */}
      {result.status !== "matched" && <StatusMessage status={result.status} />}

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">报价结果</CardTitle>
            <Badge variant={statusConfig.variant}>{statusConfig.label}</Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Notes */}
          {result.notes.length > 0 && (
            <div className="rounded-lg bg-muted/50 p-2.5 text-xs text-muted-foreground">
              {result.notes.map((note, i) => (
                <p key={i} className="flex items-center gap-1">
                  <Info className="size-3 shrink-0" />
                  {note}
                </p>
              ))}
            </div>
          )}

          {result.status === "matched" && (
            <>
              {/* Main Line */}
              <div>
                <h4 className="mb-2 text-sm font-medium flex items-center gap-1.5">
                  <Package className="size-4" />
                  主产品
                </h4>
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b text-muted-foreground">
                      <th className="py-1 text-left font-medium">产品</th>
                      <th className="py-1 text-right font-medium">规格</th>
                      <th className="py-1 text-right font-medium">数量</th>
                      <th className="py-1 text-right font-medium">单位</th>
                      {main_line.weight_kg != null && (
                        <th className="py-1 text-right font-medium">单卷重</th>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td className="py-1 text-left">
                        {main_line.product_category}
                      </td>
                      <td className="py-1 text-right">
                        {main_line.spec_summary}
                      </td>
                      <td className="py-1 text-right">{main_line.quantity}</td>
                      <td className="py-1 text-right">{main_line.unit}</td>
                      {main_line.weight_kg != null && (
                        <td className="py-1 text-right">
                          {main_line.weight_kg} kg
                        </td>
                      )}
                    </tr>
                  </tbody>
                </table>
              </div>

              <Separator />

              {/* Tiers */}
              <div>
                <h4 className="mb-2 text-sm font-medium">梯度价格</h4>
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b text-muted-foreground">
                      <th className="py-1 text-left font-medium">档次</th>
                      <th className="py-1 text-right font-medium">
                        单价 (元/{main_line.unit})
                      </th>
                      <th className="py-1 text-right font-medium">小计</th>
                      <th className="py-1 text-right font-medium">合计</th>
                    </tr>
                  </thead>
                  <tbody>
                    {main_line.tiers.map((tier, i) => (
                      <tr key={i}>
                        <td className="py-1 text-left">{tier.label}</td>
                        <td className="py-1 text-right">
                          ¥{tier.unit_price.toFixed(2)}
                        </td>
                        <td className="py-1 text-right">
                          ¥{tier.subtotal.toFixed(2)}
                        </td>
                        <td className="py-1 text-right font-medium">
                          ¥{tier.total.toFixed(2)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <Separator />

              {/* Accessories */}
              {result.accessory_lines.length > 0 && (
                <>
                  <div>
                    <h4 className="mb-2 text-sm font-medium flex items-center gap-1.5">
                      <Package className="size-4" />
                      配件
                    </h4>
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b text-muted-foreground">
                          <th className="py-1 text-left font-medium">配件</th>
                          <th className="py-1 text-right font-medium">数量</th>
                          <th className="py-1 text-right font-medium">单位</th>
                          <th className="py-1 text-right font-medium">金额</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.accessory_lines.map((acc, i) => (
                          <tr key={i}>
                            <td className="py-1 text-left">
                              {acc.spec_summary}
                            </td>
                            <td className="py-1 text-right">{acc.quantity}</td>
                            <td className="py-1 text-right">{acc.unit}</td>
                            <td className="py-1 text-right">
                              ¥{acc.total != null ? acc.total.toFixed(2) : "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <Separator />
                </>
              )}

              {/* Freight */}
              {result.freight && result.freight.chosen && (
                <>
                  <div>
                    <h4 className="mb-2 text-sm font-medium flex items-center gap-1.5">
                      <Truck className="size-4" />
                      运费
                    </h4>
                    <div className="space-y-1 text-xs">
                      <p>承运商: {result.freight.chosen.carrier}</p>
                      <p>
                        运费金额: ¥{result.freight.chosen.amount.toFixed(2)}
                      </p>
                      {result.freight.province && (
                        <p>配送省份: {result.freight.province}</p>
                      )}
                    </div>
                  </div>
                  <Separator />
                </>
              )}

              {/* Totals */}
              <div>
                <h4 className="mb-2 text-sm font-medium">总计</h4>
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b text-muted-foreground">
                      <th className="py-1 text-left font-medium">方案</th>
                      <th className="py-1 text-right font-medium">合计金额</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td className="py-1 text-left">低配</td>
                      <td className="py-1 text-right font-medium">
                        ¥{result.totals.low.toFixed(2)}
                      </td>
                    </tr>
                    <tr>
                      <td className="py-1 text-left">标准</td>
                      <td className="py-1 text-right font-medium">
                        ¥{result.totals.standard.toFixed(2)}
                      </td>
                    </tr>
                    <tr>
                      <td className="py-1 text-left">高配</td>
                      <td className="py-1 text-right font-medium">
                        ¥{result.totals.high.toFixed(2)}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Copyable Script */}
      {result.copyable_script && (
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm">可复制话术</CardTitle>
              <CopyButton text={result.copyable_script} />
            </div>
          </CardHeader>
          <CardContent>
            <Textarea
              readOnly
              value={result.copyable_script}
              className="min-h-[200px] text-xs leading-relaxed"
            />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
