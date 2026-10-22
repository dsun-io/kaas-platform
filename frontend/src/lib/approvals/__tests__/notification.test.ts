import { describe, expect, it } from "vitest";

import {
  formatUnreadBadge,
  isApprovalNotification,
  isSafeInternalLink,
  notificationMeta,
  resolveNotificationLink,
} from "../notification";

describe("站内通知", () => {
  it("内核词汇与 mock 词汇都能识别为审批通知（含文案/色板）", () => {
    expect(notificationMeta("approval_requested")).toEqual({
      label: "待审批",
      tone: "warning",
    });
    expect(notificationMeta("approval_approved")).toEqual({
      label: "已批准",
      tone: "success",
    });
    expect(notificationMeta("approval_rejected")).toEqual({
      label: "已拒绝",
      tone: "danger",
    });
    expect(notificationMeta("order_item_change_approved")).toEqual({
      label: "已批准",
      tone: "success",
    });
    expect(notificationMeta("system_notice")).toEqual({
      label: "通知",
      tone: "default",
    });
    expect(isApprovalNotification("approval_requested")).toBe(true);
    expect(isApprovalNotification("order_item_change_rejected")).toBe(true);
    expect(isApprovalNotification("system_notice")).toBe(false);
  });

  it("站内链接白名单：拒绝外链 / 协议链接 / 空白", () => {
    expect(isSafeInternalLink("/approvals?focus=3")).toBe(true);
    expect(isSafeInternalLink("/orders?id=9")).toBe(true);
    expect(isSafeInternalLink("//evil.com")).toBe(false);
    expect(isSafeInternalLink("https://evil.com")).toBe(false);
    expect(isSafeInternalLink("javascript:alert(1)")).toBe(false);
    expect(isSafeInternalLink(" /approvals")).toBe(false);
    expect(isSafeInternalLink(null)).toBe(false);
  });

  it("深链解析：后端 link 优先；缺失/不安全回落 /approvals", () => {
    expect(
      resolveNotificationLink({
        link: "/orders?id=9",
        type: "approval_approved",
      }),
    ).toBe("/orders?id=9");
    expect(
      resolveNotificationLink({
        link: "/approvals?focus=3",
        type: "approval_requested",
      }),
    ).toBe("/approvals?focus=3");
    expect(
      resolveNotificationLink({ link: null, type: "approval_requested" }),
    ).toBe("/approvals");
    expect(
      resolveNotificationLink({
        link: "//evil.com",
        type: "approval_requested",
      }),
    ).toBe("/approvals");
  });

  it("内核的 /orders/{id} 路径归一化为 /orders?id=（订单工位没有 [id] 路由）", () => {
    expect(
      resolveNotificationLink({
        link: "/orders/42",
        type: "approval_approved",
      }),
    ).toBe("/orders?id=42");
    expect(
      resolveNotificationLink({
        link: "/orders/42/",
        type: "approval_rejected",
      }),
    ).toBe("/orders?id=42");
    // 已有 query / 非纯数字路径不动（不猜后端语义）
    expect(
      resolveNotificationLink({
        link: "/orders?id=42",
        type: "approval_approved",
      }),
    ).toBe("/orders?id=42");
    expect(
      resolveNotificationLink({
        link: "/orders/abc",
        type: "approval_approved",
      }),
    ).toBe("/orders/abc");
  });

  it("未读角标：0 不渲染、1–99 数字、>99 折叠 99+、脏值归零", () => {
    expect(formatUnreadBadge(0)).toBe("");
    expect(formatUnreadBadge(null)).toBe("");
    expect(formatUnreadBadge(Number.NaN)).toBe("");
    expect(formatUnreadBadge(7)).toBe("7");
    expect(formatUnreadBadge(99)).toBe("99");
    expect(formatUnreadBadge(100)).toBe("99+");
    expect(formatUnreadBadge(-3)).toBe("");
  });
});
