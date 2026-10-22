/**
 * 订单明细变更审批的纯逻辑（设计 §6.1）：待批提取、差异对比、编辑模式。
 * 差异对比是审批横幅与审批中心共用的事实来源 —— 配错行会让审批人批错东西。
 */
import { describe, expect, it } from "vitest";

import {
  changeRequestStatusLabel,
  changeRequestStatusTone,
  diffOrderItems,
  itemDiffProductName,
  itemDiffSummary,
  itemDiffSummaryText,
  orderItemsEditHint,
  orderItemsEditMode,
  pendingChangeRequest,
  sortChangeRequests,
  type OrderItemChangeRequest,
} from "../item-change";
import type { OrderItem } from "../order-detail";

function item(name: string, qty: number, price: number): OrderItem {
  return {
    product_name: name,
    spec_snapshot: { specification: "2.5mm" },
    qty,
    qty_unit: "ROLLS",
    unit_price: price,
    line_amount: Math.round(qty * price * 100) / 100,
  };
}

function request(
  id: number,
  status: string,
  createdAt: string,
): OrderItemChangeRequest {
  return {
    id,
    order_id: 1,
    requested_by: 3,
    reason: "客户追加",
    items: [],
    snapshot: [],
    status,
    created_at: createdAt,
  };
}

describe("待批申请与历史", () => {
  it("取唯一 pending；没有则 null", () => {
    const rows = [
      request(1, "approved", "2026-10-20T00:00:00Z"),
      request(2, "pending", "2026-10-21T00:00:00Z"),
    ];
    expect(pendingChangeRequest(rows)?.id).toBe(2);
    expect(pendingChangeRequest([request(1, "rejected", "x")])).toBeNull();
    expect(pendingChangeRequest(null)).toBeNull();
  });

  it("历史按时间倒序（同时间按 id 倒序）", () => {
    const sorted = sortChangeRequests([
      request(1, "approved", "2026-10-20T00:00:00Z"),
      request(3, "pending", "2026-10-22T00:00:00Z"),
      request(2, "rejected", "2026-10-21T00:00:00Z"),
    ]);
    expect(sorted.map((row) => row.id)).toEqual([3, 2, 1]);
  });

  it("状态文案/色标", () => {
    expect(changeRequestStatusLabel("pending")).toBe("待审批");
    expect(changeRequestStatusLabel("approved")).toBe("已批准");
    expect(changeRequestStatusLabel("rejected")).toBe("已拒绝");
    expect(changeRequestStatusLabel(null)).toBe("—");
    expect(changeRequestStatusTone("approved")).toBe("success");
    expect(changeRequestStatusTone("rejected")).toBe("danger");
    expect(changeRequestStatusTone("pending")).toBe("warning");
  });
});

describe("编辑模式", () => {
  it("pending 直改；confirmed 及以后走审批", () => {
    expect(orderItemsEditMode("pending")).toBe("direct");
    expect(orderItemsEditMode("confirmed")).toBe("approval");
    expect(orderItemsEditMode("producing")).toBe("approval");
    expect(orderItemsEditMode(null)).toBe("approval");
    expect(orderItemsEditHint("direct")).toContain("立即生效");
    expect(orderItemsEditHint("approval")).toContain("管理员批准");
  });
});

describe("新旧明细对比", () => {
  it("新增 / 修改 / 删除 / 未变 全部分类正确", () => {
    const before = [item("勾花网", 10, 100), item("护栏网", 5, 20)];
    const after = [item("勾花网", 12, 100), item("电焊网", 3, 30)];
    const rows = diffOrderItems(before, after);
    expect(rows.map((row) => [itemDiffProductName(row), row.kind])).toEqual([
      ["勾花网", "changed"],
      ["电焊网", "added"],
      ["护栏网", "removed"],
    ]);
    const changed = rows[0]!;
    expect(changed.changes.map((c) => c.label)).toEqual(["数量", "行金额"]);
    expect(changed.changes[0]?.before).toBe("10");
    expect(changed.changes[0]?.after).toBe("12");
  });

  it("完全一致 ⇒ 没有可展示的变更项", () => {
    const before = [item("勾花网", 10, 100)];
    const rows = diffOrderItems(before, [item("勾花网", 10, 100)]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("unchanged");
    expect(itemDiffSummaryText(rows)).toBe("明细未变");
  });

  it("产品改名显示为「删除旧行 + 新增新行」（不静默配对错行）", () => {
    const rows = diffOrderItems(
      [item("勾花网", 10, 100)],
      [item("护栏网", 10, 100)],
    );
    expect(itemDiffSummary(rows)).toEqual({
      added: 1,
      removed: 1,
      changed: 0,
      unchanged: 0,
    });
  });

  it("空历史（老数据没有 snapshot）也不崩", () => {
    expect(diffOrderItems(null, [item("勾花网", 1, 1)])[0]?.kind).toBe("added");
    expect(itemDiffSummaryText(diffOrderItems(undefined, undefined))).toBe(
      "明细未变",
    );
  });
});
