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
import { useEffect, useState, type ReactNode } from "react";
import { AlertTriangle, ChevronDown, Loader2, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ErrorState } from "@/components/shared/error-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { handleApiError } from "@/lib/api/error-handler";
import { normalizeApiError } from "@/lib/api/api-error";
import { useProductProfile } from "@/lib/products/use-products";
import { cn } from "@/lib/utils";
import type { ExportQuoteResponse } from "@contracts/export-quote";

import { useExportProducts } from "../hooks/use-export-quote-import";
import { useProductCostReference } from "../hooks/use-cost-reference";
import {
  useCalcQuote,
  useProductFormulas,
  type QuoteView,
} from "../hooks/use-export-quote-calc";
import { SpecPicker, isSpecComplete, type SpecRow } from "./spec-picker";
import { EngineQuoteResult } from "./engine-quote-result";
import {
  buildLineRequest,
  pieceDefault,
  pieceScale,
  scale6,
  type CostBasis,
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
  /**
   * 材质（产品资料 `info.material_options` 里的一项）；`''` = 不指定。
   * 用户 2026-10-24：材质只随行记录、**不参与算价**，故不进入算价请求。
   */
  material?: string;
  /**
   * 本行成本口径：`pretax`（税前价，默认）/ `incl_tax`（勾选「按含税价」）。
   * 下发到 `ExportQuoteRequest.cost_basis`，引擎据此决定是否按进项税点还原成本。
   */
  costBasis?: CostBasis;
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
    material: "",
    costBasis: "pretax",
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
  /** 产品税率（进项/退税按产品走），key = 产品 key */
  productTaxMap?: Record<
    string,
    { input_vat_rate?: number | null; rebate_rate?: number | null }
  >;
  onChange: (patch: Partial<LineDraft>) => void;
  onRemove: () => void;
  /** 整单报价信号：递增即触发本行计算（0/undefined = 不触发） */
  calcSignal?: number;
  /**
   * 排序把手（由调用方传入 `SortableGrip`）。
   *
   * 为什么用 ReactNode 而不是直接在本组件里写 `SortableGrip`：
   * 本卡片在单测和"报价详情只读视图"里也会被渲染，那些场景没有 `SortableList`
   * 提供上下文，直接写会把组件绑死在拖拽容器里。传进来则"有容器才有把手"。
   */
  grip?: ReactNode;
}

export function QuoteLineCard({
  index,
  line,
  shared,
  view,
  terms,
  lineCount,
  customerId = null,
  productTaxMap,
  onChange,
  onRemove,
  calcSignal = 0,
  grip,
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
  // 产品资料（租户可编辑）：材质**只是选项**，来自 `info.material_options`（产品资料里维护）。
  // 未加载 / 没有选项时返回空数组 → 界面不渲染材质下拉（不塞"暂无"占位）。
  const profile = useProductProfile(effectiveProduct || null);
  const materialOptions = (() => {
    const raw = profile.data?.info?.material_options;
    return Array.isArray(raw)
      ? raw.map((v) => String(v)).filter((v) => v !== "")
      : [];
  })();
  const [expanded, setExpanded] = useState(false);
  /** 表单折叠：算出一行后收起，列表变紧凑；点「编辑规格」再展开。 */
  const [formOpen, setFormOpen] = useState(true);

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

  // ── 成本（需求 11）：必须由报价人手动填写；历史报价只给参考、需点“应用” ──
  // 单位由产品定义给出：勾花网 `CNY/㎡`（按平米算），牛栏网 `CNY/kg`。
  const costField = formulas.data?.cost.field ?? "";
  const costUnitLabel = (formulas.data?.cost.unit ?? "").replace("CNY", "元");
  const typedCost = line.costOverride.trim();
  // 成本必须由报价人手动填写（或点「应用参考成本」带入历史报价参考值）；
  // 产品定义里的 raw_price 只是引擎变量，不再作为自动兜底。
  const costRef = useProductCostReference(effectiveProduct, line.spec);
  const referenceCost = costRef.data?.cost ?? null;
  const effectiveCost = typedCost !== "" ? Number(typedCost) || 0 : 0;
  /** 只有手填/点应用参考后才传成本覆盖 */
  const costOverrideToSend = typedCost !== "" ? Number(typedCost) || 0 : null;

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
  /** 包装方式的展示文本：**method 优先**（用户 2026-10-24：要看"具体什么包装"），
   *  method 为空的旧数据才退回档位名 name。 */
  const packagingLabel = (
    p: {
      name?: string | null;
      method?: string | null;
    } | null,
  ): string => (p ? p.method || p.name || "—" : "—");
  /** 本行成本口径（勾选「按含税价」= incl_tax）；缺省按税前处理。 */
  const inclTax = line.costBasis === "incl_tax";
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
  // 客户常按“米”报需求；报价数量按“卷”。1 卷多少米优先取数量区卷长，
  // 勾花网这类没有 piece_inputs 的产品取规格里的 len_m/roll_len_m。
  const rollLengthForMeters = (() => {
    if (unitQty > 0) return unitQty;
    const raw = Number(line.spec.roll_len_m ?? line.spec.len_m);
    return Number.isFinite(raw) && raw > 0 ? raw : null;
  })();
  const [metersDemand, setMetersDemand] = useState("");

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
    !!effectiveProduct &&
    specReady &&
    typedCost !== "" &&
    Number(shared.fxRate) > 0 &&
    total > 0;

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
    if (!line.costOverride.trim()) {
      onChange({
        error: "请先填写成本，或先点「应用参考成本」",
        result: null,
        built: null,
      });
      return;
    }
    onChange({ error: null });
    try {
      // 成本手改：以变体覆盖的方式传给引擎（只影响本行，不回写定价数据）
      const overrides = {
        ...variantOverrides,
      } as Record<string, Record<string, Record<string, number>>>;
      let costApplied = false;
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
          costApplied = true;
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
          costApplied = true;
          break;
        }
      }
      // 勾花网/鹿网这类“表面处理档位为空”的产品：没有可挂的变体选项，
      // 成本字段直接作为常量覆盖（否则 raw_price 不在引擎变量里，报价报错）。
      const constantsOverrides =
        !costApplied && costField
          ? {
              [costField]:
                typedCost !== "" ? Number(typedCost) || 0 : costOverrideToSend,
            }
          : undefined;
      const payload = buildLineRequest({
        productKey: effectiveProduct,
        spec: line.spec,
        variantOverrides: overrides,
        constantsOverrides,
        total,
        unit: unitQtyInput?.unit || "m",
        profitPctOverride: line.profitPctOverride,
        packagingId: effectivePackaging?.id ?? "",
        // 成本口径显式下发（勾选「按含税价」→ incl_tax），见 build-request 文件头
        costBasis: line.costBasis ?? "pretax",
        terms: terms ?? null,
        productTax: productTaxMap?.[effectiveProduct] ?? null,
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
              // 快照按 method 留档（"包装1"这种档位名对复盘没有信息量）
              method: effectivePackaging.method,
              fee_per_piece: packagingFee,
            }
          : null,
        // 材质不算价，只随行落进 spec_snapshot（空值不写，见 buildLineItem）
        material: line.material ?? "",
      });
      onChange({
        result,
        built,
        error: null,
        spaceDeduction: formulas.data.space_deduction,
      });
      setFormOpen(false);
    } catch (err) {
      const message =
        err instanceof Error && "response" in err
          ? handleApiError(err as Parameters<typeof handleApiError>[0])
          : err instanceof Error
            ? err.message
            : "算价失败";
      onChange({ result: null, built: null, error: message });
      setFormOpen(true);
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
            {grip}
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
                  // 材质选项是**按产品**给的，换产品必须清空，否则会留上一款的材质
                  material: "",
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
        {!formOpen && line.built && (
          /*
           * 折叠摘要（用户 2026-10-24）：「产品基本信息放在上边，件数金额放下面，
           * 每种不同的类型要换行展示」—— 所以拆成三行（产品信息 / 件数 / 金额），
           * 不再把所有项平铺进一个 flex-wrap 里（那样三类的先后完全看屏宽）。
           */
          <div
            data-testid="line-summary"
            className="space-y-1 rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-xs"
          >
            <div
              data-testid="line-summary-product"
              className="flex flex-wrap items-center gap-x-4 gap-y-1"
            >
              <span className="w-14 shrink-0 text-muted-foreground">
                产品信息
              </span>
              <span>
                规格{" "}
                {Object.values(line.spec).filter(Boolean).join(" × ") || "—"}
              </span>
              {line.material ? <span>材质 {line.material}</span> : null}
              <span>包装 {packagingLabel(effectivePackaging)}</span>
            </div>
            <div
              data-testid="line-summary-qty"
              className="flex flex-wrap items-center gap-x-4 gap-y-1"
            >
              <span className="w-14 shrink-0 text-muted-foreground">件数</span>
              <span>{line.pieces || "—"} 卷</span>
              <span>
                总数 {Number.isFinite(total) ? total : 0}{" "}
                {unitQtyInput?.unit || "m"}
              </span>
            </div>
            <div
              data-testid="line-summary-amount"
              className="flex flex-wrap items-center gap-x-4 gap-y-1"
            >
              <span className="w-14 shrink-0 text-muted-foreground">金额</span>
              <span>
                成本 {typedCost || referenceCost || "—"}
                {costUnitLabel ? ` ${costUnitLabel}` : ""}（
                {inclTax ? "含税价" : "税前价"}）
              </span>
              <span>
                单卷价 {unitPriceFx === null ? "—" : unitPriceFx.toFixed(4)}
              </span>
              <span>
                行小计{" "}
                <b className="font-medium">
                  {lineAmount === null ? "—" : lineAmount.toFixed(2)}
                </b>
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="ml-auto h-7 px-2 text-xs"
                onClick={() => setFormOpen(true)}
              >
                编辑规格
              </Button>
            </div>
          </div>
        )}

        <div className={cn("space-y-4", !formOpen && "hidden")}>
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
          {/*
           * 三段布局（用户 2026-10-24）：「产品基本信息放在上边，件数金额放下面，
           * 每种不同的类型要换行展示」。
           * 原来所有参数混在一个 grid 里，屏宽一变先后顺序就乱；现在**每类各成一段**
           * （<section aria-label>），段内再用 grid，DOM 顺序固定为
           * 产品信息（规格/按件参数/材质/包装）→ 件数（件数/客户需求/总数）→ 金额（成本/利润率/价格）。
           */}
          <section aria-label="产品信息" className="space-y-3">
            <p className="text-[11px] font-medium text-muted-foreground">
              产品信息
            </p>
            {formulas.data && (
              <SpecPicker
                formulas={formulas.data}
                value={line.spec}
                onChange={(next) => onChange({ spec: next })}
                disabled={calc.isPending}
              />
            )}
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

              {/* 材质：产品资料 `info.material_options` 里的选项（产品管理里维护）。
                材质只是随行记录，**不参与算价** —— 所以不做必填、也没有默认值。 */}
              {materialOptions.length > 0 && (
                <div className="space-y-1.5">
                  <Label
                    className="text-xs"
                    htmlFor={`line-${line.id}-material`}
                  >
                    材质
                  </Label>
                  <select
                    id={`line-${line.id}-material`}
                    value={line.material ?? ""}
                    onChange={(e) => onChange({ material: e.target.value })}
                    className="h-8 w-full rounded-lg border border-input bg-background px-3 py-1.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <option value="">（不指定）</option>
                    {materialOptions.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                  <p className="text-[11px] text-muted-foreground">
                    产品资料里的材质选项，只随行记录、不参与算价
                  </p>
                </div>
              )}

              <div className="space-y-1.5">
                <Label
                  className="text-xs"
                  htmlFor={`line-${line.id}-packaging`}
                >
                  包装方式
                </Label>
                <select
                  id={`line-${line.id}-packaging`}
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
                      {/* 用户 2026-10-24：展示具体包装方式（method），
                        不再只给「包装1」这种档位名；method 缺失才退回 name */}
                      {packagingLabel(p)}
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
            </div>
          </section>

          <section aria-label="件数" className="space-y-3">
            <p className="text-[11px] font-medium text-muted-foreground">
              件数
            </p>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
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
                {rollLengthForMeters ? (
                  <p className="text-[11px] text-muted-foreground">
                    1 卷 = {rollLengthForMeters}{" "}
                    米；也可直接填客户需求米数，系统自动进一换卷
                  </p>
                ) : null}
              </div>

              {rollLengthForMeters ? (
                <div className="space-y-1.5">
                  <Label className="text-xs">客户需求（米，可选）</Label>
                  <Input
                    type="number"
                    min={0}
                    value={metersDemand}
                    onChange={(e) => {
                      const v = e.target.value;
                      setMetersDemand(v);
                      const meters = Number(v);
                      if (Number.isFinite(meters) && meters > 0) {
                        onChange({
                          pieces: String(
                            Math.ceil(meters / rollLengthForMeters),
                          ),
                        });
                      }
                    }}
                    placeholder={`按 ${rollLengthForMeters} 米/卷自动换算`}
                    className="h-8 text-xs"
                  />
                  <p className="text-[11px] text-muted-foreground">
                    卷数 = 总米数 ÷ {rollLengthForMeters}，小数进一
                  </p>
                </div>
              ) : null}

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
            </div>
          </section>

          <section aria-label="金额" className="space-y-3">
            <p className="text-[11px] font-medium text-muted-foreground">
              金额
            </p>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <div className="space-y-1.5">
                {/* 成本口径（用户 2026-10-24）：勾选「按含税价」= 填的是含税价，
                  引擎按进项税点还原；不勾 = 税前价。标签跟着口径走，避免同名不同义 */}
                <Label className="text-xs" htmlFor={`line-${line.id}-cost`}>
                  {inclTax ? "含税成本" : "税前成本"}
                  {costUnitLabel ? `（${costUnitLabel}）` : ""}
                </Label>
                <Input
                  id={`line-${line.id}-cost`}
                  type="number"
                  step="any"
                  value={line.costOverride}
                  onChange={(e) => onChange({ costOverride: e.target.value })}
                  placeholder="请填写成本"
                  className="h-8 text-xs"
                />
                <label className="flex w-fit items-center gap-1.5 text-[11px] text-muted-foreground">
                  <input
                    type="checkbox"
                    className="size-3.5 accent-foreground"
                    checked={inclTax}
                    onChange={(e) =>
                      onChange({
                        costBasis: e.target.checked ? "incl_tax" : "pretax",
                      })
                    }
                  />
                  按含税价（由系统按进项税点还原税前成本）
                </label>
                <div className="text-[11px] text-muted-foreground">
                  {typedCost !== "" ? (
                    "本单手填，只影响本单"
                  ) : referenceCost !== null ? (
                    <div className="flex flex-wrap items-center gap-1">
                      <span>
                        参考历史成本 ¥{referenceCost}
                        {costUnitLabel
                          ? `/${costUnitLabel.replace("元/", "")}`
                          : ""}
                        （
                        {costRef.data?.source === "latest"
                          ? "同规格最近一次"
                          : "近 30 天中位数"}
                        ）
                      </span>
                      <button
                        type="button"
                        className="underline"
                        onClick={() =>
                          onChange({ costOverride: String(referenceCost) })
                        }
                      >
                        应用参考成本
                      </button>
                    </div>
                  ) : (
                    "请手动填写成本（不会自动使用产品定义里的成本）"
                  )}
                </div>
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

            {/* 价格落点（金额段）：算完才出现；算价/校验逻辑未变，只是位置下移 */}
            {line.built && (
              <dl className="flex flex-wrap gap-x-6 gap-y-1 border-t pt-3 text-xs">
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
          </section>

          {formulas.isError && (
            <ErrorState
              title="规格加载失败"
              message={normalizeApiError(formulas.error).message}
              onRetry={() => void formulas.refetch()}
              className="py-4"
            />
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
        </div>

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
