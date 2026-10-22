import { describe, expect, it } from "vitest";

import {
  changeStatusMeta,
  formatDate,
  formatDateTime,
  formatMoney,
  formatQuantity,
  lineProductName,
  lineSpecText,
  orderStatusLabel,
  orderStatusTone,
} from "../format";

describe("审批中心展示格式化", () => {
  it("变更状态：三种状态有中文文案 + 语义色板，未知状态原样显示", () => {
    expect(changeStatusMeta("pending")).toEqual({
      label: "待审批",
      tone: "warning",
    });
    expect(changeStatusMeta("approved")).toEqual({
      label: "已批准",
      tone: "success",
    });
    expect(changeStatusMeta("rejected")).toEqual({
      label: "已拒绝",
      tone: "danger",
    });
    expect(changeStatusMeta("archived")).toEqual({
      label: "archived",
      tone: "default",
    });
    expect(changeStatusMeta("")).toEqual({
      label: "未知状态",
      tone: "default",
    });
  });

  it("订单状态文案/色板（未知状态原样显示，null 显示占位）", () => {
    expect(orderStatusLabel("confirmed")).toBe("已确认");
    expect(orderStatusLabel("weird")).toBe("weird");
    expect(orderStatusLabel(null)).toBe("—");
    expect(orderStatusTone("completed")).toBe("success");
    expect(orderStatusTone("cancelled")).toBe("danger");
    expect(orderStatusTone("pending")).toBe("warning");
    expect(orderStatusTone(null)).toBe("default");
  });

  it("时间：按字符串截取（不换算时区），非法值 → 占位", () => {
    expect(formatDate("2026-10-22T13:45:09+08:00")).toBe("2026-10-22");
    expect(formatDate(null)).toBe("—");
    expect(formatDate("not-a-date")).toBe("—");
    expect(formatDateTime("2026-10-22T13:45:09+08:00")).toBe(
      "2026-10-22 13:45",
    );
    expect(formatDateTime("2026-10-22")).toBe("2026-10-22");
    expect(formatDateTime(null)).toBe("—");
  });

  it("金额：两位小数 + 千分位 + 币种；缺值 → 占位", () => {
    expect(formatMoney(1234.5, "USD")).toBe("USD 1,234.50");
    expect(formatMoney(0, null)).toBe("0.00");
    expect(formatMoney(null, "USD")).toBe("—");
    expect(formatMoney(Number.NaN, "USD")).toBe("—");
  });

  it("数量：最多 4 位小数，单位可选", () => {
    expect(formatQuantity(12, "卷")).toBe("12 卷");
    expect(formatQuantity(1.23456, null)).toBe("1.2346");
    expect(formatQuantity(null, "卷")).toBe("—");
  });

  it("货物名：品名 → SKU → 占位", () => {
    expect(lineProductName({ product_name: " 镀锌丝网 " })).toBe("镀锌丝网");
    expect(lineProductName({ product_name: null, sku_id: 7 })).toBe("SKU #7");
    expect(lineProductName({})).toBe("未填写货物");
    expect(lineProductName(null)).toBe("未填写货物");
  });

  it("规格摘要：字符串直出 / specification 优先 / 其余键拼接 / 空", () => {
    expect(lineSpecText({ spec_snapshot: " 1.8m x 30m " })).toBe("1.8m x 30m");
    expect(
      lineSpecText({
        spec_snapshot: { specification: "热镀锌", mesh: "50x50" },
      }),
    ).toBe("热镀锌");
    expect(
      lineSpecText({ spec_snapshot: { mesh: "50x50", width: "1.8m" } }),
    ).toBe("mesh: 50x50 · width: 1.8m");
    expect(lineSpecText({ spec_snapshot: null })).toBe("");
    expect(lineSpecText(null)).toBe("");
  });
});
