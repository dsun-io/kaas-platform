/**
 * 加入申请纯函数（2026-10-22）：状态文案、待审判定、筛选项标签。
 *
 * 这些是面板与"我的申请"卡片的判定依据，口径必须与后端
 * kaas_common/workstation/teams.py:can_transition_application 一致：
 * 只有 pending 能审/撤，approved/rejected/canceled 都是终态。
 */
import { describe, expect, it } from "vitest";

import {
  APPLICATION_FILTERS,
  APPLICATION_STATUS_TEXT,
  applicationFilterLabel,
  isApplicationPending,
  JOIN_APPLICATION_STATUS,
} from "../join-applications";

describe("JOIN_APPLICATION_STATUS", () => {
  it("四个状态与后端一致（pending/approved/rejected/canceled）", () => {
    expect([...JOIN_APPLICATION_STATUS]).toEqual([
      "pending",
      "approved",
      "rejected",
      "canceled",
    ]);
  });

  it("每个状态都有中文文案（面板不会露出英文原值）", () => {
    for (const status of JOIN_APPLICATION_STATUS) {
      expect(APPLICATION_STATUS_TEXT[status]).toMatch(/[\u4e00-\u9fa5]/);
    }
  });
});

describe("isApplicationPending", () => {
  it("只有 pending 为真", () => {
    expect(isApplicationPending("pending")).toBe(true);
    expect(isApplicationPending("approved")).toBe(false);
    expect(isApplicationPending("rejected")).toBe(false);
    expect(isApplicationPending("canceled")).toBe(false);
  });

  it("缺值/异常值按不可操作处理（不误放行审核按钮）", () => {
    expect(isApplicationPending(null)).toBe(false);
    expect(isApplicationPending(undefined)).toBe(false);
    expect(isApplicationPending("bogus")).toBe(false);
  });
});

describe("筛选项", () => {
  it("包含 all 与四个状态", () => {
    expect([...APPLICATION_FILTERS]).toEqual([
      "pending",
      "approved",
      "rejected",
      "canceled",
      "all",
    ]);
  });

  it("标签中文：all → 全部，其余复用状态文案", () => {
    expect(applicationFilterLabel("all")).toBe("全部");
    expect(applicationFilterLabel("pending")).toBe("待审核");
    expect(applicationFilterLabel("rejected")).toBe("已驳回");
  });
});
