"use client";

/**
 * 报价参数 · 税与让利区（从 product-quote-view 拆出，巨石拆分第三刀）。
 *
 * 同口径：**只搬 JSX**，6 个输入 state 与 setter 全在父组件（本区纯输入、
 * 无联动逻辑，props 就是 6 对值/回调）。
 *
 * 业务口径（逐字保留）：
 * - 严格按价链顺序：进项税 → 退税让利 → 印花税 → 销项税；
 * - 留空的项自动取税务档案里的法定值，填了则本单覆盖；
 * - 销项税率**不**按出口/内销自动推导（政策会变，写死的规则三年后就是错的）。
 */
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SectionTitle } from "./product-quote-view-section";

export interface TaxGivebackSectionProps {
  inputVatRatePct: string;
  onInputVatRatePctChange: (v: string) => void;
  rebateRatePct: string;
  onRebateRatePctChange: (v: string) => void;
  giveRatioPct: string;
  onGiveRatioPctChange: (v: string) => void;
  stampRatePct: string;
  onStampRatePctChange: (v: string) => void;
  stampBase: "" | "profit" | "cost" | "base_quote";
  onStampBaseChange: (v: "" | "profit" | "cost" | "base_quote") => void;
  outputVatRatePct: string;
  onOutputVatRatePctChange: (v: string) => void;
}

const SELECT_CLASS =
  "h-8 w-full rounded-lg border border-input bg-background px-3 py-1.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function TaxGivebackSection({
  inputVatRatePct,
  onInputVatRatePctChange,
  rebateRatePct,
  onRebateRatePctChange,
  giveRatioPct,
  onGiveRatioPctChange,
  stampRatePct,
  onStampRatePctChange,
  stampBase,
  onStampBaseChange,
  outputVatRatePct,
  onOutputVatRatePctChange,
}: TaxGivebackSectionProps) {
  return (
    <>
      {/* ④ 税与让利 —— 严格按价链顺序：进项税 → 退税让利 → 印花税 → 销项税 */}
      <SectionTitle
        index={4}
        title="税与让利"
        hint="留空的项自动取税务档案里的法定值；填了则本单覆盖"
      />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <div className="space-y-1.5">
          <Label
            className="text-xs"
            title="供应商开票的税点（如 10%）。决定含税采购价 = 税前成本 ÷ (1 − 票税点)，以及可退进项税额 = 进项税额 × 退税率 ÷ 票税点"
          >
            进项票税点（%）
          </Label>
          <Input
            type="number"
            step="0.1"
            placeholder="供应商开票收的点，如 10"
            value={inputVatRatePct}
            onChange={(e) => onInputVatRatePctChange(e.target.value)}
            className="h-8 text-xs"
          />
          <p className="text-[11px] text-muted-foreground">
            决定含税采购价与可退税额
          </p>
        </div>

        <div className="space-y-1.5">
          <Label
            className="text-xs"
            title="按 HS 编码确定的出口退税率。可退进项增值税税额 = 进项税额 × (退税率 ÷ 票税点)，上限为已缴进项税额"
          >
            出口退税率（%）
          </Label>
          <Input
            type="number"
            step="0.1"
            placeholder="按 HS 编码核实，如 13"
            value={rebateRatePct}
            onChange={(e) => onRebateRatePctChange(e.target.value)}
            className="h-8 text-xs"
          />
          <p className="text-[11px] text-muted-foreground">
            {rebateRatePct === ""
              ? "⚠ 未填：按进项税额全额可退估算，报价可能偏低"
              : `可退比例 = ${rebateRatePct}% ÷ 进项票税点`}
          </p>
        </div>

        <div className="space-y-1.5">
          <Label
            className="text-xs"
            title="让出可退进项增值税额的比例（100% = 全部让利换竞争力，0% = 自留对冲风险）。让利额 = 可退进项税额 × 让利比例"
          >
            让利比例（%）
          </Label>
          <Input
            type="number"
            step="1"
            placeholder="退回的税让给客户多少，如 80"
            value={giveRatioPct}
            onChange={(e) => onGiveRatioPctChange(e.target.value)}
            className="h-8 text-xs"
          />
          <p className="text-[11px] text-muted-foreground">
            让出可退税额的比例，自留部分作风险对冲
          </p>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">印花税率（%）</Label>
          <Input
            type="number"
            step="0.01"
            placeholder="留空用档案法定值（现为 5）"
            value={stampRatePct}
            onChange={(e) => onStampRatePctChange(e.target.value)}
            className="h-8 text-xs"
          />
          <p className="text-[11px] text-muted-foreground">
            留空即取税务档案的法定值
          </p>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">印花税计税基数</Label>
          <select
            value={stampBase}
            onChange={(e) =>
              onStampBaseChange(
                e.target.value as "" | "profit" | "cost" | "base_quote",
              )
            }
            className={SELECT_CLASS}
          >
            <option value="">跟随档案（现为加工利润）</option>
            <option value="profit">加工利润</option>
            <option value="cost">税前成本</option>
            <option value="base_quote">基础报价</option>
          </select>
          <p className="text-[11px] text-muted-foreground">
            印花税 = 计税基数 × 印花税率
          </p>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">销项税率（%）</Label>
          <Input
            type="number"
            step="0.1"
            placeholder="出口填 0、内销填 13"
            value={outputVatRatePct}
            onChange={(e) => onOutputVatRatePctChange(e.target.value)}
            className="h-8 text-xs"
          />
          <p className="text-[11px] text-muted-foreground">
            按业务实际填，不按出口/内销自动推导
          </p>
        </div>
      </div>
    </>
  );
}
