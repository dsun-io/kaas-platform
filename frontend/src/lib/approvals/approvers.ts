/**
 * 指定审批人（D-11 / D-14）的纯函数：名单归一化 / 切换 / 提交前校验。
 *
 * 后端语义（真源 `ws_approvals.py:replace_team_approvers`）：
 *  - 整表替换（`PUT /team/approvers {user_ids: [...]}`），不是增删单条；
 *  - 空数组 = 不指定 → 回落到团队管理员审批（**合法状态，不是错误**）；
 *  - 名单里必须是**本团队成员**，否则 422 `APPROVER_NOT_IN_TEAM`。
 * 前端做同一口径的预检，减少一次必然失败的请求；最终裁决仍在后端。
 */
import type { TeamApprover } from "./types";

/** 响应 items → user_id 升序去重数组（与后端 ORDER BY user_id 同序，便于脏检查）。 */
export function normalizeApproverIds(
  items: readonly TeamApprover[] | null | undefined,
): number[] {
  const ids: number[] = [];
  for (const item of items ?? []) {
    const id = Number(item.user_id);
    if (Number.isInteger(id) && id > 0 && !ids.includes(id)) ids.push(id);
  }
  return ids.sort((a, b) => a - b);
}

/** 勾选/取消一个审批人（返回新数组，不原地改 state）。 */
export function toggleApproverId(
  ids: readonly number[],
  userId: number,
): number[] {
  const next = ids.filter((id) => id !== userId);
  if (next.length === ids.length) next.push(userId);
  return next.sort((a, b) => a - b);
}

/** 提交前校验：空名单合法；非空时每个 id 都必须是本团队成员。 */
export function validateApproverSelection(
  selectedIds: readonly number[],
  memberIds: readonly number[],
): string | null {
  if (selectedIds.length === 0) return null;
  const members = new Set(memberIds.map((id) => Number(id)));
  const outside = selectedIds.filter((id) => !members.has(id));
  if (outside.length === 0) return null;
  return `指定审批人必须是本团队成员（不在团队内：#${outside.join("、#")}）`;
}

/** 是否与已保存名单一致（保存按钮据此禁用）。 */
export function isApproverSelectionDirty(
  selectedIds: readonly number[],
  savedIds: readonly number[],
): boolean {
  if (selectedIds.length !== savedIds.length) return true;
  const saved = new Set(savedIds);
  return selectedIds.some((id) => !saved.has(id));
}

/** 空名单时谁来审批（`fallback` 字段：team_admins / tenant_admins）。 */
export function approverFallbackText(
  fallback: string | null | undefined,
): string {
  if (fallback === "tenant_admins") {
    return "当前账号未加入团队：未指定审批人时由租户管理员审批。";
  }
  return "未指定审批人时：由团队管理员审批（管理员始终可兜底介入）。";
}
