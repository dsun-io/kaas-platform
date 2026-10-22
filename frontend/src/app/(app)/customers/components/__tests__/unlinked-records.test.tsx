/**
 * 客户详情 · 直接下单区块（设计 §9.4）。
 *
 * 语义从「未关联询盘的单据（异常兜底）」改为「直接下单（正常分类）」：
 *   · 标题明确「直接下单（正常分类）」，不再出现「未关联单据」的异常暗示；
 *   · 默认展开（常规分类不该藏在折叠条里）；
 *   · 订单带来源徽标与渠道标签（渠道未知不伪造）。
 */
import { afterEach, describe, expect, it } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

import { UnlinkedRecords } from "../inquiry-followups";
import type { CustomerRecordsDirect } from "@/lib/customer/customer-records";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function mount(element: ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(element));
}

function direct(
  overrides: Partial<CustomerRecordsDirect> = {},
): CustomerRecordsDirect {
  return {
    orders: [
      {
        id: 1,
        order_no: "ORD-1",
        status: "confirmed",
        currency: "USD",
        total_amount: 1000,
        created_at: "2026-10-01T00:00:00Z",
        source_type: "direct",
        source_channel: "phone",
        documents: [],
      },
      {
        id: 2,
        order_no: "ORD-2",
        status: "pending",
        currency: "USD",
        total_amount: 500,
        created_at: "2026-10-02T00:00:00Z",
        source_type: "direct",
        source_channel: null,
        documents: [],
      },
    ],
    documents: [],
    ...overrides,
  };
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  document.body.innerHTML = "";
  root = null;
  container = null;
});

describe("UnlinkedRecords（直接下单分类）", () => {
  it("标题是「直接下单（正常分类）」且默认展开", () => {
    mount(
      <UnlinkedRecords
        quotes={[]}
        direct={direct()}
        loading={false}
        unavailable={false}
      />,
    );
    const details = container!.querySelector("details");
    expect(details).not.toBeNull();
    expect(details!.open).toBe(true);
    const text = container!.textContent ?? "";
    expect(text).toContain("直接下单（正常分类）");
    expect(text).not.toContain("未关联询盘的单据");
    expect(text).not.toContain("异常");
  });

  it("订单带「直接下单」徽标与渠道标签；渠道未知不伪造", () => {
    mount(
      <UnlinkedRecords
        quotes={[]}
        direct={direct()}
        loading={false}
        unavailable={false}
      />,
    );
    const rows = Array.from(container!.querySelectorAll("div")).filter((el) =>
      (el.textContent ?? "").includes("ORD-1"),
    );
    const row = rows[rows.length - 1]!;
    expect(row.textContent).toContain("直接下单");
    expect(row.textContent).toContain("电话");

    const row2 = Array.from(container!.querySelectorAll("div")).filter((el) =>
      (el.textContent ?? "").includes("ORD-2"),
    )[0]!;
    expect(row2.textContent).toContain("直接下单");
    expect(row2.textContent).not.toContain("其他");
  });

  it("没有任何单据时不渲染整块（空态由上层页面处理）", () => {
    mount(
      <UnlinkedRecords
        quotes={[]}
        direct={{ orders: [], documents: [] }}
        loading={false}
        unavailable={false}
      />,
    );
    expect(container!.querySelector("details")).toBeNull();
  });

  it("读取中/读取失败都有明确文案（不假装没有数据）", () => {
    mount(
      <UnlinkedRecords
        quotes={[]}
        direct={direct()}
        loading={true}
        unavailable={false}
      />,
    );
    expect(container!.textContent).toContain("读取中…");

    if (root) act(() => root!.unmount());
    container?.remove();
    mount(
      <UnlinkedRecords
        quotes={[]}
        direct={direct()}
        loading={false}
        unavailable={true}
      />,
    );
    expect(container!.textContent).toContain("暂时读不到");
  });
});
