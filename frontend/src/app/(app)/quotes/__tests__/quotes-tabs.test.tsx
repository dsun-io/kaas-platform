/**
 * 报价工位 tab 收编（ui/tabs）—— 行为等价回归网。
 *
 * 钉死（收编前的行为，见 quotations.spec.ts 的 tab 按钮文案）：
 * 1. 四个 tab 文案不变：产品报价 / 批量报价 / 报价记录 / 定价数据；
 * 2. ?tab= 深链进入时选中对应 tab；
 * 3. 切换 tab 时 URL 的 ?tab= 同步（product 时清掉）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

import QuotesWorkstationPage from "../page";

// 重组件 mock 掉（本测试只锁 tab 行为，不测业务视图）
vi.mock("../views/quote-workbench-view", () => ({
  QuoteWorkbenchView: () => <div data-testid="workbench">工作台</div>,
}));
vi.mock("../views/quotation-records-view", () => ({
  QuotationRecordsView: () => <div data-testid="records">台账</div>,
}));
vi.mock("../views/batch-quote-view", () => ({
  BatchQuoteView: () => <div data-testid="bulk">批量</div>,
}));
vi.mock("../../pricing-data/pricing-data-manager", () => ({
  PricingDataManager: () => <div data-testid="pricing">成本</div>,
}));
vi.mock("@/lib/events/use-page-view", () => ({
  usePageView: () => undefined,
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function mount(element: ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(element);
  });
}

function unmount() {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
}

async function settle(times = 3) {
  await act(async () => {
    for (let i = 0; i < times; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
  });
}

function clickTab(label: string) {
  const buttons = Array.from(container!.querySelectorAll("button"));
  const target = buttons.find((b) => b.textContent?.trim() === label);
  if (!target) throw new Error(`没找到 tab「${label}」`);
  act(() => {
    target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function setUrlSearch(search: string) {
  window.history.replaceState(null, "", `${window.location.pathname}${search}`);
}

beforeEach(() => {
  setUrlSearch("");
});

afterEach(() => {
  unmount();
  setUrlSearch("");
});

describe("报价工位 tab（收编后行为等价）", () => {
  it("四个 tab 文案不变，产品报价默认选中", async () => {
    mount(<QuotesWorkstationPage />);
    await settle();
    const text = container!.textContent ?? "";
    for (const label of ["产品报价", "批量报价", "报价记录", "定价数据"]) {
      expect(text).toContain(label);
    }
    expect(
      container!.querySelector('[data-testid="workbench"]'),
    ).not.toBeNull();
    expect(container!.querySelector('[data-testid="records"]')).toBeNull();
  });

  it("切到「报价记录」→ 内容切换 + URL 带 ?tab=records", async () => {
    mount(<QuotesWorkstationPage />);
    await settle();
    clickTab("报价记录");
    await settle();
    expect(container!.querySelector('[data-testid="records"]')).not.toBeNull();
    expect(window.location.search).toContain("tab=records");
  });

  it("切回「产品报价」→ URL 清掉 ?tab=（与收编前一致）", async () => {
    mount(<QuotesWorkstationPage />);
    await settle();
    clickTab("定价数据");
    await settle();
    expect(window.location.search).toContain("tab=pricing");
    clickTab("产品报价");
    await settle();
    expect(window.location.search).not.toContain("tab=");
  });

  it("?tab= 深链直接选中对应 tab", async () => {
    setUrlSearch("?tab=pricing");
    mount(<QuotesWorkstationPage />);
    await settle();
    expect(container!.querySelector('[data-testid="pricing"]')).not.toBeNull();
  });
});
