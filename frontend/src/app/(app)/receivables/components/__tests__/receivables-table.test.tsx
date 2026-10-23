import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { ReceivableRow } from "@/lib/receivables/summary";

import { ReceivablesTable } from "../receivables-table";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const TODAY = new Date(2026, 9, 21); // 2026-10-21

function row(partial: Partial<ReceivableRow>): ReceivableRow {
  return {
    id: 1,
    order_id: 1,
    currency: "USD",
    total_amount: 26450,
    received_amount: 7935,
    status: "partial",
    order_no: "ORD-202609-0001",
    customer_name: "Lone Star Fence Co",
    ...partial,
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function render(
  rows: ReceivableRow[],
  dueByOrder: Record<number, string | null>,
  dueLoading = false,
) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      <ReceivablesTable
        rows={rows}
        dueByOrder={dueByOrder}
        dueLoading={dueLoading}
        today={TODAY}
      />,
    ),
  );
}

function text() {
  return container!.textContent ?? "";
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("ReceivablesTable · 金额与逾期红标", () => {
  it("展示总额/已收/未收与状态中文标签", () => {
    render([row({})], { 1: "2026-10-05" });

    expect(text()).toContain("ORD-202609-0001");
    expect(text()).toContain("Lone Star Fence Co");
    expect(text()).toContain("USD 26,450.00");
    expect(text()).toContain("USD 7,935.00");
    expect(text()).toContain("USD 18,515.00");
    expect(text()).toContain("部分收款");
  });

  it("到期日已过且未收清 ⇒ 逾期 N 天红标（role=alert + 行高亮）", () => {
    render([row({ status: "unpaid", received_amount: 0 })], {
      1: "2026-10-01",
    });

    const alert = container!.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toContain("逾期 20 天");
    expect(alert!.className).toContain("text-destructive");
    expect(container!.querySelector('tr[data-overdue="true"]')).not.toBeNull();
  });

  it("已收清 ⇒ 不标逾期（即使有到期日）", () => {
    render([row({ status: "paid", received_amount: 26450 })], {
      1: "2026-01-01",
    });
    expect(container!.querySelector('[role="alert"]')).toBeNull();
    // 表头有「逾期」列名，这里断言的是没有「逾期 N 天」的判定文案
    expect(text()).not.toMatch(/逾期 \d+ 天/);
  });

  it("没有未付到期日 ⇒ 显示「未知」，既不红也不说未到期", () => {
    render([row({ status: "unpaid" })], { 1: null });
    expect(container!.querySelector('[role="alert"]')).toBeNull();
    expect(text()).toContain("未知");
    expect(text()).not.toContain("未到期");
  });

  it("到期日在未来 ⇒ 显示「未到期」；到期日加载中 ⇒ 占位而不是误判", () => {
    render([row({ status: "unpaid" })], { 1: "2026-12-01" });
    expect(text()).toContain("未到期");
    expect(text()).toContain("2026-12-01");

    act(() => root!.unmount());
    container!.remove();
    root = null;
    container = null;
    render([row({ status: "unpaid" })], {}, true);
    // U-P0C：加载态不再是纯文本「加载中…」（ui:patterns R3），改为
    // 带 aria-label 的骨架占位 —— 语义仍是"读取中"，不能画成「未到期/未知」。
    expect(
      container!.querySelector('[aria-label="到期日加载中"]'),
    ).not.toBeNull();
    expect(text()).not.toContain("未到期");
    expect(container!.querySelector('[role="alert"]')).toBeNull();
  });
});
