/**
 * 订单状态机纯逻辑（C36 下期 #21）。
 *
 * 钉住：目标状态表与后端 `ORDER_NEXT` 一致、终态无可选目标、
 * 二次确认说明包含后端副作用、409 `ILLEGAL_TRANSITION` 给出"允许的目标"中文。
 */
import { describe, expect, it } from "vitest";

import {
  ORDER_STATUS_LABEL,
  nextOrderStatuses,
  orderStatusErrorText,
  orderTransitionNote,
} from "../order-status";

describe("nextOrderStatuses", () => {
  it("各状态的合法目标与后端 ORDER_NEXT 一致", () => {
    expect(nextOrderStatuses("pending")).toEqual(["confirmed", "cancelled"]);
    expect(nextOrderStatuses("confirmed")).toEqual(["producing", "cancelled"]);
    expect(nextOrderStatuses("producing")).toEqual(["shipped"]);
    expect(nextOrderStatuses("shipped")).toEqual(["completed"]);
    // 终态没有出口
    expect(nextOrderStatuses("completed")).toEqual([]);
    expect(nextOrderStatuses("cancelled")).toEqual([]);
    expect(nextOrderStatuses("unknown")).toEqual([]);
  });
});

describe("orderTransitionNote", () => {
  it("关键流转说明后端副作用（不是「只改个字段」）", () => {
    expect(orderTransitionNote("pending", "confirmed")).toContain("应收");
    expect(orderTransitionNote("pending", "confirmed")).toContain("汇率");
    expect(orderTransitionNote("producing", "shipped")).toContain("order.shipped");
    expect(orderTransitionNote("shipped", "completed")).toContain("询盘");
    expect(orderTransitionNote("pending", "cancelled")).toContain("不可撤销");
  });
});

describe("orderStatusErrorText", () => {
  it("409 ILLEGAL_TRANSITION：带 from/to 与允许目标的中文", () => {
    const error = Object.assign(new Error("Conflict"), {
      response: {
        status: 409,
        data: {
          detail: {
            error: "conflict",
            code: "ILLEGAL_TRANSITION",
            field: "status",
            from: "pending",
            to: "shipped",
            allowed: ["confirmed", "cancelled"],
          },
        },
      },
    });
    const text = orderStatusErrorText(error);
    expect(text).toContain("待确认");
    expect(text).toContain("已出运");
    expect(text).toContain("允许：已确认 / 已取消");
  });

  it("422 后端文案原样透出；非业务错误退回通用文案", () => {
    expect(
      orderStatusErrorText(
        Object.assign(new Error("Unprocessable"), {
          response: {
            status: 422,
            data: {
              detail: {
                error: "validation",
                code: "STATUS_REQUIRED",
                detail: "缺少目标状态 status",
              },
            },
          },
        }),
      ),
    ).toBe("缺少目标状态 status");
    expect(orderStatusErrorText(new Error("boom"))).toBe("boom");
    expect(ORDER_STATUS_LABEL.confirmed).toBe("已确认");
  });
});
