"use client";

/**
 * 规格选择器：**由产品的规格空间定义驱动**，不在前端写死任何属性名与取值。
 *
 * 为什么不写死：属性名与取值是工厂口径，属于产品的数据而不是界面。
 * 写死在界面上的后果已经发生过 —— 旧表单用了一套「扁平字段」
 * （产品类型/丝径/高度/网孔宽度/网孔规格/卷长），与工厂口径并不对应：
 * 缺了决定成本的两个轴（镀锌量、工艺），多了一个数据全空的字段，
 * 还把「卷长」做成了手选项（它本该由丝径方案联动确定，手选能拼出工厂不做的组合）。
 *
 * 现在的做法：属性 = 引擎给出的「轴 + 变体」，取值 = 引擎给出的候选项，
 * 用户在界面上选完，直接组成一行规格行提交。
 */
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import type {
  NumericInput,
  ProductFormulasResponse,
} from "@contracts/export-quote";

/** 一行规格行：键是规格名（如 height_m / wire），值是候选取值。 */
export type SpecRow = Record<string, unknown>;

/** 候选取值可能是数字或字符串，统一成可显示文本。 */
export function optionText(value: unknown): string {
  return typeof value === "string" ? value : String(value);
}

/**
 * 候选项的**显示文本**。
 *
 * 优先用后端给的 label（如丝径 2.0）—— 数值到浏览器里会把尾零抹掉
 * （2.0 → "2"），而业务要看到的是产品定义里写的那个写法。
 * 没给 label 时退回 value 的文本形式。
 */
function optionLabel(option: Option): string {
  return option.label ?? optionText(option.value);
}

/** 取一个规格组（轴或变体）的当前选中值。 */
function current(spec: SpecRow, name: string): string {
  const v = spec[name];
  return v === undefined || v === null ? "" : String(v);
}

/** 规格候选项：`value` 在契约里是可选的（空候选），因此这里也按可选处理。 */
type Option = {
  value?: unknown;
  label?: string;
  label_en?: string;
  attributes?: Record<string, unknown>;
};

/** 找出与显示文本对应的原始取值（保证提交时类型与引擎一致：数字仍是数字）。 */
function matchValue(options: readonly Option[], text: string): unknown {
  return options.find((o) => optionText(o.value) === text)?.value;
}

interface Props {
  formulas: ProductFormulasResponse;
  value: SpecRow;
  onChange: (next: SpecRow) => void;
  disabled?: boolean;
}

/**
 * 自由数值参数的界面值 ↔ 引擎值换算。
 *
 * 引擎公式用的是**内部单位**（卷径 0.30m），而业务按界面单位填（30 公分）。
 * `ui_scale` 是两者之间的唯一桥梁：界面只负责乘除，不拥有业务单位知识。
 */
function numericToUi(ni: NumericInput, engineValue: unknown): string {
  if (engineValue === undefined || engineValue === null || engineValue === "") {
    return "";
  }
  const n = Number(engineValue);
  if (!Number.isFinite(n)) return String(engineValue);
  const scaled = n * (ni.ui_scale || 1);
  return String(Number(scaled.toFixed(6)));
}

function numericFromUi(ni: NumericInput, text: string): unknown {
  if (text.trim() === "") return undefined;
  const n = Number(text);
  if (!Number.isFinite(n)) return text;
  const scale = ni.ui_scale || 1;
  return scale === 1 ? n : n / scale;
}

export function SpecPicker({ formulas, value, onChange, disabled }: Props) {
  const { axes, variants, formula } = formulas.space;
  const numericInputs = formulas.numeric_inputs ?? [];

  const set = (name: string, options: readonly Option[], text: string) => {
    const next: SpecRow = { ...value, [name]: matchValue(options, text) };
    onChange(next);
  };

  return (
    <div className="space-y-3">
      {/* 规格维度（哪些轴参与组合）—— 组合总数由外层参数卡说明，此处不重复 */}
      {formula && (
        <p className="text-[11px] text-muted-foreground">规格维度：{formula}</p>
      )}

      <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-5">
        {[...axes, ...variants].map((group) => {
          const isVariant = group.kind === "variant";
          const selected = current(value, group.name);
          return (
            <div key={group.name} className="space-y-1.5">
              <div className="flex items-center gap-1.5">
                <Label className="text-xs">{group.label}</Label>
                {isVariant && (
                  <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">
                    联动
                  </span>
                )}
              </div>
              <select
                value={selected}
                disabled={disabled}
                onChange={(e) => set(group.name, group.options, e.target.value)}
                className={cn(
                  "h-8 w-full rounded-lg border border-input bg-background px-3 py-1.5 text-xs",
                  "ring-offset-background focus-visible:outline-none focus-visible:ring-2",
                  "focus-visible:ring-ring focus-visible:ring-offset-2",
                  disabled && "cursor-not-allowed opacity-60",
                )}
              >
                <option value="">请选择</option>
                {group.options.map((o) => {
                  const text = optionText(o.value);
                  return (
                    <option key={text} value={text}>
                      {optionLabel(o)}
                      {o.label_en ? ` · ${o.label_en}` : ""}
                    </option>
                  );
                })}
              </select>
            </div>
          );
        })}

        {/*
          自由数值参数：**输入框而不是下拉**。
          丝径/网高/间距这类量在业务上是连续值（客户给 2.3mm 就是 2.3mm），
          枚举只能覆盖事先想到的取值，选不到就逼着人把值写进备注、公式反而算不出来。
          这里只按 min/max 提示范围，不拦合法取值。
        */}
        {numericInputs.map((ni) => {
          const uiUnit = ni.ui_unit || ni.unit;
          const hint = [
            uiUnit ? `单位 ${uiUnit}` : "",
            ni.min_value !== null && ni.max_value !== null
              ? `${ni.min_value} ~ ${ni.max_value}`
              : "",
          ]
            .filter(Boolean)
            .join(" · ");
          return (
            <div key={ni.key} className="space-y-1.5">
              <div className="flex items-center gap-1.5">
                <Label className="text-xs">{ni.label}</Label>
                <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">
                  自由值
                </span>
              </div>
              <input
                type="number"
                inputMode="decimal"
                step="any"
                value={numericToUi(ni, value[ni.key] ?? ni.default ?? "")}
                disabled={disabled}
                min={ni.min_value ?? undefined}
                max={ni.max_value ?? undefined}
                onChange={(e) =>
                  onChange({
                    ...value,
                    [ni.key]: numericFromUi(ni, e.target.value),
                  })
                }
                className={cn(
                  "h-8 w-full rounded-lg border border-input bg-background px-3 py-1.5 text-xs",
                  "ring-offset-background focus-visible:outline-none focus-visible:ring-2",
                  "focus-visible:ring-ring focus-visible:ring-offset-2",
                  disabled && "cursor-not-allowed opacity-60",
                )}
              />
              {hint && (
                <p className="text-[10px] text-muted-foreground">{hint}</p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** 所有规格组是否都已选择。 */
export function isSpecComplete(
  formulas: ProductFormulasResponse,
  value: SpecRow,
): boolean {
  const groups = [...formulas.space.axes, ...formulas.space.variants];
  if (!groups.every((g) => current(value, g.name) !== "")) return false;
  // 自由数值参数**通常不是必填**（产品给了默认值，留空即用默认）；
  // 只有没给默认值的才必须填 —— 否则引擎取不到值、算出来是空。
  return (formulas.numeric_inputs ?? []).every(
    (ni) => ni.default !== null || current(value, ni.key) !== "",
  );
}

/** 默认选中每个规格组的第一项 —— 让页面打开即可算价，不用逐项点。 */
export function defaultSpecRow(formulas: ProductFormulasResponse): SpecRow {
  const row: SpecRow = {};
  for (const g of [...formulas.space.axes, ...formulas.space.variants]) {
    const first = g.options[0];
    if (first) row[g.name] = first.value;
  }
  // 自由数值参数带默认值 → 页面打开即可算价，不用逐项点
  for (const ni of formulas.numeric_inputs ?? []) {
    if (ni.default !== null) row[ni.key] = ni.default;
  }
  return row;
}
