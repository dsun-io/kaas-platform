/**
 * 应收概览展示纯函数（P0-A A3）。
 *
 * 聚合口径真源 = 内核 `backend/kaas_common/workstation/receivable_summary.py`
 * （`GET /api/v1/dashboard/receivables` 直接返回该结构）；前端**不重算金额**，
 * 这里只做：状态中文标签、状态固定顺序、空态判定。
 *
 * 金额规则（与内核同一句）：**只在同币种内相加**；跨币种合计需要折算口径，
 * 页面不得自己把不同币种加起来（`lib/receivables/summary.ts` 已定调）。
 */
import {
  RECEIVABLE_STATUS_LABEL,
  type ReceivableStatus,
} from "@/lib/receivables/summary";

/** 状态展示固定顺序（迁移枚举 unpaid/partial/paid；未知状态排最后）。 */
export const RECEIVABLE_STATUS_ORDER = ["unpaid", "partial", "paid"] as const;

/** 状态 → 中文标签；未知状态原样显示（不吞成「其他」）。 */
export function receivableStatusLabel(status: string): string {
  return RECEIVABLE_STATUS_LABEL[status as ReceivableStatus] ?? status;
}

function statusRank(status: string): number {
  const index = RECEIVABLE_STATUS_ORDER.indexOf(
    status as (typeof RECEIVABLE_STATUS_ORDER)[number],
  );
  return index === -1 ? RECEIVABLE_STATUS_ORDER.length : index;
}

/**
 * 状态摘要排序：unpaid / partial / paid 固定顺序，未知状态随后按字典序
 * （与内核 `summarize_receivables` 的 ordered_statuses 同口径；前端重排保证
 * 渲染确定，不依赖接口返回顺序）。
 */
export function sortReceivableStatuses<T extends { status: string }>(
  items: readonly T[],
): T[] {
  return [...items].sort(
    (a, b) =>
      statusRank(a.status) - statusRank(b.status) ||
      a.status.localeCompare(b.status),
  );
}

/**
 * 空态 = 时间窗内没有应收行。
 * `totals.count` 是**行数**（唯一可跨币种/跨状态相加的计数），
 * 不能用金额之和为 0 判空（真有可能应收金额全是 0 的行）。
 */
export function isEmptyReceivables(
  summary: { totals?: { count?: number } } | null | undefined,
): boolean {
  return !summary || (summary.totals?.count ?? 0) <= 0;
}
