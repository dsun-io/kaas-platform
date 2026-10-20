/**
 * 行项批量编辑的纯函数层（A5-W2）
 *
 * 为什么先做纯函数
 * ----------------
 * 批量编辑的**校验/预览/变更判定**与"往哪写"无关，全部可离线测死；持久化通道
 * 另说（见 `docs/TRADE_DOC_EDIT_PLAN.md` §W2 与后端 `PROTECTED_CUSTOM_FIELDS`）。
 *
 * 三条铁律（与 A7 同口径）
 * ----------------------
 * 1. **金额不可直接编辑**：本模块只改输入项（规格/数量/单位/单价/原产国），
 *    行金额 `line_amount` 一律由 `qty × unit_price` 重算（ROUND_HALF_UP、4 位，
 *    与内核 `rules.AMOUNT_DECIMALS` / `rules.line_amount` 完全一致）。
 * 2. **校验与内核同口径**：数量必须 > 0、单价不能为负（`rules.validate_items`）；
 *    非法值在这里就拦下，不等到后端 422。
 * 3. **只改选中行**：未选中的行原样（引用与值都不动），改后金额影响用 A5-W3 的
 *    `summarizeAmounts` 现算（同一套公式源，不重写）。
 */
import { summarizeAmounts } from "./amount-summary";

/** 批量可改的字段（金额字段不在此列：line_amount 由 qty×price 推导） */
export const BATCH_FIELDS = [
  { value: "specification", label: "规格", kind: "text" },
  { value: "qty", label: "数量", kind: "number" },
  { value: "qty_unit", label: "单位", kind: "text" },
  { value: "unit_price", label: "单价", kind: "text-number" },
  { value: "country_of_origin", label: "原产国", kind: "text" },
] as const;

export type BatchField = (typeof BATCH_FIELDS)[number]["value"];

/** 不允许直接编辑的金额字段（只读，由 qty×price 推导） */
export const READONLY_AMOUNT_FIELDS = ["line_amount", "amount"] as const;

/** 与内核 `rules.AMOUNT_DECIMALS` 一致：行金额 4 位小数 */
export const AMOUNT_DECIMALS = 4;

export interface ItemRow {
  product_name?: unknown;
  qty?: unknown;
  qty_unit?: unknown;
  unit_price?: unknown;
  line_amount?: unknown;
  specification?: unknown;
  country_of_origin?: unknown;
  [key: string]: unknown;
}

/**
 * Decimal.quantize(ROUND_HALF_UP) 的等价实现。
 *
 * 不能直接用 `Math.round(x*10^d)/10^d`：`Math.round` 对负数与二进制浮点尾差的
 * 行为与 ROUND_HALF_UP 不完全一致（如 1.005）。这里用「放大 → 加 0.5 → 向下取整」
 * 并用字符串指数修正浮点误差，确保与内核逐分一致。
 */
export function roundHalfUp(value: number, digits = AMOUNT_DECIMALS): number {
  if (!Number.isFinite(value)) return NaN;
  // `Number("1.005e2")` = 100.49999999999999 → 直接用十进制字面量缩放，避免二进制尾差
  const scaled = Number(`${value}e${digits}`);
  const rounded = Math.sign(scaled) * Math.floor(Math.abs(scaled) + 0.5);
  return Number(`${rounded}e-${digits}`);
}

function numeric(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

/** 行金额 = qty × unit_price（4 位、ROUND_HALF_UP）；缺值时返回 null（不编造 0） */
export function lineAmountOf(
  qty: unknown,
  unitPrice: unknown,
): number | null {
  const q = numeric(qty);
  const p = numeric(unitPrice);
  if (q === null || p === null) return null;
  return roundHalfUp(q * p, AMOUNT_DECIMALS);
}

export type BatchValidation =
  | { ok: true; value: number | string }
  | { ok: false; error: string };

/**
 * 批量值校验（与内核 `rules.validate_items` 同口径）：
 * - 数量：必须 > 0 的有限数
 * - 单价：必须 ≥ 0 的有限数（允许 0，如赠品行）
 * - 文本（规格/单位/原产国）：去空白后不能为空
 */
export function validateBatchValue(
  field: BatchField,
  raw: string,
): BatchValidation {
  const text = String(raw ?? "").trim();
  const def = BATCH_FIELDS.find((f) => f.value === field);
  if (!def) return { ok: false, error: "未知字段" };
  if (text === "") {
    return {
      ok: false,
      error: field === "qty" || field === "unit_price" ? "请填写数值" : "不能为空",
    };
  }
  if (def.kind === "number" || def.kind === "text-number") {
    // 明确拒绝 "12abc"/"1,000" 之类的输入：Number 会宽容解析，这里先卡格式
    if (!/^-?\d+(\.\d+)?$/.test(text)) {
      return { ok: false, error: "不是合法的数字（不要带千分位/单位）" };
    }
    const value = Number(text);
    if (!Number.isFinite(value)) {
      return { ok: false, error: "不是合法的数字" };
    }
    if (field === "qty" && !(value > 0)) {
      return { ok: false, error: "数量须为正数" };
    }
    if (field === "unit_price" && value < 0) {
      return { ok: false, error: "单价不能为负" };
    }
    return { ok: true, value };
  }
  return { ok: true, value: text };
}

/** 选中状态：全选 / 半选（indeterminate）/ 全不选 */
export function selectionState(
  selected: ReadonlySet<number>,
  total: number,
): "none" | "some" | "all" {
  if (total <= 0 || selected.size === 0) return "none";
  return selected.size >= total ? "all" : "some";
}

export function toggleRow(
  selected: ReadonlySet<number>,
  index: number,
): Set<number> {
  const next = new Set(selected);
  if (next.has(index)) next.delete(index);
  else next.add(index);
  return next;
}

/** 全选 ⇄ 清空（半选状态点一下按"全选"处理） */
export function toggleAll(selected: ReadonlySet<number>, total: number): Set<number> {
  return selectionState(selected, total) === "all"
    ? new Set()
    : new Set(Array.from({ length: total }, (_, i) => i));
}

export interface BatchApplyResult {
  /** 应用后的完整行项数组（未选中的行原样保留） */
  items: ItemRow[];
  /** 实际发生变化的行下标（升序） */
  changedIndexes: number[];
  /** 选中的行里没有一个真的变化（值本来就相同） */
  unchanged: boolean;
}

/**
 * 把 `field = value` 应用到选中的行。
 *
 * - 只改选中行；未选中的行**保持同一个对象引用**（便于上层做 diff/撤销）。
 * - `qty`/`unit_price` 变化时，`line_amount` 同步重算为推导值（金额字段永远不可手改）。
 */
export function applyBatchEdit(
  items: readonly ItemRow[],
  selected: ReadonlySet<number>,
  field: BatchField,
  value: number | string,
): BatchApplyResult {
  // 未选中的行保持**同一个对象引用**：上层可以做引用相等判断/低成本撤销
  const next: ItemRow[] = [...items];
  const changed: number[] = [];
  for (const index of [...selected].sort((a, b) => a - b)) {
    const row = next[index];
    if (!row) continue;
    const current = row[field];
    const same =
      typeof value === "number"
        ? numeric(current) === value
        : String(current ?? "").trim() === value;
    if (same) continue;
    const updated: ItemRow = { ...row, [field]: value };
    if (field === "qty" || field === "unit_price") {
      const derived = lineAmountOf(updated.qty, updated.unit_price);
      if (derived !== null) updated.line_amount = derived;
    }
    next[index] = updated;
    changed.push(index);
  }
  return { items: next, changedIndexes: changed, unchanged: changed.length === 0 };
}

export interface BatchAmountImpact {
  /** 受影响（实际变化）的行数 */
  affectedRows: number;
  changedIndexes: number[];
  /** 行合计（双币种时 CNY/USD 各一；否则 single 币种金额） */
  before: { cny: number | null; usd: number | null; currency: string };
  after: { cny: number | null; usd: number | null; currency: string };
  delta: { cny: number | null; usd: number | null };
}

function totalsOf(summary: ReturnType<typeof summarizeAmounts>) {
  if (summary.hasFx) {
    return {
      cny: summary.lineCny,
      usd: summary.lineUsd,
      currency: "USD",
      amount: summary.lineCny,
    };
  }
  return {
    cny: null,
    usd: null,
    currency: summary.single?.currency ?? "USD",
    amount: summary.single?.amount ?? null,
  };
}

/**
 * 预览：选中行批量改完之后，行合计变化多少（双币种给出 CNY/USD 两个 Δ）。
 *
 * 金额口径直接复用 A5-W3 的 `summarizeAmounts`（⇒ `render.ts::computeFxBreakdown`），
 * 所以预览数字与"编辑后真正渲染出来的金额块"一致。
 */
export function summarizeBatchImpact(args: {
  docType: string;
  data: Record<string, unknown> | null | undefined;
  beforeItems: readonly ItemRow[];
  afterItems: readonly ItemRow[];
  changedIndexes: readonly number[];
}): BatchAmountImpact {
  const beforeSummary = summarizeAmounts({
    docType: args.docType,
    data: { ...(args.data ?? {}), items: args.beforeItems as unknown[] },
  });
  const afterSummary = summarizeAmounts({
    docType: args.docType,
    data: { ...(args.data ?? {}), items: args.afterItems as unknown[] },
  });
  const before = totalsOf(beforeSummary);
  const after = totalsOf(afterSummary);
  return {
    affectedRows: args.changedIndexes.length,
    changedIndexes: [...args.changedIndexes],
    before: { cny: before.cny, usd: before.usd, currency: before.currency },
    after: { cny: after.cny, usd: after.usd, currency: after.currency },
    delta: {
      cny:
        before.cny !== null && after.cny !== null
          ? roundHalfUp(after.cny - before.cny, 2)
          : null,
      usd:
        before.usd !== null && after.usd !== null
          ? roundHalfUp(after.usd - before.usd, 2)
          : null,
    },
  };
}
/** 单币种时的行合计（预览条用；双币种请看 `summarizeBatchImpact`） */
export function singleCurrencyTotal(
  docType: string,
  data: Record<string, unknown> | null | undefined,
  items: readonly ItemRow[],
): { amount: number | null; currency: string } {
  const summary = summarizeAmounts({
    docType,
    data: { ...(data ?? {}), items: items as unknown[] },
  });
  return {
    amount: summary.single?.amount ?? null,
    currency: summary.single?.currency ?? "USD",
  };
}

// ─── items_override 契约（A5-W2 / task-47）─────────────────────────────────
//
// 后端契约（align-b 实现）：
//   `raw_payload.custom.items_override = [{index, qty?, unit_price?, unit?, spec?, origin?}]`
//   - 只允许 draft；非 draft → 422 `ITEMS_OVERRIDE_DRAFT_ONLY`
//   - index 越界 → 422 `ITEMS_OVERRIDE_INDEX`
//   - 出现金额字段（line_amount/amount/total_amount）→ 422 `ITEMS_OVERRIDE_AMOUNT_FORBIDDEN`
//   - 命中的行 facts 标 `source=manual / trust=unverified`（签发闸门据此拦截，直到人工确认）
// 本模块负责：UI 字段名 → 契约字段名、只发变化字段、合并/撤销、payload 组装（**保留 sources**）。

/** 契约字段（注意：规格是 `spec`、单位是 `unit`、原产国是 `origin`） */
export interface ItemsOverrideEntry {
  index: number;
  qty?: number;
  unit_price?: number;
  unit?: string;
  spec?: string;
  origin?: string;
}

/** UI 批量字段 → 契约字段 */
export const OVERRIDE_KEY_OF: Record<BatchField, keyof Omit<ItemsOverrideEntry, "index">> = {
  specification: "spec",
  qty: "qty",
  qty_unit: "unit",
  unit_price: "unit_price",
  country_of_origin: "origin",
};

/** 契约里**禁止**出现的键（金额只能由 qty×price 推导） */
export const FORBIDDEN_OVERRIDE_KEYS = [
  "line_amount",
  "amount",
  "total_amount",
  "line_total",
] as const;

/** 行项对象上的 UI 字段名（构建 override 时读这些键） */
const ITEM_KEY_OF: Record<BatchField, string> = {
  specification: "specification",
  qty: "qty",
  unit_price: "unit_price",
  qty_unit: "qty_unit",
  country_of_origin: "country_of_origin",
};

/**
 * 生成 `items_override`：**只包含真正变化的行/字段**（未改的字段不进 JSON）。
 *
 * 不写 `line_amount` —— 金额永远由 `qty × unit_price` 推导（后端也会拒绝金额键）。
 */
export function buildItemsOverride(
  beforeItems: readonly ItemRow[],
  afterItems: readonly ItemRow[],
): ItemsOverrideEntry[] {
  const out: ItemsOverrideEntry[] = [];
  const length = Math.min(beforeItems.length, afterItems.length);
  for (let index = 0; index < length; index += 1) {
    const before = beforeItems[index];
    const after = afterItems[index];
    if (!after) continue;
    const entry: ItemsOverrideEntry = { index };
    for (const field of BATCH_FIELDS.map((f) => f.value) as BatchField[]) {
      const itemKey = ITEM_KEY_OF[field];
      const nextValue = after[itemKey];
      const prevValue = before?.[itemKey];
      const changed =
        field === "qty" || field === "unit_price"
          ? numeric(nextValue) !== numeric(prevValue)
          : String(nextValue ?? "").trim() !== String(prevValue ?? "").trim();
      if (!changed) continue;
      if (field === "qty" || field === "unit_price") {
        const num = numeric(nextValue);
        if (num === null) continue;
        if (field === "qty") entry.qty = num;
        else entry.unit_price = num;
      } else {
        const text = String(nextValue ?? "").trim();
        if (text === "") continue;
        // 契约字段名：规格=spec / 单位=unit / 原产国=origin（见 OVERRIDE_KEY_OF）
        if (field === "specification") entry.spec = text;
        else if (field === "qty_unit") entry.unit = text;
        else entry.origin = text;
      }
    }
    if (Object.keys(entry).length > 1) out.push(entry);
  }
  return out;
}

/** 合并（同 index 后者覆盖前者，保留字段级合并）；空条目剔除、按 index 升序 */
export function mergeItemsOverride(
  existing: readonly ItemsOverrideEntry[] | undefined,
  incoming: readonly ItemsOverrideEntry[],
): ItemsOverrideEntry[] {
  const byIndex = new Map<number, ItemsOverrideEntry>();
  for (const entry of existing ?? []) {
    if (!Number.isInteger(entry.index) || entry.index < 0) continue;
    byIndex.set(entry.index, { ...entry });
  }
  for (const entry of incoming) {
    if (!Number.isInteger(entry.index) || entry.index < 0) continue;
    const current = byIndex.get(entry.index) ?? { index: entry.index };
    byIndex.set(entry.index, { ...current, ...entry, index: entry.index });
  }
  return [...byIndex.values()].sort((a, b) => a.index - b.index);
}

/**
 * 把 override 应用到行项（**与后端渲染副本同语义**，用于乐观预览 / MSW mock）：
 * 返回新数组；只改给定字段；`line_amount` 在 qty/unit_price 变化后按 4 位重算。
 */
export function applyItemsOverride(
  items: readonly ItemRow[],
  override: readonly ItemsOverrideEntry[] | undefined,
): ItemRow[] {
  const byIndex = new Map((override ?? []).map((entry) => [entry.index, entry]));
  return items.map((row, index) => {
    const entry = byIndex.get(index);
    if (!entry) return row;
    const next: ItemRow = { ...row };
    if (typeof entry.qty === "number") next.qty = entry.qty;
    if (typeof entry.unit_price === "number") next.unit_price = entry.unit_price;
    if (typeof entry.unit === "string") next.qty_unit = entry.unit;
    if (typeof entry.spec === "string") next.specification = entry.spec;
    if (typeof entry.origin === "string") next.country_of_origin = entry.origin;
    const derived = lineAmountOf(next.qty, next.unit_price);
    if (derived !== null) next.line_amount = derived;
    return next;
  });
}

/**
 * 校验 override 形状（前端先拦，别等后端 422）：
 * - 金额键出现 ⇒ `ITEMS_OVERRIDE_AMOUNT_FORBIDDEN`
 * - index 非自然数 ⇒ `ITEMS_OVERRIDE_INDEX`
 * 返回 `null` 表示通过。
 */
export function validateItemsOverride(
  override: readonly Record<string, unknown>[],
): { code: string; detail: string } | null {
  for (const entry of override) {
    for (const key of FORBIDDEN_OVERRIDE_KEYS) {
      if (key in entry) {
        return {
          code: "ITEMS_OVERRIDE_AMOUNT_FORBIDDEN",
          detail: `行项覆盖不接受金额字段（${key}）：金额只能由 数量×单价 推导`,
        };
      }
    }
    const index = entry.index;
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0) {
      return { code: "ITEMS_OVERRIDE_INDEX", detail: `行下标非法：${String(index)}` };
    }
  }
  return null;
}

/**
 * 组装 PATCH `/trade-docs/{id}` 的 `raw_payload`。
 *
 * ⚠️ **必须保留 `sources`**（后端整块替换 raw_payload；漏了就把上游快照抹掉，
 * 单据从此回不到上游 —— 与 `custom-fields.ts::buildPayloadPatch` 同一教训）。
 * `override` 为空数组时**删掉**该键（撤销到底 = 回到无覆盖）。
 */
export function buildItemsOverridePayload(
  payload: Record<string, unknown> | null | undefined,
  override: readonly ItemsOverrideEntry[],
): Record<string, unknown> {
  const base = { ...(payload ?? {}) };
  const custom = { ...((base.custom as Record<string, unknown> | undefined) ?? {}) };
  if (override.length === 0) delete custom.items_override;
  else custom.items_override = [...override];
  return { ...base, custom };
}

/** 从 payload 读出既有 override（非数组/形状不对 → 空） */
export function readItemsOverride(
  payload: Record<string, unknown> | null | undefined,
): ItemsOverrideEntry[] {
  const custom = payload?.custom;
  if (!custom || typeof custom !== "object") return [];
  const raw = (custom as Record<string, unknown>).items_override;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (entry): entry is ItemsOverrideEntry =>
      typeof entry === "object" && entry !== null && Number.isInteger((entry as ItemsOverrideEntry).index),
  );
}