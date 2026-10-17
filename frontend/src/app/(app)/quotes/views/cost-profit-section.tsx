"use client";

/**
 * 报价参数 · 成本与利润区（从 product-quote-view 拆出，巨石拆分第二刀）。
 *
 * 与第一刀同口径：**只搬 JSX，state 与换算逻辑留在父组件**（利润金额/利润率
 * 互为换算的 handler 是一对联动，拆开会把「改金额反算利润率」的时序弄丢）。
 *
 * 业务口径（逐字保留）：
 * - 税前成本**只读**（要改成本去「定价数据」按定价键改，不在这里写死）；
 * - 加工利润（元/kg）与利润率（%）是一对互为换算，必须相邻同排。
 */
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SectionTitle } from "./product-quote-view-section";

export interface CostProfitSectionProps {
  /** 成本字段提示（定价键），显示在 Section hint 里 */
  costFieldKey: string;
  /** 税前成本（只读，来自定价数据；0 = 未配置） */
  costPretax: number;
  profitFixed: string;
  onProfitFixedChange: (v: string) => void;
  profitPct: string;
  onProfitPctChange: (v: string) => void;
}

export function CostProfitSection({
  costFieldKey,
  costPretax,
  profitFixed,
  onProfitFixedChange,
  profitPct,
  onProfitPctChange,
}: CostProfitSectionProps) {
  return (
    <>
      {/* ③ 成本与利润 —— 价链的第一段；成本来自定价数据，随规格变 */}
      <SectionTitle
        index={3}
        title="成本与利润"
        hint={`税前成本取自定价数据${costFieldKey ? `（${costFieldKey}）` : ""}，随规格自动带入`}
      />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <div className="space-y-1.5">
          <Label className="text-xs">税前成本（元/kg）</Label>
          {/* 只读：要改成本请去「定价数据」按定价键改，而不是在这里写死 */}
          <Input
            type="number"
            value={costPretax || ""}
            readOnly
            className="h-8 text-xs bg-muted"
          />
          <p className="text-[11px] text-muted-foreground">随规格自动带入</p>
        </div>

        {/* 金额与利润率是一对，互为换算，必须相邻同排 */}
        <div className="space-y-1.5">
          <Label
            className="text-xs"
            title="每公斤的加工所得，全单只计一次。利润率模式下 = 税前成本 × 利润率"
          >
            加工利润（元/kg）
          </Label>
          <Input
            type="number"
            step="0.01"
            placeholder="如 0.1"
            value={profitFixed}
            onChange={(e) => onProfitFixedChange(e.target.value)}
            className="h-8 text-xs"
          />
          <p className="text-[11px] text-muted-foreground">
            每公斤的加工所得，全单只计一次
          </p>
        </div>

        <div className="space-y-1.5">
          <Label
            className="text-xs"
            title="按税前成本计：利润率 = 加工利润 ÷ 税前成本。margin_on_price 模式下售价 = 成本 ÷ (1 − 利润率 − 综合税费系数)"
          >
            利润率（%）
          </Label>
          <Input
            type="number"
            step="0.1"
            placeholder="如 2.2727"
            value={profitPct}
            onChange={(e) => onProfitPctChange(e.target.value)}
            className="h-8 text-xs"
          />
          <p className="text-[11px] text-muted-foreground">
            按税前成本计：利润率 = 加工利润 ÷ 税前成本
          </p>
        </div>
      </div>
    </>
  );
}
