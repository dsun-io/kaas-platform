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

export const SCHEDULE_TYPES = ["deposit", "balance", "full"] as const;
export type ScheduleType = (typeof SCHEDULE_TYPES)[number];

export const SCHEDULE_STATUSES = ["pending", "paid", "overdue"] as const;
export type ScheduleStatus = (typeof SCHEDULE_STATUSES)[number];

export const SCHEDULE_TYPE_LABEL: Record<string, string> = {
  deposit: "定金",
  balance: "尾款",
  full: "全额",
};

export const SCHEDULE_STATUS_LABEL: Record<string, string> = {
  pending: "待收款",
  paid: "已收款",
  overdue: "已逾期",
};

export const SCHEDULE_STATUS_TONE: Record<
  string,
  "default" | "success" | "warning" | "danger" | "info"
> = {
  pending: "warning",
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

/** 列表汇总：总额 / 已收 / 待收（按 amount 求和；null 金额按 0 计） */
export function summarizeSchedules(items: PaymentSchedule[]): {
  count: number;
  totalAmount: number;
  paidAmount: number;
  pendingAmount: number;
  paidCount: number;
  pendingCount: number;
} {
  let totalAmount = 0;
  let paidAmount = 0;
  let pendingAmount = 0;
  let paidCount = 0;
  let pendingCount = 0;
  for (const item of items) {
    const amount = typeof item.amount === "number" ? item.amount : 0;
    totalAmount += amount;
    if (item.status === "paid") {
      paidAmount += amount;
      paidCount += 1;
    } else {
      pendingAmount += amount;
      pendingCount += 1;
    }
  }
  return {
    count: items.length,
    totalAmount,
    paidAmount,
    pendingAmount,
    paidCount,
    pendingCount,
  };
}
