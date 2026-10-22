import { describe, expect, it } from "vitest";

import {
  approverFallbackText,
  isApproverSelectionDirty,
  normalizeApproverIds,
  toggleApproverId,
  validateApproverSelection,
} from "../approvers";
import type { TeamApprover } from "../types";

function approver(userId: number): TeamApprover {
  return {
    user_id: userId,
    display_name: `用户 ${userId}`,
    email: null,
    created_by: 1,
    created_at: null,
  };
}

describe("指定审批人", () => {
  it("名单归一化：去重、升序、丢弃非法 user_id", () => {
    expect(
      normalizeApproverIds([
        approver(3),
        approver(1),
        approver(3),
        approver(0),
        approver(-2),
      ]),
    ).toEqual([1, 3]);
    expect(normalizeApproverIds(null)).toEqual([]);
  });

  it("勾选/取消返回新数组且保持升序", () => {
    expect(toggleApproverId([], 5)).toEqual([5]);
    expect(toggleApproverId([5], 3)).toEqual([3, 5]);
    expect(toggleApproverId([3, 5], 3)).toEqual([5]);
  });

  it("提交前校验：空名单合法；非成员 422 同口径提示", () => {
    expect(validateApproverSelection([], [1, 2])).toBeNull();
    expect(validateApproverSelection([1, 2], [1, 2])).toBeNull();
    expect(validateApproverSelection([1, 9], [1, 2])).toContain("#9");
    expect(validateApproverSelection([1, 9], [1, 2])).toContain("本团队成员");
  });

  it("脏检查：顺序无关，仅内容变化才算脏", () => {
    expect(isApproverSelectionDirty([2, 1], [1, 2])).toBe(false);
    expect(isApproverSelectionDirty([1], [1, 2])).toBe(true);
    expect(isApproverSelectionDirty([], [1])).toBe(true);
    expect(isApproverSelectionDirty([1, 3], [1, 2])).toBe(true);
  });

  it("空名单回退文案区分团队管理员 / 租户管理员", () => {
    expect(approverFallbackText("team_admins")).toContain("团队管理员");
    expect(approverFallbackText("tenant_admins")).toContain("租户管理员");
    expect(approverFallbackText(null)).toContain("团队管理员");
  });
});
