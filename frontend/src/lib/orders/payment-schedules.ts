/**
 * 订单收款计划（C36 下期 #6/#10/#20）—— 纯逻辑层。
 *
 * 契约真源（`backend/worker/src/main.py`）：
 * - `GET /orders/{order_id}/payment-schedules` → `{items, total}`，每项是
 *   `order_serializers.row_to_schedule` 的 **14 键**（id/order_id/trade_doc_id/
 *   schedule_type/ratio/amount/currency/due_date/actual_date/status/fx_rate/
 *   exchange_gain_loss/notes/created_at）；
 * - `POST /orders/{order_id}/payment-schedules` → 201：
 *   `schedule_type` **必填**（deposit/balance/full，缺 ⇒ 422 `SCHEDULE_TYPE_REQUIRED`）；
 *   `ratio` 与 `amount` 都可空、也可同给（amount 优先，缺 amount 时后端按 ratio × 订单总额补算）；
 * - `PATCH /payment-schedules/{id}`：可改 amount/due_date/notes，或 `status=paid` 标记收款
 *   （付 `fx_rate` 才计算汇兑损益；未付则只落日期）；非法 status ⇒ 422；
 *   `paid → 非 paid` ⇒ 409 `ILLEGAL_TRANSITION`。
 */
import { normalizeApiError } from "@/lib/api/api-error";

export const SCHEDULE_TYPES = [
  "deposit",
  "balance",
  "full",
  "other",
] as const;
export type ScheduleType = (typeof SCHEDULE_TYPES)[number];

export const SCHEDULE_STATUSES = [
  "pending",
  "partial",
  "paid",
  "overdue",
] as const;
export type ScheduleStatus = (typeof SCHEDULE_STATUSES)[number];

export const SCHEDULE_TYPE_LABEL: Record<string, string> = {
  deposit: "定金",
  balance: "尾款",
  full: "全额",
  other: "其他",
};

export const SCHEDULE_STATUS_LABEL: Record<string, string> = {
  pending: "待收款",
  partial: "部分收款",
  paid: "已收款",
  overdue: "已逾期",
};

export const SCHEDULE_STATUS_TONE: Record<
  string,
  "default" | "success" | "warning" | "danger" | "info"
> = {
  pending: "warning",
  partial: "info",
  paid: "success",
  overdue: "danger",
};

/** `row_to_schedule` 的 14 键（金额一律 number|null，日期 ISO 串或 null）。 */
export interface PaymentSchedule {
  id: number;
  order_id: number;
  trade_doc_id: number | null;
  schedule_type: string;
  ratio: number | null;
  amount: number | null;
  currency: string | null;
  due_date: string | null;
  actual_date: string | null;
  status: string;
  fx_rate: number | null;
  exchange_gain_loss: number | null;
  notes: string | null;
  created_at: string | null;
  /**
   * 该期实收合计（后端 §13.3 新增，含历史 paid 兼容口径）。
   * 老后端不返回时可缺省 —— 前端用 receipts 自行汇总兜底。
   */
  received_amount?: number | null;
}

export interface ScheduleListResponse {
  items: PaymentSchedule[];
  total: number;
}

export interface ScheduleCreateInput {
  schedule_type: string;
  /** 比例（0~1，如 0.3 = 30%）；与 amount 至少给一个更合理，但后端两个都允许空 */
  ratio?: string;
  amount?: string;
  due_date?: string;
  notes?: string;
}

export interface SchedulePatchInput {
  amount?: string;
  due_date?: string;
  notes?: string;
  status?: string;
  /** 标记收款时的实际汇率（给了才计算汇兑损益） */
  fx_rate?: string;
  actual_date?: string;
}

export type BuildResult<T> =
  | { ok: true; body: T }
  | { ok: false; error: string };

function positiveNumber(
  text: string | undefined,
  label: string,
): { ok: true; value?: number } | { ok: false; error: string } {
  const raw = (text ?? "").trim();
  if (raw === "") return { ok: true };
  const num = Number(raw);
  if (!Number.isFinite(num) || num <= 0) {
    return { ok: false, error: `${label}必须是大于 0 的数字` };
  }
  return { ok: true, value: num };
}

function ratioNumber(
  text: string | undefined,
): { ok: true; value?: number } | { ok: false; error: string } {
  const raw = (text ?? "").trim();
  if (raw === "") return { ok: true };
  const num = Number(raw);
  if (!Number.isFinite(num) || num <= 0 || num > 1) {
    return { ok: false, error: "比例必须在 0~1 之间（30% 填 0.3）" };
  }
  return { ok: true, value: num };
}

/** 组 `POST /orders/{id}/payment-schedules` 的请求体（本地先拦明显非法输入）。 */
export function buildScheduleCreate(
  input: ScheduleCreateInput,
): BuildResult<Record<string, unknown>> {
  const scheduleType = input.schedule_type.trim();
  if (!scheduleType) return { ok: false, error: "请选择收款类型（定金/尾款/全额）" };
  if (!(SCHEDULE_TYPES as readonly string[]).includes(scheduleType)) {
    return { ok: false, error: "收款类型取值不合法" };
  }
  const ratio = ratioNumber(input.ratio);
  if (!ratio.ok) return ratio;
  const amount = positiveNumber(input.amount, "金额");
  if (!amount.ok) return amount;
  if (ratio.value === undefined && amount.value === undefined) {
    return { ok: false, error: "金额与比例至少填一个" };
  }
  const body: Record<string, unknown> = { schedule_type: scheduleType };
  if (ratio.value !== undefined) body.ratio = ratio.value;
  if (amount.value !== undefined) body.amount = amount.value;
  const due = (input.due_date ?? "").trim();
  if (due) body.due_date = due;
  const notes = (input.notes ?? "").trim();
  if (notes) body.notes = notes;
  return { ok: true, body };
}

/** 组 `PATCH /payment-schedules/{id}` 的请求体（只带用户实际填了的字段）。 */
export function buildSchedulePatch(
  input: SchedulePatchInput,
): BuildResult<Record<string, unknown>> {
  const body: Record<string, unknown> = {};
  const amount = positiveNumber(input.amount, "金额");
  if (!amount.ok) return amount;
  if (amount.value !== undefined) body.amount = amount.value;

  const status = (input.status ?? "").trim();
  if (status) {
    if (!(SCHEDULE_STATUSES as readonly string[]).includes(status)) {
      return { ok: false, error: "收款状态取值不合法" };
    }
    body.status = status;
  }

  const fxRate = positiveNumber(input.fx_rate, "汇率");
  if (!fxRate.ok) return fxRate;
  if (fxRate.value !== undefined) body.fx_rate = fxRate.value;

  const due = (input.due_date ?? "").trim();
  if (due) body.due_date = due;
  const actual = (input.actual_date ?? "").trim();
  if (actual) body.actual_date = actual;
  const notes = (input.notes ?? "").trim();
  if (notes) body.notes = notes;

  if (Object.keys(body).length === 0) {
    return { ok: false, error: "没有要修改的字段" };
  }
  return { ok: true, body };
}

interface ScheduleErrorDetail {
  code?: unknown;
  detail?: unknown;
  message?: unknown;
  from?: unknown;
  to?: unknown;
}

/**
 * 收款计划操作失败的原因（给人看）：
 * 后端错误体有两种（嵌套 detail 对象 / 扁平 detail 字符串），都要认；
 * `ILLEGAL_TRANSITION`（已收款不能改回）给专门文案，而不是通用"请求失败"。
 */
export function scheduleErrorText(error: unknown): string {
  const normalized = normalizeApiError(error);
  const detail = (
    error as { response?: { data?: { detail?: unknown } } } | null
  )?.response?.data?.detail;
  const record: ScheduleErrorDetail | null =
    typeof detail === "object" && detail !== null
      ? (detail as ScheduleErrorDetail)
      : null;
  if (normalized.code === "ILLEGAL_TRANSITION") {
    const from = String(record?.from ?? "");
    const to = String(record?.to ?? "");
    const fromLabel = SCHEDULE_STATUS_LABEL[from] ?? (from || "paid");
    return `已收款（${fromLabel}）不能改回「${
      SCHEDULE_STATUS_LABEL[to] ?? to
    }」`;
  }
  if (normalized.code === "SCHEDULE_TYPE_REQUIRED") {
    return "请选择收款类型（定金/尾款/全额）";
  }
  return normalized.message;
}

/**
 * 实收记录（§13.3 新增）。
 *
 * 一次到账一行，允许同一期多次收款；`schedule_id` 为空 = 这笔钱暂未指定期次
 * （"应收/实收对应不上"的场景），页面单独展示、不强行摊到某期。
 */
export interface PaymentReceipt {
  id: number;
  order_id: number;
  schedule_id: number | null;
  amount: number;
  currency: string | null;
  received_date: string | null;
  fx_rate: number | null;
  file_id: number | null;
  notes: string | null;
  created_at: string | null;
}

export interface ReceiptListResponse {
  items: PaymentReceipt[];
  total: number;
}

export interface ReceiptCreateInput {
  schedule_id?: number | null;
  /** 实收金额（必填 > 0） */
  amount: string;
  /** 收款日期（必填） */
  received_date: string;
  /** 实际汇率（选填） */
  fx_rate?: string;
  notes?: string;
}

function moneyNumber(
  text: string | undefined,
  label: string,
): { ok: true; value?: number } | { ok: false; error: string } {
  const raw = (text ?? "").trim();
  if (raw === "") return { ok: true };
  const num = Number(raw);
  if (!Number.isFinite(num) || num <= 0) {
    return { ok: false, error: `${label}必须是大于 0 的数字` };
  }
  return { ok: true, value: num };
}

/** 组 `POST /orders/{id}/receipts` 的请求体（本地先拦：金额必填 > 0、日期必填）。 */
export function buildReceiptCreate(
  input: ReceiptCreateInput,
): BuildResult<Record<string, unknown>> {
  const amount = moneyNumber(input.amount, "实收金额");
  if (!amount.ok) return amount;
  if (amount.value === undefined) {
    return { ok: false, error: "请填写实收金额（实际到账多少就填多少）" };
  }
  const received = (input.received_date ?? "").trim();
  if (!received) return { ok: false, error: "请选择收款日期" };
  const body: Record<string, unknown> = {
    amount: amount.value,
    received_date: received,
  };
  if (input.schedule_id !== undefined && input.schedule_id !== null) {
    body.schedule_id = input.schedule_id;
  }
  const fxRate = moneyNumber(input.fx_rate, "实际汇率");
  if (!fxRate.ok) return fxRate;
  if (fxRate.value !== undefined) body.fx_rate = fxRate.value;
  const notes = (input.notes ?? "").trim();
  if (notes) body.notes = notes;
  return { ok: true, body };
}

/** 登记收款失败的原因：后端校验错误翻成人话，其余走统一归一。 */
export function receiptErrorText(error: unknown): string {
  const normalized = normalizeApiError(error);
  const detail = (
    error as { response?: { data?: { detail?: unknown } } } | null
  )?.response?.data?.detail;
  const record =
    typeof detail === "object" && detail !== null
      ? (detail as { code?: unknown; detail?: unknown })
      : null;
  if (normalized.code === "INVALID_RECEIPT_AMOUNT") {
    return "实收金额必须大于 0";
  }
  if (normalized.code === "RECEIPT_DATE_REQUIRED") {
    return "请选择收款日期";
  }
  if (normalized.code === "SCHEDULE_NOT_IN_ORDER") {
    return "所选期次不属于这张订单，请刷新后重选";
  }
  if (record && typeof record.detail === "string" && record.detail.trim()) {
    return record.detail;
  }
  return normalized.message;
}

function amountOf(receipt: PaymentReceipt): number {
  return typeof receipt.amount === "number" && Number.isFinite(receipt.amount)
    ? receipt.amount
    : 0;
}

/** 某一期的实收记录（含未指定期次的收款不算进任何一期）。 */
export function receiptsForSchedule(
  receipts: PaymentReceipt[],
  scheduleId: number,
): PaymentReceipt[] {
  return receipts.filter((receipt) => receipt.schedule_id === scheduleId);
}

/** 某期已收金额：优先 receipts 合计，其次后端 received_amount，最后历史 paid 的 amount。 */
export function receivedAmountForSchedule(
  schedule: PaymentSchedule,
  receipts: PaymentReceipt[] = [],
): number {
  const own = receiptsForSchedule(receipts, schedule.id);
  if (own.length > 0) return own.reduce((sum, r) => sum + amountOf(r), 0);
  if (typeof schedule.received_amount === "number") {
    return schedule.received_amount;
  }
  if (schedule.status === "paid" && typeof schedule.amount === "number") {
    return schedule.amount;
  }
  return 0;
}

/**
 * 期次实际状态（前端推导，供展示与差异提示）：
 * 有实收 > 0 且未收满 ⇒ partial；收满或后端已是 paid ⇒ paid；其余沿用后端状态。
 */
export function effectiveScheduleStatus(
  schedule: PaymentSchedule,
  receipts: PaymentReceipt[] = [],
): ScheduleStatus {
  const received = receivedAmountForSchedule(schedule, receipts);
  const due = typeof schedule.amount === "number" ? schedule.amount : 0;
  if (schedule.status === "paid") return "paid";
  if (received <= 0) {
    return schedule.status === "overdue" ? "overdue" : "pending";
  }
  if (due > 0 && received + 0.005 >= due) return "paid";
  return "partial";
}

/** 差异 = 实收 − 应收；应收为空时返回 null（没有可比对象）。 */
export function scheduleDifference(
  schedule: PaymentSchedule,
  receipts: PaymentReceipt[] = [],
): number | null {
  if (typeof schedule.amount !== "number") return null;
  return (
    Math.round(
      (receivedAmountForSchedule(schedule, receipts) - schedule.amount) * 100,
    ) / 100
  );
}

/** 历史已收但没有任何 receipts 的计划：展示「历史收款（无截图）」，不强制补录。 */
export function isHistoricalPaidNoReceipt(
  schedule: PaymentSchedule,
  receipts: PaymentReceipt[] = [],
): boolean {
  return (
    schedule.status === "paid" &&
    receiptsForSchedule(receipts, schedule.id).length === 0
  );
}

/** 未分配收款（schedule_id 为空）：应收对不上时先挂在这里，不静默摊到某期。 */
export function unallocatedReceipts(
  receipts: PaymentReceipt[],
): PaymentReceipt[] {
  return receipts.filter((receipt) => receipt.schedule_id === null);
}

/** 实收汇总：笔数 + 金额合计。 */
export function summarizeReceipts(receipts: PaymentReceipt[]): {
  count: number;
  totalAmount: number;
} {
  return {
    count: receipts.length,
    totalAmount: receipts.reduce((sum, r) => sum + amountOf(r), 0),
  };
}

/**
 * 列表汇总：总额 / 已收 / 待收（按 amount 求和；null 金额按 0 计）。
 *
 * 已收口径：给了 receipts 就用实收合计（含历史 paid 兜底），否则按 status=paid
 * 的计划金额（保持 C36 旧行为，历史数据语义不变）。
 */
export function summarizeSchedules(
  items: PaymentSchedule[],
  receipts: PaymentReceipt[] = [],
): {
  count: number;
  totalAmount: number;
  paidAmount: number;
  pendingAmount: number;
  paidCount: number;
  pendingCount: number;
  partialCount: number;
} {
  let totalAmount = 0;
  let paidAmount = 0;
  let paidCount = 0;
  let partialCount = 0;
  for (const item of items) {
    const amount = typeof item.amount === "number" ? item.amount : 0;
    totalAmount += amount;
    const received = receivedAmountForSchedule(item, receipts);
    paidAmount += received;
    const status = effectiveScheduleStatus(item, receipts);
    if (status === "paid") paidCount += 1;
    else if (status === "partial") partialCount += 1;
  }
  return {
    count: items.length,
    totalAmount,
    paidAmount,
    pendingAmount: totalAmount - paidAmount,
    paidCount,
    pendingCount: items.length - paidCount,
    partialCount,
  };
}
