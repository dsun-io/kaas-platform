/**
 * 收款计划（应收）草稿逻辑 —— 建单向导第 4 步（§13.3）。
 *
 * 用户口径：
 * - 一键模板：30% 定金 + 70% 发货前、50% + 50%、100% 预付、自定义；
 * - 每行：期次类型（定金/尾款/全额/其他）、比例（%）、金额、到期日、备注；
 * - **比例变化时金额自动 = 订单总额 × 比例**（可手改金额）；
 * - 改金额时反算比例**只做提示**，不覆盖用户填的比例；
 * - 提交前校验：比例合计 ≤ 100%；金额合计与订单总额不一致只提示、不阻断
 *   （运费后补等真实业务允许差异）。
 *
 * 后端 `payment_plan[]` 的 ratio 是**小数**（0.3 = 30%），前端草稿用百分比字符串
 * 便于输入，build 时再除 100。
 */
import { roundMoney } from "./order-detail";
import { SCHEDULE_TYPE_LABEL, SCHEDULE_TYPES } from "./payment-schedules";

export interface PaymentPlanTemplate {
  id: string;
  label: string;
  /** 每一期的类型 + 比例（%）；自定义为空数组 */
  rows: { schedule_type: string; ratioPct: number; notes?: string }[];
}

export const PAYMENT_PLAN_TEMPLATES: PaymentPlanTemplate[] = [
  {
    id: "30_70",
    label: "30% 定金 + 70% 发货前",
    rows: [
      { schedule_type: "deposit", ratioPct: 30, notes: "订单确认后" },
      { schedule_type: "balance", ratioPct: 70, notes: "发货前" },
    ],
  },
  {
    id: "50_50",
    label: "50% + 50%",
    rows: [
      { schedule_type: "deposit", ratioPct: 50, notes: "订单确认后" },
      { schedule_type: "balance", ratioPct: 50, notes: "发货前" },
    ],
  },
  {
    id: "100_prepaid",
    label: "100% 预付",
    rows: [{ schedule_type: "full", ratioPct: 100, notes: "预付全款" }],
  },
  { id: "custom", label: "自定义", rows: [] },
];

/** 向导里的一行收款计划（金额/比例都是输入框字符串，便于受控编辑）。 */
export interface PaymentPlanRow {
  /** 本地稳定 key（不是后端 id） */
  key: string;
  schedule_type: string;
  /** 百分比（"30" 表示 30%）；空串 = 未填 */
  ratioPct: string;
  /** 金额（"1200.00"）；空串 = 未填 */
  amount: string;
  due_date: string;
  notes: string;
  /** 用户是否手改过金额（手改后改订单总额不再自动覆盖） */
  amount_touched?: boolean;
}

let rowSeq = 0;
/** 本地行 key：不用数组下标，删行/插行时不串输入框状态。 */
export function nextPlanRowKey(): string {
  rowSeq += 1;
  return `plan-${Date.now().toString(36)}-${rowSeq}`;
}

export function makePlanRow(
  input: Partial<Omit<PaymentPlanRow, "key">> = {},
): PaymentPlanRow {
  return {
    key: nextPlanRowKey(),
    schedule_type: input.schedule_type ?? "deposit",
    ratioPct: input.ratioPct ?? "",
    amount: input.amount ?? "",
    due_date: input.due_date ?? "",
    notes: input.notes ?? "",
    amount_touched: input.amount_touched ?? false,
  };
}

/** 模板 → 计划行：金额按当前订单总额自动算好（总额未知时留空）。 */
export function applyPaymentPlanTemplate(
  templateId: string,
  total: number,
): PaymentPlanRow[] {
  const template =
    PAYMENT_PLAN_TEMPLATES.find((item) => item.id === templateId) ??
    PAYMENT_PLAN_TEMPLATES[PAYMENT_PLAN_TEMPLATES.length - 1]!;
  if (template.id === "custom") return [];
  return template.rows.map((row) =>
    makePlanRow({
      schedule_type: row.schedule_type,
      ratioPct: formatPercent(row.ratioPct),
      amount: formatAmountFromRatio(row.ratioPct, total),
      notes: row.notes ?? "",
    }),
  );
}

/** 计划模板 id（根据现有行反推，用于高亮当前模板；推不出按自定义）。 */
export function detectTemplateId(rows: PaymentPlanRow[]): string {
  if (rows.length === 0) return "custom";
  for (const template of PAYMENT_PLAN_TEMPLATES) {
    if (template.id === "custom") continue;
    if (template.rows.length !== rows.length) continue;
    const match = template.rows.every((expected, index) => {
      const row = rows[index];
      if (!row) return false;
      return (
        row.schedule_type === expected.schedule_type &&
        Number(row.ratioPct) === expected.ratioPct
      );
    });
    if (match) return template.id;
  }
  return "custom";
}

/** 百分比数字 → 输入框字符串（30 → "30"；33.333 → "33.33"）。 */
export function formatPercent(value: number): string {
  return String(Number(value.toFixed(2)));
}

/** 比例(%) + 总额 → 金额字符串；总额/比例无效时返回空串。 */
export function formatAmountFromRatio(
  ratioPct: number | string,
  total: number,
): string {
  const pct = typeof ratioPct === "number" ? ratioPct : Number(ratioPct);
  if (!Number.isFinite(pct) || pct <= 0) return "";
  if (!Number.isFinite(total) || total <= 0) return "";
  return roundMoney((total * pct) / 100).toFixed(2);
}

/** 金额 + 总额 → 反算比例（%），仅用于提示，不写回输入框。 */
export function ratioFromAmount(
  amount: number | string,
  total: number,
): number | null {
  const num = typeof amount === "number" ? amount : Number(amount);
  if (!Number.isFinite(num) || num <= 0) return null;
  if (!Number.isFinite(total) || total <= 0) return null;
  return Math.round((num / total) * 10000) / 100;
}

/** 比例输入变化：自动重算金额（这是"比例→金额自动"的唯一入口）。 */
export function applyRatioChange(
  row: PaymentPlanRow,
  ratioText: string,
  total: number,
): PaymentPlanRow {
  const next = { ...row, ratioPct: ratioText };
  const pct = Number(ratioText);
  if (ratioText.trim() === "" || !Number.isFinite(pct)) {
    return next;
  }
  // 比例是"金额的唯一真相"：改比例时覆盖手改金额
  return {
    ...next,
    amount: formatAmountFromRatio(pct, total),
    amount_touched: false,
  };
}

/** 改金额：只标记手改，不反写比例（反算比例仅在界面提示）。 */
export function applyAmountChange(row: PaymentPlanRow, amountText: string): PaymentPlanRow {
  return { ...row, amount: amountText, amount_touched: true };
}

/**
 * 订单总额变化（回上一步改了运费/货物）→ 未手改过金额的行按比例自动重算；
 * 手改过的行保持原值（用户意图优先，差异由提示兜底）。
 */
export function applyTotalChange(
  rows: PaymentPlanRow[],
  total: number,
): PaymentPlanRow[] {
  return rows.map((row) => {
    if (row.amount_touched) return row;
    if (row.ratioPct.trim() === "") return row;
    return { ...row, amount: formatAmountFromRatio(row.ratioPct, total) };
  });
}

/** 金额手改：比例**不自动回写**，只在界面上提示反算值（这里返回提示文案）。 */
export function amountRatioHint(
  row: PaymentPlanRow,
  total: number,
): string | null {
  if (row.amount.trim() === "" || row.ratioPct.trim() === "") return null;
  const derived = ratioFromAmount(row.amount, total);
  if (derived === null) return null;
  const entered = Number(row.ratioPct);
  if (!Number.isFinite(entered)) return null;
  if (Math.abs(derived - entered) < 0.01) return null;
  return `按金额反算比例约 ${formatPercent(derived)}%（与上面填的 ${formatPercent(
    entered,
  )}% 不一致，请确认）`;
}

/** 计划金额合计（空行按 0 计）。 */
export function sumPlanAmounts(rows: PaymentPlanRow[]): number {
  return roundMoney(
    rows.reduce((sum, row) => {
      const num = Number(row.amount);
      return sum + (Number.isFinite(num) ? num : 0);
    }, 0),
  );
}

/** 计划比例合计（%）。 */
export function sumPlanRatios(rows: PaymentPlanRow[]): number {
  return Math.round(
    rows.reduce((sum, row) => {
      const num = Number(row.ratioPct);
      return sum + (Number.isFinite(num) ? num : 0);
    }, 0) * 100,
  ) / 100;
}

export interface PaymentPlanValidation {
  /** 阻断提交的问题（比例越界、比例合计 > 100 等） */
  errors: string[];
  /** 仅提示的问题（金额合计 ≠ 订单总额、比例未填等） */
  warnings: string[];
}

/**
 * 校验收款计划：
 * - 每行：比例 0~100 或金额 > 0；两者都空 ⇒ 错误（后端会建出 0 金额计划）；
 * - 比例合计 > 100 ⇒ 错误（后端 ratio 合计 ≤ 1）；
 * - 金额合计与订单总额不一致 ⇒ 警告（允许差异）。
 */
export function validatePaymentPlan(
  rows: PaymentPlanRow[],
  total: number,
): PaymentPlanValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  rows.forEach((row, index) => {
    const label = `第 ${index + 1} 期`;
    const ratioText = row.ratioPct.trim();
    const amountText = row.amount.trim();
    const ratio = ratioText === "" ? null : Number(ratioText);
    const amount = amountText === "" ? null : Number(amountText);
    if (ratio === null && amount === null) {
      errors.push(`${label}请填比例或金额`);
      return;
    }
    if (ratio !== null && (!Number.isFinite(ratio) || ratio <= 0 || ratio > 100)) {
      errors.push(`${label}的比例必须在 0~100 之间`);
    }
    if (amount !== null && (!Number.isFinite(amount) || amount <= 0)) {
      errors.push(`${label}的金额必须大于 0`);
    }
    if (!(SCHEDULE_TYPES as readonly string[]).includes(row.schedule_type)) {
      errors.push(`${label}的期次类型不合法`);
    }
  });
  if (rows.length > 0 && sumPlanRatios(rows) > 100.001) {
    errors.push(`比例合计 ${formatPercent(sumPlanRatios(rows))}% 超过 100%`);
  }
  if (rows.length > 0 && total > 0) {
    const planned = sumPlanAmounts(rows);
    if (Math.abs(planned - total) > 0.01) {
      warnings.push(
        `收款计划金额合计 ${planned.toFixed(2)} 与订单总额 ${total.toFixed(
          2,
        )} 不一致（允许差异，如运费后补；保存后按实际计划生成应收）`,
      );
    }
  }
  return { errors, warnings };
}

/** 组 `POST /orders` 的 `payment_plan[]`（ratio 转小数；只带填了的字段）。 */
export function buildPaymentPlanPayload(
  rows: PaymentPlanRow[],
): Record<string, unknown>[] {
  return rows.map((row) => {
    const item: Record<string, unknown> = {
      schedule_type: row.schedule_type,
    };
    const ratio = Number(row.ratioPct);
    if (row.ratioPct.trim() !== "" && Number.isFinite(ratio)) {
      item.ratio = Math.round((ratio / 100) * 1e6) / 1e6;
    }
    const amount = Number(row.amount);
    if (row.amount.trim() !== "" && Number.isFinite(amount)) {
      item.amount = roundMoney(amount);
    }
    if (row.due_date.trim()) item.due_date = row.due_date.trim();
    if (row.notes.trim()) item.notes = row.notes.trim();
    return item;
  });
}

/** 期次类型下拉选项（含"其他"）；顺序固定，便于测试与键盘操作。 */
export const PLAN_SCHEDULE_TYPE_OPTIONS = SCHEDULE_TYPES.map((type) => ({
  value: type,
  label: SCHEDULE_TYPE_LABEL[type] ?? type,
}));
