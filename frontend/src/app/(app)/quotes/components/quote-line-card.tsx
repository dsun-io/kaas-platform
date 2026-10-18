"use client";

/**
 * 多产品报价 · 单个产品行。
 *
 * 一行 = 一个产品 + 它自己的一套规格与数量。**行内不含整单级参数**
 * （币种/汇率/税率/贸易术语都在工作台顶部统一维护）—— 那些参数整单只有一份，
 * 放在行里会让人以为"每个产品各填一次"，从而真填出不一样的值。
 *
 * 例外是**加工利润**：不同产品的供货厂与竞争情况不同，利润常常不一样，
 * 所以它支持逐行覆盖（留空 = 继承整单默认）。这是唯一一个"整单默认 + 行内覆盖"的参数。
 */
import { useEffect, useState } from "react";
import { AlertTriangle, ChevronDown, Loader2, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { handleApiError } from "@/lib/api/error-handler";
import { cn } from "@/lib/utils";
import type { ExportQuoteResponse } from "@contracts/export-quote";

import { useExportProducts } from "../../quotations/v2-quote/hooks/use-export-quote-import";
import { useProductCostReference } from "../hooks/use-cost-reference";
import {
  useCalcQuote,
  useProductFormulas,
  type QuoteView,
} from "../../quotations/v2-quote/hooks/use-export-quote-calc";
import {
  SpecPicker,
  isSpecComplete,
  type SpecRow,
} from "../../quotations/v2-quote/components/spec-picker";
import { EngineQuoteResult } from "../../quotations/v2-quote/components/engine-quote-result";
import {
  buildLineRequest,
  pieceDefault,
  pieceScale,
  scale6,
  type SharedQuoteParams,
} from "../lib/build-request";
import type { BuiltTerms } from "../lib/terms-amortize";
import {
  buildLineItem,
  makeColumnIndexer,
  type BuiltLineItem,
} from "../lib/line-to-item";
import { useReferencePrice } from "../hooks/use-reference-price";
/** 工作台里的一行（新增/删除/编辑都作用在它身上）。 */
export interface LineDraft {
  id: string;
  productKey: string;
  spec: SpecRow;
  /** 用户按件改写的值（**界面单位**的字符串；空 = 跟随规格默认） */
  pieceOverrides: Record<string, string>;
  /** 件数（卷数）。刻意不给默认值 —— 默认值会让人不填就提交 */
  pieces: string;
  /** 逐行覆盖的利润率（%）；留空 = 继承整单 */
  profitPctOverride: string;
  /** 本行手工成本覆盖（单位由产品定义给出：勾花网元/㎡，牛栏网元/kg）；留空 = 用产品定义/历史报价参考 */
  costOverride: string;
  /** 本行包装（产品 packaging[].id）；留空 = 默认包装 */
  packagingId: string;
  result: ExportQuoteResponse | null;
  built: BuiltLineItem | null;
  error: string | null;
  /** 该产品声明的体积扣减口径（汇总时用于算"实际占用体积"） */
  spaceDeduction?: { mode?: unknown; value?: unknown } | null;
}

export function newLineDraft(productKey = ""): LineDraft {
  return {
    id: Math.random().toString(36).slice(2, 10),
    productKey,
    spec: {},
    pieceOverrides: {},
    pieces: "",
    profitPctOverride: "",
    costOverride: "",
    packagingId: "",
    result: null,
    built: null,
    error: null,
  };
}

interface Props {
  index: number;
  line: LineDraft;
  shared: SharedQuoteParams;
  view: QuoteView;
  /**
   * 本行的贸易术语（**每行一份**）：整批费用已按件数比例分摊。
   * 未启用出口费用时不传 → 只算 EXW。
   */
  terms?: BuiltTerms | null;
  /** 整单行数（用于把"整批费用已分摊"提示写清楚） */
  lineCount: number;
  /** 整单客户（工作台 CustomerPicker 的 id）：用于历史参考价查询 */
  customerId?: string | null;
  onChange: (patch: Partial<LineDraft>) => void;
  onRemove: () => void;
  /** 整单报价信号：递增即触发本行计算（0/undefined = 不触发） */
  calcSignal?: number;
}

export function QuoteLineCard({
  index,
  line,
  shared,
  view,
  terms,
  lineCount,
  customerId = null,
  onChange,
  onRemove,
  calcSignal = 0,
}: Props) {
  const products = useExportProducts();
  const effectiveProduct =
    line.productKey || products.data?.products[0]?.key || "";
  const formulas = useProductFormulas(effectiveProduct || null, true);
  const calc = useCalcQuote();
  // 历史参考价（实时报价的回落参考）：同客户+同产品近 N 天已落库报价区间。
  // product_name 用「英文名优先」——与保存进行项的口径（buildLineItem）一致，
  // 否则参考价聚合键与落库键对不上，永远查不到。
  const refProductName = formulas.data
    ? formulas.data.name_en || formulas.data.name
    : null;
  const reference = useReferencePrice(
    customerId,
    effectiveProduct && refProductName ? refProductName : null,
  );
  const [expanded, setExpanded] = useState(false);

  // 换产品 → 规格空间变了 → 回到"未选择"。
  // 不预置第一组取值：预置会让人不填就报价，而规格决定成本/重量/体积。
  useEffect(() => {
    if (formulas.data)
      onChange({ spec: {}, result: null, built: null, error: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formulas.data]);

  // 换规格 → 按件参数回到"跟随规格"，否则会把上一组规格的卷长/卷径带过去。
  useEffect(() => {
    onChange({ pieceOverrides: {} });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [line.spec]);

  const groups = [
    ...(formulas.data?.space.axes ?? []),
    ...(formulas.data?.space.variants ?? []),
  ];
  const pieceInputs = formulas.data?.piece_inputs ?? [];

  // ── 成本（需求 11）：默认取规格里的成本字段；可本单手改 ──────────────────
  // 单位由产品定义给出：勾花网 `CNY/㎡`（按平米算），牛栏网 `CNY/kg`。
  const costField = formulas.data?.cost.field ?? "";
  const costUnitLabel = (formulas.data?.cost.unit ?? "").replace("CNY", "元");
  const specCost = (() => {
    if (!costField) return 0;
    for (const group of groups) {
      const option = group.options.find(
        (o) => String(o.value) === String(line.spec[group.name]),
      );
      const raw = option?.attributes?.[costField];
      if (raw !== undefined && raw !== null && String(raw) !== "") {
        return Number(raw) || 0;
      }
    }
    return 0;
  })();
  const typedCost = line.costOverride.trim();
  // 成本来源优先级：本单手填 > 规格里的成本字段 > 历史参考成本（同规格最近一次/30天中位数）
  const costRef = useProductCostReference(effectiveProduct, line.spec);
  const referenceCost = costRef.data?.cost ?? null;
  const effectiveCost =
    typedCost !== ""
      ? Number(typedCost) || 0
      : specCost > 0
        ? specCost
        : (referenceCost ?? 0);
  /** 需要传给引擎覆盖的成本（规格本身带成本时不覆盖；手填或历史参考才覆盖） */
  const costOverrideToSend =
    typedCost !== ""
      ? Number(typedCost) || 0
      : specCost > 0
        ? null
        : referenceCost;

  // ── 包装（需求 20）：默认包装优先；区间按当前规格取值 ────────────────────
  const packagingOptions = formulas.data?.packaging ?? [];
  const defaultPackaging =
    packagingOptions.find((p) => p.is_default) ??
    [...packagingOptions].sort((a, b) =>
      String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")),
    )[0] ??
    null;
  const effectivePackaging =
    packagingOptions.find((p) => p.id === line.packagingId) ?? defaultPackaging;
  const packagingFee = (() => {
    if (!effectivePackaging) return 0;
    for (const rng of effectivePackaging.ranges) {
      const fieldValue = Number(line.spec[rng.field]);
      if (!Number.isFinite(fieldValue)) continue;
      if (rng.min != null && fieldValue < rng.min) continue;
      if (rng.max != null && fieldValue >= rng.max) continue;
      return rng.amount;
    }
    return effectivePackaging.amount;
  })();

  const baseOf = (variant: string, key: string): string =>
    pieceDefault(groups, line.spec, variant, key);

  const displayOf = (pi: {
    key: string;
    variant: string;
    ui_scale?: number;
    ui_unit?: string;
    unit: string;
  }): { value: string; hint: string } => {
    const typed = line.pieceOverrides[pi.key];
    const d = baseOf(pi.variant, pi.key);
    const scale = pieceScale(pi as never);
    const hint = d ? String(scale6((Number(d) || 0) * scale)) : "";
    if (typed !== undefined && typed !== "") return { value: typed, hint };
    return { value: hint, hint };
  };

  const baseOverrideOf = (pi: {
    key: string;
    ui_scale?: number;
  }): number | null => {
    const typed = line.pieceOverrides[pi.key];
    if (typed === undefined || typed === "") return null;
    const n = Number(typed);
    return Number.isFinite(n) ? n / pieceScale(pi as never) : null;
  };

  const unitQtyInput = pieceInputs.find((pi) => pi.unit_quantity);
  const unitQtyDefault = unitQtyInput
    ? Number(baseOf(unitQtyInput.variant, unitQtyInput.key)) || 0
    : 0;
  const unitQty = unitQtyInput
    ? (baseOverrideOf(unitQtyInput) ?? unitQtyDefault)
    : 0;
  const total = unitQty * (Number(line.pieces) || 0);

  const variantOverrides = (() => {
    const out: Record<string, Record<string, Record<string, number>>> = {};
    for (const pi of pieceInputs) {
      const n = baseOverrideOf(pi);
      if (n === null || !pi.variant) continue;
      const optionName = String(line.spec[pi.variant] ?? "");
      if (!optionName) continue;
      const group = out[pi.variant] ?? (out[pi.variant] = {});
      group[optionName] = { ...(group[optionName] ?? {}), [pi.key]: n };
    }
    return out;
  })();

  const specReady = formulas.data
    ? isSpecComplete(formulas.data, line.spec)
    : false;
  const canSubmit =
    !!effectiveProduct && specReady && Number(shared.fxRate) > 0 && total > 0;

  /** 结果表取值（列键由产品定义给出，不按表头文字猜）。 */
  const readNum = (key: string): number | null => {
    if (!line.result || !formulas.data) return null;
    const index = makeColumnIndexer(formulas.data, view)(key);
    if (index < 0) return null;
    const table =
      view === "internal" && line.result.internal
        ? line.result.internal
        : line.result.customer;
    const cell = table.rows[0]?.[index];
    return typeof cell === "number" && Number.isFinite(cell) ? cell : null;
  };

  const compute = async () => {
    if (!formulas.data) return;
    onChange({ error: null });
    try {
      // 成本手改：以变体覆盖的方式传给引擎（只影响本行，不回写定价数据）
      const overrides = {
        ...variantOverrides,
      } as Record<string, Record<string, Record<string, number>>>;
      if (typedCost !== "" && costField) {
        for (const group of groups) {
          const optionName = String(line.spec[group.name] ?? "");
          if (!optionName) continue;
          const option = group.options.find(
            (o) => String(o.value) === optionName,
          );
          if (option?.attributes?.[costField] === undefined) continue;
          const bucket = overrides[group.name] ?? (overrides[group.name] = {});
          bucket[optionName] = {
            ...(bucket[optionName] ?? {}),
            [costField]: Number(typedCost) || 0,
          };
          break;
        }
      } else if (costOverrideToSend !== null && costField) {
        // 规格没有成本字段 / 未填成本 → 用历史参考成本覆盖
        for (const group of groups) {
          const optionName = String(line.spec[group.name] ?? "");
          if (!optionName) continue;
          const option = group.options.find(
            (o) => String(o.value) === optionName,
          );
          if (option?.attributes?.[costField] === undefined) continue;
          const bucket = overrides[group.name] ?? (overrides[group.name] = {});
          bucket[optionName] = {
            ...(bucket[optionName] ?? {}),
            [costField]: costOverrideToSend,
          };
          break;
        }
      }
      const payload = buildLineRequest({
        productKey: effectiveProduct,
        spec: line.spec,
        variantOverrides: overrides,
        total,
        unit: unitQtyInput?.unit || "m",
        profitPctOverride: line.profitPctOverride,
        packagingId: effectivePackaging?.id ?? "",
        terms: terms ?? null,
        shared,
      });
      const result = await calc.mutateAsync({ payload, view });
      const product = (products.data?.products ?? []).find(
        (p) => p.key === effectiveProduct,
      );
      const built = buildLineItem({
        product: product ?? {
          key: effectiveProduct,
          name: formulas.data.name,
          name_en: formulas.data.name_en,
          hs_codes: formulas.data.hs_codes,
        },
        formulas: formulas.data,
        spec: line.spec,
        pieceBase: {
          ...variantOverrides[unitQtyInput?.variant ?? ""]?.[
            String(line.spec[unitQtyInput?.variant ?? ""] ?? "")
          ],
        },
        result,
        view,
        pieces: Number(line.pieces) || 0,
        rollLengthM: unitQty || null,
        costOverride: typedCost === "" ? null : effectiveCost,
        packaging: effectivePackaging
          ? {
              id: effectivePackaging.id,
              name: effectivePackaging.name,
              fee_per_piece: packagingFee,
            }
          : null,
      });
      onChange({
        result,
        built,
        error: null,
        spaceDeduction: formulas.data.space_deduction,
      });
    } catch (err) {
      const message =
        err instanceof Error && "response" in err
          ? handleApiError(err as Parameters<typeof handleApiError>[0])
          : err instanceof Error
            ? err.message
            : "算价失败";
      onChange({ result: null, built: null, error: message });
    }
  };

  // 整单报价：父组件递增 calcSignal → 本行重算（保留逐行计算作为验证入口）
  useEffect(() => {
    if (calcSignal > 0) void compute();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [calcSignal]);

  const unitPriceFx = readNum("piece.price_per_piece_fx");
  const pricePerMeter = readNum("piece.price_per_meter");
  const lineAmount = line.built?.item.line_amount ?? null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <CardTitle className="text-sm">
            产品行 {index + 1}：
            <select
              value={effectiveProduct}
              onChange={(e) =>
                onChange({
                  productKey: e.target.value,
                  spec: {},
                  result: null,
                  built: null,
                  error: null,
                  packagingId: "",
                  costOverride: "",
                })
              }
              disabled={products.isLoading}
              className="ml-1 h-7 rounded-md border border-input bg-background px-1.5 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {(products.data?.products ?? []).length === 0 && (
                <option value="">
                  {products.isLoading ? "加载中…" : "暂无可报价产品"}
                </option>
              )}
              {(products.data?.products ?? []).map((p) => (
                <option key={p.key} value={p.key}>
                  {p.name}
                </option>
              ))}
            </select>
            {line.pieces && Number(line.pieces) > 0 && (
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                {line.pieces} 卷
              </span>
            )}
          </CardTitle>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 gap-1 text-xs text-muted-foreground"
            onClick={onRemove}
          >
            <Trash2 className="size-3" />
            删除本行
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {reference.data && reference.data.count > 0 ? (
          <p className="text-xs text-muted-foreground">
            历史参考（近 {reference.data.days} 天 · 同客户同产品{" "}
            {reference.data.count} 次）：{reference.data.min?.toFixed(2)} ~{" "}
            {reference.data.max?.toFixed(2)}，中位{" "}
            {reference.data.median?.toFixed(2)}
            {reference.data.last_at
              ? ` · 最近 ${new Date(reference.data.last_at).toLocaleDateString("zh-CN")}`
              : ""}
          </p>
        ) : null}
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {pieceInputs.map((pi) => {
            const { value, hint } = displayOf(pi as never);
            const unit = pi.ui_unit || pi.unit;
            return (
              <div key={pi.key} className="space-y-1.5">
                <Label className="text-xs">
                  {pi.label}
                  {unit ? `（${unit}）` : ""}
                </Label>
                <Input
                  type="number"
                  step="any"
                  value={value}
                  onChange={(e) =>
                    onChange({
                      pieceOverrides: {
                        ...line.pieceOverrides,
                        [pi.key]: e.target.value,
                      },
                    })
                  }
                  className="h-8 text-xs"
                />
                <p className="text-[11px] text-muted-foreground">
                  默认跟随规格（{hint || "—"}）
                </p>
              </div>
            );
          })}

          <div className="space-y-1.5">
            <Label className="text-xs">件数（卷）</Label>
            <Input
              type="number"
              min={1}
              value={line.pieces}
              onChange={(e) => onChange({ pieces: e.target.value })}
              placeholder="请填写卷数"
              className="h-8 text-xs"
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">
              总数（{unitQtyInput?.unit || "m"}）
            </Label>
            <Input
              type="number"
              value={Number.isFinite(total) ? total : 0}
              readOnly
              className="h-8 bg-muted text-xs"
            />
            <p className="text-[11px] text-muted-foreground">
              单件数量 × 件数，系统计算
            </p>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">
              税前成本{costUnitLabel ? `（${costUnitLabel}）` : ""}
            </Label>
            <Input
              type="number"
              step="any"
              value={line.costOverride}
              onChange={(e) => onChange({ costOverride: e.target.value })}
              placeholder={
                specCost > 0
                  ? String(specCost)
                  : referenceCost !== null
                    ? String(referenceCost)
                    : "请填写成本"
              }
              className="h-8 text-xs"
            />
            <p className="text-[11px] text-muted-foreground">
              {typedCost !== ""
                ? "本单手填，只影响本单"
                : specCost > 0
                  ? "默认取规格/定价数据里的成本"
                  : referenceCost !== null
                    ? `参考历史成本 ¥${referenceCost}${costUnitLabel ? `/${costUnitLabel.replace("元/", "")}` : ""}（${
                        costRef.data?.source === "latest"
                          ? "同规格最近一次"
                          : "近 30 天中位数"
                      }）`
                    : "规格没有成本字段，请手填"}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">包装方式</Label>
            <select
              value={effectivePackaging?.id ?? ""}
              onChange={(e) => onChange({ packagingId: e.target.value })}
              disabled={packagingOptions.length === 0}
              className="h-8 w-full rounded-lg border border-input bg-background px-3 py-1.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {packagingOptions.length === 0 && (
                <option value="">（该产品未配置包装）</option>
              )}
              {packagingOptions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.is_default ? "（默认）" : ""}
                </option>
              ))}
            </select>
            <p className="text-[11px] text-muted-foreground">
              {effectivePackaging
                ? `按规格自动读取：¥${packagingFee.toFixed(2)}/卷`
                : "在产品管理里配置包装与收费区间"}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label
              className="text-xs"
              title="逐行覆盖利润率（%）。不同产品毛利不同；留空 = 继承整单默认"
            >
              本行利润率（%）
            </Label>
            <Input
              type="number"
              step="0.01"
              value={line.profitPctOverride}
              onChange={(e) =>
                onChange({ profitPctOverride: e.target.value })
              }
              placeholder="留空 = 用整单默认"
              className="h-8 text-xs"
            />
            <p className="text-[11px] text-muted-foreground">
              售价 = 成本 ÷ (1 − 利润率 − 杂税)
            </p>
          </div>
        </div>

        {formulas.data && (
          <SpecPicker
            formulas={formulas.data}
            value={line.spec}
            onChange={(next) => onChange({ spec: next })}
            disabled={calc.isPending}
          />
        )}
        {formulas.isError && (
          <p className="text-xs text-destructive">规格加载失败，请刷新重试</p>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-3">
          <div className="flex flex-col gap-1">
            <Button
              type="button"
              size="sm"
              className="w-fit"
              disabled={!canSubmit || calc.isPending}
              onClick={compute}
            >
              {calc.isPending && (
                <Loader2 className="mr-2 size-3.5 animate-spin" />
              )}
              {calc.isPending ? "计算中…" : "计算本行"}
            </Button>
            {!canSubmit && !calc.isPending && (
              <p className="text-[11px] text-muted-foreground">
                请选完整规格，并填写件数与整单汇率
              </p>
            )}
          </div>

          {line.built && (
            <dl className="flex flex-wrap gap-x-6 gap-y-1 text-xs">
              <div>
                <dt className="text-muted-foreground">
                  单卷价（{shared.quoteCurrency}/卷）
                </dt>
                <dd className="tabular-nums">
                  {unitPriceFx === null ? "—" : unitPriceFx.toFixed(4)}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">单价（元/米）</dt>
                <dd className="tabular-nums">
                  {pricePerMeter === null ? "—" : pricePerMeter.toFixed(4)}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">
                  行小计（{shared.quoteCurrency}）
                </dt>
                <dd className="font-medium tabular-nums">
                  {lineAmount === null ? "—" : lineAmount.toFixed(2)}
                </dd>
              </div>
            </dl>
          )}
        </div>

        {line.error && (
          <p className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            {line.error}
          </p>
        )}

        {line.built && line.built.missing.length > 0 && (
          <div className="flex gap-2 rounded-lg border border-warning/40 bg-warning-muted px-3 py-2 text-xs text-warning-muted-foreground">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <p>
              单证要素缺失：{line.built.missing.join("、")}。
              缺项会在单证上留空白（**不会填 0** —— 报关表上印 0
              重量比空白更危险）， 请在单证工位补齐后再签发。
            </p>
          </div>
        )}

        {line.result && (line.result.meta.diagnostics?.length ?? 0) > 0 && (
          <ul className="space-y-1 text-xs text-muted-foreground">
            {line.result.meta.diagnostics.map((d, i) => (
              <li key={i}>· {d}</li>
            ))}
          </ul>
        )}

        {line.result && (
          <div className="space-y-2">
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className={cn(
                "flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground",
              )}
            >
              <ChevronDown
                className={cn(
                  "size-3.5 transition-transform",
                  expanded && "rotate-180",
                )}
              />
              {expanded ? "收起完整算价表" : "查看完整算价表"}
            </button>
            {expanded && <EngineQuoteResult result={line.result} view={view} />}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

