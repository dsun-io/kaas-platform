/**
 * 团队加入申请（纯函数 + 类型）—— 2026-10-22 新增模块。
 *
 * 场景：注册时团队名已存在，用户不凭邀请码、直接向该团队发起加入申请；
 * 团队管理员在「团队管理 → 加入申请」里审核（通过入团 / 驳回可再申请 / 申请人可撤回）。
 *
 * 状态机与后端共享内核同口径（kaas_common/workstation/teams.py）：
 *   pending ─approve─► approved（终态）
 *   pending ─reject──► rejected（终态，可再次申请）
 *   pending ─cancel──► canceled（终态，申请人撤回，可再次申请）
 */

/** 申请状态（后端 team_join_applications.status）。 */
export const JOIN_APPLICATION_STATUS = [
  "pending",
  "approved",
  "rejected",
  "canceled",
] as const;

export type JoinApplicationStatus = (typeof JOIN_APPLICATION_STATUS)[number];

export interface JoinApplication {
  id: number;
  team_id: number;
  team_name: string | null;
  user_id: number;
  email: string;
  display_name: string;
  message: string | null;
  status: JoinApplicationStatus;
  reject_reason: string | null;
  reviewed_by: number | null;
  reviewed_at: string | null;
  created_at: string | null;
}

/** 申请状态 → 中文（管理员列表 / 申请人"我的申请"共用）。 */
export const APPLICATION_STATUS_TEXT: Record<JoinApplicationStatus, string> = {
  pending: "待审核",
  approved: "已通过",
  rejected: "已驳回",
  canceled: "已撤回",
};

/** 是否待审核（只有 pending 能 通过/驳回/撤回）。 */
export function isApplicationPending(
  status: string | null | undefined,
): status is JoinApplicationStatus {
  return status === "pending";
}

/** 列表筛选：pending 看默认待审；all 看全部；其余合法状态名按状态过滤。 */
export const APPLICATION_FILTERS = [
  "pending",
  "approved",
  "rejected",
  "canceled",
  "all",
] as const;
export type ApplicationFilter = (typeof APPLICATION_FILTERS)[number];

export function applicationFilterLabel(filter: ApplicationFilter): string {
  if (filter === "all") return "全部";
  return APPLICATION_STATUS_TEXT[filter] ?? filter;
}
