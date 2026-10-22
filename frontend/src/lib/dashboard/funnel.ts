/**
 * 商机漏斗纯函数（M3，设计 §7 / D-6）。
 *
 * 契约真源：`GET /api/v1/dashboard/funnel`（`backend/worker/src/main.py:dashboard_funnel`，
 * 统计规则在 `backend/kaas_common/workstation/funnel.py`）。
 *
 * 本文件**只做展示层格式化**——转化率、综合分、排序全部由 Python 内核算好，
 * 前端不重算业务口径（AGENTS「业务规则只在 Python 内核一处实现」）。
 */
import { CHANNEL_LABEL } from "@/lib/inquiries/format";

/** 时间范围（与内核 `since_map` 逐字一致，见 `main.py:dashboard_funnel`）。 */
export const DASHBOARD_RANGES = [
  { value: "today", label: "今日" },
  { value: "7d", label: "近 7 天" },
  { value: "30d", label: "近 30 天" },
  { value: "90d", label: "近 90 天" },
] as const;

export type DashboardRange = (typeof DASHBOARD_RANGES)[number]["value"];

export const DASHBOARD_DEFAULT_RANGE: DashboardRange = "today";

/**
 * 只接受内核支持的四个值；非法值回默认「今日」。
 * 作用：页面/深链传入任意字符串时，请求参数不会变成后端不认识的枚举。
 */
export function normalizeDashboardRange(raw: string): DashboardRange {
  const hit = DASHBOARD_RANGES.find((range) => range.value === raw);
  return hit ? hit.value : DASHBOARD_DEFAULT_RANGE;
}

/**
 * 渠道中文标签。
 *
 * **不在这里另立一份映射**：真源是 `lib/inquiries/format.ts:CHANNEL_LABEL`
 * （M2 已按 `kaas_common/domain/enums.INQUIRY_CHANNEL` 建好，含 2026-10-22 新增的
 * phone / referral）。dashboard 只是复用，避免两页对同一渠道出现两种叫法。
 * 未知值**原样显示**（不吞成「其他」）：新渠道上线后页面仍能看到是哪个渠道。
 */
export function channelLabel(channel: string): string {
  const key = channel.trim();
  if (!key) return CHANNEL_LABEL.other ?? "其他";
  return CHANNEL_LABEL[key] ?? key;
}

/**
 * 转化率格式化：后端回 `null` = 分母为 0（该时间窗/该渠道没有上一阶段数据），
 * 显示「—」。**不把 null 渲染成 0%** ——「无法计算」和「转化率为零」是两件事。
 */
export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "—";
  }
  // 后端已 round(..., 2)；这里再夹一层，防浮点尾巴（如 41.669999）
  return `${String(Math.round(value * 100) / 100)}%`;
}

/**
 * 金额格式化（原币种数值，不猜币种符号）。
 * 千分位 + 固定两位小数；null / 非数字 → 「—」。
 * 不用 Intl：CI/容器 locale 数据不保证完整，纯字符串实现结果确定。
 */
export function formatAmount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "—";
  }
  const sign = value < 0 ? "-" : "";
  const [integer, fraction] = Math.abs(value).toFixed(2).split(".");
  const grouped = (integer ?? "0").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}${grouped}.${fraction ?? "00"}`;
}

/**
 * 漏斗条宽度（相对首阶段 = 询盘数）的百分比。
 * 首阶段恒为 100；其余阶段按 count / baseCount 缩放，四舍五入后夹在 0–100。
 * baseCount 为 0（没有询盘）→ 0，不是 NaN。
 */
export function stageBarWidthPercent(count: number, baseCount: number): number {
  if (!Number.isFinite(count) || !Number.isFinite(baseCount)) return 0;
  if (baseCount <= 0 || count <= 0) return 0;
  const percent = Math.round((count / baseCount) * 100);
  return Math.min(100, Math.max(0, percent));
}

/**
 * 渠道行按综合商机分降序（与后端口径一致；后端已排序，前端再排一次是防
 * 「接口顺序变了页面顺序跟着漂」）。同分时按渠道码升序，保证渲染稳定。
 */
export function sortChannelsByScore<
  T extends { channel: string; composite_score: number },
>(channels: readonly T[]): T[] {
  return [...channels].sort(
    (a, b) =>
      b.composite_score - a.composite_score ||
      a.channel.localeCompare(b.channel),
  );
}

/**
 * 该时间窗是否**完全没有询盘**（四阶段计数全为 0）。
 * 注意：直接下单不进漏斗 —— 漏斗为空不代表页面没有数据，直接下单卡仍要照常显示。
 */
export function isEmptyFunnel(
  funnel: { stages: ReadonlyArray<{ count: number }> } | null | undefined,
): boolean {
  if (!funnel || funnel.stages.length === 0) return true;
  return funnel.stages.every((stage) => stage.count === 0);
}
