"use client";

import { useState, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { Copy, Check, AlertCircle, Info, Truck } from "lucide-react";
import { categoryLabel } from "@contracts/categories";
import type { QuoteV2Response, TierItem } from "@contracts/quote";

interface Props {
  result: QuoteV2Response | null;
  error: string | null;
}

interface ProductRow {
  category: string;
  spec: string;
  quantity: number;
  unit: string;
  isMain: boolean;
  tiers: TierItem[];
  weightKg: number | null | undefined;
  baseCost: number | null | undefined;
  total: number | null | undefined;
  status: string;
}

const TIER_LABELS = ["逼单方案", "让利方案", "优选方案"] as const;
const TIER_KEYS = ["low", "standard", "high"] as const;

function tierKey(index: number): "low" | "standard" | "high" {
  return TIER_KEYS[index] ?? "high";
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
          <span>当前规格成本待维护，暂不能自动报价，请人工确认。</span>
        </div>
      );
    case "unsupported_category":
      return (
        <div className="flex items-start gap-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-200">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>当前品类暂不支持自动报价，请人工确认。</span>
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
            ），请人工确认。
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

function buildProducts(result: QuoteV2Response): ProductRow[] {
  const rows: ProductRow[] = [];

  // Main line
  rows.push({
    category: result.main_line.product_category,
    spec: result.main_line.spec_summary,
    quantity: result.main_line.quantity,
    unit: result.main_line.unit,
    isMain: true,
    tiers: result.main_line.tiers,
    weightKg: result.main_line.weight_kg,
    baseCost: result.main_line.base_cost ?? null,
    total: null,
    status: result.main_line.status,
  });

  // Accessory lines — shown as additional product lines
  for (const acc of result.accessory_lines) {
    rows.push({
      category: acc.product_category,
      spec: acc.spec_summary,
      quantity: acc.quantity,
      unit: acc.unit,
      isMain: false,
      tiers: [],
      weightKg: null,
      total: acc.total,
      baseCost: null,
      status: acc.status,
    });
  }

  return rows;
}

function generateSingleTierScript(
  result: QuoteV2Response,
  tierIdx: number,
): string {
  const tier = result.main_line.tiers[tierIdx];
  if (!tier) return result.copyable_script;

  const unit = result.main_line.unit;
  const specSummary = result.main_line.spec_summary;
  const quantity = result.main_line.quantity;
  const weightKg = result.main_line.weight_kg;
  const lines: string[] = [];

  lines.push(`【${categoryLabel(result.product_category)}报价单】`);
  lines.push("");
  lines.push(`产品: ${specSummary}`);
  lines.push(`数量: ${quantity} ${unit}`);
  if (weightKg && result.product_category !== "post") {
    lines.push(`单${unit}重量: ${weightKg} kg`);
    lines.push(`总重量: ${(weightKg * quantity).toFixed(1)} kg`);
  }
  lines.push("");

  const marginLabel =
    tier.margin_rate != null
      ? `（利润率 ${((tier.margin_rate - 1) * 100).toFixed(0)}%）`
      : "";
  lines.push(
    `优惠专享价${marginLabel}: ${tier.unit_price.toFixed(2)} 元/${unit}，合计 ${tier.total.toFixed(2)} 元`,
  );
  lines.push("");

  if (result.accessory_lines.length > 0) {
    lines.push("立柱:");
    for (const acc of result.accessory_lines) {
      const accTotal = acc.total ?? 0;
      lines.push(
        `  ${acc.spec_summary} x ${acc.quantity}${acc.unit} = ${accTotal.toFixed(2)} 元`,
      );
    }
    lines.push("");
  }

  if (result.freight?.chosen) {
    const chosen = result.freight.chosen;
    lines.push(
      `运费 (${result.freight.province || ""}): ${chosen.carrier} ${chosen.amount.toFixed(2)} 元`,
    );
    lines.push("");
  }

  const totalKey = tierKey(tierIdx);
  lines.push(`合计: ${result.totals[totalKey].toFixed(2)} 元`);
  lines.push("");
  lines.push("---");
  lines.push("以上报价为系统自动生成，仅供客户参考，实际成交价以合同为准。");
  lines.push("如需调整数量、规格或配送地址，请与您的专属客服联系。");

  return lines.join("\n");
}

export function QuoteResult({ result, error }: Props) {
  const [selectedTier, setSelectedTier] = useState(2); // 默认优选方案（最高利润率）

  // 防御性检查：即使 status=matched，若 tiers 为空则视为不可报价
  const isActuallyMatched =
    result?.status === "matched" && (result.main_line.tiers?.length ?? 0) > 0;

  const tierScript = useMemo(() => {
    if (!result || !isActuallyMatched) return result?.copyable_script ?? "";
    return generateSingleTierScript(result, selectedTier);
  }, [result, selectedTier, isActuallyMatched]);
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
  const products = buildProducts(result);

  return (
    <div className="space-y-4">
      {/* Status Banner */}
      {!isActuallyMatched && (
        <StatusMessage
          status={
            result.main_line.tiers?.length === 0 && result.status === "matched"
              ? "cost_pending"
              : result.status
          }
        />
      )}

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">报价结果</CardTitle>
            <Badge variant={statusConfig.variant}>{statusConfig.label}</Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {isActuallyMatched && (
            <>
              {/* 产品明细 */}
              <div>
                <h4 className="mb-2 text-sm font-medium">产品明细</h4>
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b text-muted-foreground">
                      <th className="py-1 text-left font-medium">产品</th>
                      <th className="py-1 text-left font-medium">规格</th>
                      <th className="py-1 text-right font-medium">数量</th>
                      <th className="py-1 text-right font-medium">单位</th>
                      <th className="py-1 text-right font-medium">成本单价</th>
                      <th className="py-1 text-right font-medium">成本合计</th>
                    </tr>
                  </thead>
                  <tbody>
                    {products.map((p, i) => (
                      <tr key={i}>
                        <td className="py-1 text-left">{p.category}</td>
                        <td className="py-1 text-left">{p.spec}</td>
                        <td className="py-1 text-right">{p.quantity}</td>
                        <td className="py-1 text-right">{p.unit}</td>
                        <td className="py-1 text-right">
                          {p.baseCost != null
                            ? `¥${p.baseCost.toFixed(2)}`
                            : p.total != null
                              ? `¥${(p.total / p.quantity).toFixed(2)}`
                              : "—"}
                        </td>
                        <td className="py-1 text-right">
                          {p.baseCost != null
                            ? `¥${(p.baseCost * p.quantity).toFixed(2)}`
                            : p.total != null
                              ? `¥${p.total.toFixed(2)}`
                              : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <Separator />

              {/* 梯度价格 */}
              <div>
                <h4 className="mb-2 text-sm font-medium">梯度价格</h4>
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b text-muted-foreground">
                      <th className="py-1 text-left font-medium">方案</th>
                      <th className="py-1 text-right font-medium">利润率</th>
                      <th className="py-1 text-right font-medium">
                        单价 (元/{products[0]?.unit ?? "卷"})
                      </th>
                      <th className="py-1 text-right font-medium">小计</th>
                      <th className="py-1 text-right font-medium">含税合计</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(products[0]?.tiers ?? []).map((tier, i) => {
                      const taxAmount = tier.total - tier.subtotal;
                      return (
                        <tr
                          key={i}
                          className={i === selectedTier ? "bg-accent/30" : ""}
                        >
                          <td className="py-1 text-left font-medium">
                            {TIER_LABELS[i]}
                          </td>
                          <td className="py-1 text-right">
                            {tier.margin_rate != null
                              ? `${((tier.margin_rate - 1) * 100).toFixed(0)}%`
                              : "—"}
                          </td>
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
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <Separator />

              {/* 运费 */}
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

              {/* 报价合计 — 选择利润率挡位 */}
              <div>
                <h4 className="mb-2 text-sm font-medium">报价合计</h4>
                <div className="flex flex-wrap gap-2 mb-3">
                  {(products[0]?.tiers ?? []).map((tier, i) => {
                    const tk = tierKey(i);
                    const total = result.totals[tk];
                    const isSelected = selectedTier === i;
                    return (
                      <button
                        key={i}
                        type="button"
                        onClick={() => setSelectedTier(i)}
                        className={`flex flex-col items-center gap-0.5 rounded-lg border px-3 py-2 text-xs cursor-pointer transition-colors ${
                          isSelected
                            ? "border-primary bg-primary/10 text-primary font-medium"
                            : "border-input text-muted-foreground hover:border-ring"
                        }`}
                      >
                        <span className="text-sm font-semibold">
                          {TIER_LABELS[i]}
                        </span>
                        <span>¥{total.toFixed(2)}</span>
                        {tier.margin_rate != null && (
                          <span className="text-[10px] opacity-70">
                            利润率 {((tier.margin_rate - 1) * 100).toFixed(0)}%
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
                {/* 所选方案的详细金额 */}
                {(() => {
                  const tier = (products[0]?.tiers ?? [])[selectedTier];
                  if (!tier) return null;
                  const taxAmount = tier.total - tier.subtotal;
                  return (
                    <div className="rounded-lg bg-muted/50 p-3 text-xs space-y-1">
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">方案</span>
                        <span className="font-medium">
                          {TIER_LABELS[selectedTier]}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">小计</span>
                        <span>¥{tier.subtotal.toFixed(2)}</span>
                      </div>
                      {taxAmount > 0 && (
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">税费</span>
                          <span>¥{taxAmount.toFixed(2)}</span>
                        </div>
                      )}
                      <Separator />
                      <div className="flex justify-between font-medium">
                        <span>合计</span>
                        <span>
                          ¥{result.totals[tierKey(selectedTier)].toFixed(2)}
                        </span>
                      </div>
                    </div>
                  );
                })()}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Copyable Script */}
      {tierScript && (
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm">可复制话术</CardTitle>
              <CopyButton text={tierScript} />
            </div>
          </CardHeader>
          <CardContent>
            <Textarea
              readOnly
              value={tierScript}
              className="min-h-[200px] text-xs leading-relaxed"
            />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
