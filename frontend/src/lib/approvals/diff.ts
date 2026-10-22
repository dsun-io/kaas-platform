/**
 * 新旧明细对比（纯函数）——审批详情抽屉的核心：**批准的是"这份新明细"**，
 * 所以必须让审批人一眼看出改了哪几行、哪几个字段，而不是给两份表格自己比对。
 *
 * 匹配口径：按 `sku_id + 品名` 分组后按出现顺序一一配对（同一货物可能重复出现）。
 *  - 新明细里的行优先（批准后生效的是它的顺序）；
 *  - 未配对的旧行 = 删除，追加在末尾；
 *  - 未配对的新行 = 新增。
 *
 * 数量/单价/金额用 1e-6 容差比较（JSON 数字浮点往返不保证字符串完全相等）。
 */
import { formatMoney } from "./format";
import type { ChangeLine } from "./types";

export type LineChangeKind = "same" | "changed" | "added" | "removed";

export interface ChangeLineDiff {
  /** React key（货物键 + 出现序号） */
  key: string;
  kind: LineChangeKind;
  before: ChangeLine | null;
  after: ChangeLine | null;
  /** 变化的字段中文名（"数量""单价"…），空 = 完全一致 */
  changedFields: string[];
}

interface FieldDef {
  field: keyof ChangeLine;
  label: string;
}

const FIELDS: readonly FieldDef[] = [
  { field: "product_name", label: "品名" },
  { field: "qty", label: "数量" },
  { field: "qty_unit", label: "单位" },
  { field: "unit_price", label: "单价" },
  { field: "currency", label: "币种" },
  { field: "line_amount", label: "金额" },
  { field: "spec_snapshot", label: "规格" },
];

function textOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function lineKey(line: ChangeLine): string {
  // 有 SKU 时按 SKU 配对（改品名也算「修改」而不是「删+增」）；无 SKU 退回品名。
  // 同一货物重复出现时靠出现序号区分（见 nextKey）。
  const sku = asNumber(line.sku_id);
  if (sku !== null) return `sku:${sku}`;
  return `name:${textOf(line.product_name)}`;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function sameNumber(a: unknown, b: unknown): boolean {
  const left = asNumber(a);
  const right = asNumber(b);
  if (left === null || right === null) return left === right;
  return Math.abs(left - right) < 1e-6;
}

function sameField(
  field: keyof ChangeLine,
  a: ChangeLine,
  b: ChangeLine,
): boolean {
  if (field === "qty" || field === "unit_price" || field === "line_amount") {
    return sameNumber(a[field], b[field]);
  }
  if (field === "spec_snapshot") {
    return (
      JSON.stringify(a.spec_snapshot ?? null) ===
      JSON.stringify(b.spec_snapshot ?? null)
    );
  }
  return textOf(a[field]) === textOf(b[field]);
}

function changedFields(before: ChangeLine, after: ChangeLine): string[] {
  return FIELDS.filter(({ field }) => !sameField(field, before, after)).map(
    ({ label }) => label,
  );
}

/** 新旧明细 → 逐行对比（新明细顺序 + 末尾删除行）。 */
export function diffChangeLines(
  beforeLines: readonly ChangeLine[] | null | undefined,
  afterLines: readonly ChangeLine[] | null | undefined,
): ChangeLineDiff[] {
  const before = Array.isArray(beforeLines) ? beforeLines : [];
  const after = Array.isArray(afterLines) ? afterLines : [];
  const usedBefore = new Array<boolean>(before.length).fill(false);

  // 货物键 → 旧明细中的行下标（按出现顺序）
  const beforeIndexes = new Map<string, number[]>();
  before.forEach((line, index) => {
    const key = lineKey(line);
    const list = beforeIndexes.get(key);
    if (list) list.push(index);
    else beforeIndexes.set(key, [index]);
  });

  const occurrences = new Map<string, number>();
  const nextKey = (key: string): string => {
    const count = (occurrences.get(key) ?? 0) + 1;
    occurrences.set(key, count);
    return `${key}#${count}`;
  };

  const diffs: ChangeLineDiff[] = [];

  for (const line of after) {
    const key = lineKey(line);
    const reactKey = nextKey(key);
    const candidates = beforeIndexes.get(key) ?? [];
    const matchIndex = candidates.find((index) => !usedBefore[index]);
    if (matchIndex === undefined) {
      diffs.push({
        key: reactKey,
        kind: "added",
        before: null,
        after: line,
        changedFields: [],
      });
      continue;
    }
    usedBefore[matchIndex] = true;
    const old = before[matchIndex];
    if (!old) continue;
    const fields = changedFields(old, line);
    diffs.push({
      key: reactKey,
      kind: fields.length > 0 ? "changed" : "same",
      before: old,
      after: line,
      changedFields: fields,
    });
  }

  // 旧明细里没被配对的 = 删除（保持原顺序）
  before.forEach((line, index) => {
    if (usedBefore[index]) return;
    diffs.push({
      key: nextKey(`removed:${lineKey(line)}`),
      kind: "removed",
      before: line,
      after: null,
      changedFields: [],
    });
  });

  return diffs;
}

export interface ChangeDiffSummary {
  changed: number;
  added: number;
  removed: number;
  same: number;
}

export function summarizeChangeDiffs(
  diffs: readonly ChangeLineDiff[],
): ChangeDiffSummary {
  const summary: ChangeDiffSummary = {
    changed: 0,
    added: 0,
    removed: 0,
    same: 0,
  };
  for (const diff of diffs) summary[diff.kind] += 1;
  return summary;
}

/** 行金额合计；没有任何合法 line_amount → null（区别于"合计为 0"）。 */
export function sumLineAmounts(
  lines: readonly ChangeLine[] | null | undefined,
): number | null {
  if (!Array.isArray(lines) || lines.length === 0) return null;
  let sum = 0;
  let seen = false;
  for (const line of lines) {
    const amount = asNumber(line.line_amount);
    if (amount === null) continue;
    sum += amount;
    seen = true;
  }
  if (!seen) return null;
  return Math.round(sum * 100) / 100;
}

function firstCurrency(
  lines: readonly ChangeLine[] | null | undefined,
): string | null {
  if (!Array.isArray(lines)) return null;
  for (const line of lines) {
    const currency = textOf(line.currency);
    if (currency) return currency;
  }
  return null;
}

/**
 * 列表「金额变化」列：批准前 → 批准后的行金额合计差。
 * - 两侧都没有金额（历史脏数据）→ "—"；
 * - 差值为 0 → "金额不变"（明确文案，避免显示 "+0.00" 让人误以为有改动）；
 * - 其它 → 带币种的 "+USD 1,234.00" / "-USD 1,234.00"。
 */
export function describeAmountChange(
  beforeLines: readonly ChangeLine[] | null | undefined,
  afterLines: readonly ChangeLine[] | null | undefined,
  fallbackCurrency?: string | null,
): string {
  const beforeSum = sumLineAmounts(beforeLines);
  const afterSum = sumLineAmounts(afterLines);
  if (beforeSum === null && afterSum === null) return "—";
  const before = beforeSum ?? 0;
  const after = afterSum ?? 0;

  const delta = Math.round((after - before) * 100) / 100;
  if (Math.abs(delta) < 0.005) return "金额不变";

  const currency =
    firstCurrency(afterLines) ??
    firstCurrency(beforeLines) ??
    textOf(fallbackCurrency);
  const formatted = Math.abs(delta).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const sign = delta > 0 ? "+" : "-";
  return currency ? `${sign}${currency} ${formatted}` : `${sign}${formatted}`;
}

/** 详情里"新金额"展示（批准响应的 new_total_amount 或新明细合计兜底）。 */
export function resolvedNewTotal(
  afterLines: readonly ChangeLine[] | null | undefined,
  newTotal: number | null | undefined,
  currency?: string | null,
): string {
  const amount =
    typeof newTotal === "number" && Number.isFinite(newTotal)
      ? newTotal
      : sumLineAmounts(afterLines);
  return formatMoney(amount, currency ?? firstCurrency(afterLines));
}
