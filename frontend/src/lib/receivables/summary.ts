/**
 * 应收台账纯逻辑（C36 下期 #7）
 *
 * 契约真源：`GET /api/v1/receivables`（`backend/worker/src/main.py:4090`）
 *   - 参数：**只有** `status`（unpaid|partial|paid，非法 422 `bad_receivable_status`）+ `page`/`page_size`
 *   - 返回：`{items,total,page,page_size}`；每行 = 共享序列化 12 键 + join `order_no/customer_name`
 *     （`id/order_id/currency/total_amount/fx_rate/fx_rate_date/base_currency/base_amount/
 *       received_amount/exchange_gain_loss/status/created_at`）
 *
 * ⚠️ **到期日不在应收接口里**（`receivables` 表也没有 due_date 列）：真实到期日在
 * `payment_schedules.due_date`，只能按订单取（`GET /orders/{id}/payment-schedules`）。
 * 因此本模块的"逾期"只做**纯计算**（给到期日 → 天数），取数由页面按当前页订单号做；
 * **不**用"开单日 + N 天"这类自造口径（那是业务假设，不是合同到期日）。
 */

export type ReceivableStatus = "unpaid" | "partial" | "paid";

export const RECEIVABLE_STATUS_LABEL: Record<ReceivableStatus, string> = {
  unpaid: "未收",
  partial: "部分收款",
  paid: "已收清",
};

/** 应收行（只声明前端真正用到的键；其余键透传保留） */
export interface ReceivableRow {
  id: number;
  order_id: number | null;
  currency: string;
  total_amount: number | null;
  received_amount: number | null;
  base_currency?: string | null;
  base_amount?: number | null;
  exchange_gain_loss?: number | null;
  status: ReceivableStatus | string;
  created_at?: string | null;
  order_no?: string | null;
  customer_name?: string | null;
  [key: string]: unknown;
}

export interface ReceivablePage {
  items: ReceivableRow[];
  total: number;
  page: number;
  page_size: number;
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function num(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** 未收 = 应收总额 − 已收（**不夹负**以外不修正：多收要看得见，故允许 0 下限但单独标记） */
export function outstandingOf(row: ReceivableRow): number {
  return round2(Math.max(0, num(row.total_amount) - num(row.received_amount)));
}

/** 已收金额（应收行里可能为 0/null） */
export function receivedOf(row: ReceivableRow): number {
  return round2(num(row.received_amount));
}

/** 应收总额（null → 0；展示层需要区分"没有金额"时看原始字段） */
export function totalOf(row: ReceivableRow): number {
  return round2(num(row.total_amount));
}

export interface CurrencyTotals {
  currency: string;
  total: number;
  received: number;
  outstanding: number;
  count: number;
}

export interface ReceivablesSummary {
  /** 行数（窗口内） */
  count: number;
  /** 按币种汇总（应收金额不能跨币种相加 —— 硬加会得出无意义数字） */
  byCurrency: CurrencyTotals[];
  /** 各状态行数（未收/部分/已收清） */
  byStatus: Record<string, number>;
}

/**
 * 汇总：**按币种分组**，不做跨币种总和。
 *
 * 为什么不加一个"折人民币总额"：应收行只有 `base_amount`（本币应收总额）与
 * `fx_rate`，已收金额没有对应的本币折算字段 ⇒ 硬折算"已收人民币"会引入新假设。
 * 需要跨币种视图时应由后端返回折算口径（`exchange_gain_loss` 已表明这层归后端）。
 */
export function summarizeReceivables(
  items: readonly ReceivableRow[],
): ReceivablesSummary {
  const map = new Map<string, CurrencyTotals>();
  const byStatus: Record<string, number> = {};
  for (const row of items) {
    const currency = (row.currency || "—").toUpperCase();
    const entry =
      map.get(currency) ??
      { currency, total: 0, received: 0, outstanding: 0, count: 0 };
    entry.total = round2(entry.total + totalOf(row));
    entry.received = round2(entry.received + receivedOf(row));
    entry.outstanding = round2(entry.outstanding + outstandingOf(row));
    entry.count += 1;
    map.set(currency, entry);
    const status = String(row.status ?? "unknown");
    byStatus[status] = (byStatus[status] ?? 0) + 1;
  }
  return {
    count: items.length,
    byCurrency: [...map.values()].sort((a, b) => a.currency.localeCompare(b.currency)),
    byStatus,
  };
}

/** 只保留日期部分（`2026-10-01` / `2026-10-01T02:00:00Z` 都能解析） */
function parseDateOnly(value: string | null | undefined): Date | null {
  if (!value) return null;
  const text = String(value);
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (!match) return null;
  const [, y, m, d] = match;
  const date = new Date(Number(y), Number(m) - 1, Number(d));
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * 逾期天数（从到期日到"今天"的整天数）；未到期/无到期日 → 0。
 *
 * 用**本地日期**比较（到期日是 date 型，无时区语义）；`today` 可注入便于测试。
 */
export function overdueDays(
  dueDate: string | null | undefined,
  today: Date = new Date(),
): number {
  const due = parseDateOnly(dueDate);
  if (!due) return 0;
  const todayMidnight = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const diffMs = todayMidnight.getTime() - due.getTime();
  const days = Math.floor(diffMs / 86_400_000);
  return days > 0 ? days : 0;
}

/**
 * 行是否逾期：**未收清** 且 最早未付到期日已过。
 *
 * `earliestUnpaidDue` 为 null（该订单没有未付计划 / 尚未取到）时返回 false ——
 * **不能**把"不知道到期日"当成"逾期"，也不能反过来当成"不逾期"去宣称已核销；
 * 所以表格对它的展示是「—」，不是绿色。
 */
export function isOverdue(
  row: ReceivableRow,
  earliestUnpaidDue: string | null | undefined,
  today: Date = new Date(),
): boolean {
  if (String(row.status) === "paid") return false;
  return overdueDays(earliestUnpaidDue, today) > 0;
}

export interface ReceivableFilters {
  status: ReceivableStatus | "all";
  /** 客户名（模糊，前端在已加载数据内过滤） */
  customer: string;
  onlyOverdue: boolean;
}

/**
 * 前端筛选（客户名 / 只看逾期）。
 *
 * ⚠️ 后端 `GET /receivables` **不支持**客户与逾期参数 ⇒ 这两项只能作用于
 * **已加载的数据**。页面必须在界面上写明范围，不能让它看起来像全量筛选。
 */
export function filterReceivables(
  items: readonly ReceivableRow[],
  filters: ReceivableFilters,
  dueByOrder: Readonly<Record<number, string | null | undefined>>,
  today: Date = new Date(),
): ReceivableRow[] {
  const customer = filters.customer.trim().toLowerCase();
  return items.filter((row) => {
    if (filters.status !== "all" && String(row.status) !== filters.status) return false;
    if (customer) {
      const name = String(row.customer_name ?? "").toLowerCase();
      const no = String(row.order_no ?? "").toLowerCase();
      if (!name.includes(customer) && !no.includes(customer)) return false;
    }
    if (filters.onlyOverdue) {
      const orderId = Number(row.order_id);
      const due = Number.isFinite(orderId) ? dueByOrder[orderId] : null;
      if (!isOverdue(row, due, today)) return false;
    }
    return true;
  });
}
