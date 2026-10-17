/**
 * 成本与利润区（从 product-quote-view 拆出）—— 拆分回归网。
 *
 * 只锁对外行为：税前成本只读、利润金额/利润率 onChange 回传
 * （换算 handler 在父组件，这里是挂钩点）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

import { CostProfitSection } from "../cost-profit-section";

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

function typeIn(labelText: string, value: string) {
  const labels = Array.from(container!.querySelectorAll("label"));
  const label = labels.find((l) => l.textContent?.trim().startsWith(labelText));
  if (!label) throw new Error(`没找到标签「${labelText}」`);
  const input = label.parentElement?.querySelector("input");
  if (!input) throw new Error(`标签「${labelText}」旁没有输入框`);
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

afterEach(() => {
  unmount();
});

describe("CostProfitSection", () => {
  it("税前成本只读 + 利润两个输入 onChange 回传", () => {
    const onProfitFixedChange = vi.fn();
    const onProfitPctChange = vi.fn();
    mount(
      <CostProfitSection
        costFieldKey="raw_price"
        costPretax={12.5}
        profitFixed="0.1"
        onProfitFixedChange={onProfitFixedChange}
        profitPct="2.27"
        onProfitPctChange={onProfitPctChange}
      />,
    );
    const readOnlyInput = container!.querySelector(
      "input[readonly]",
    ) as HTMLInputElement;
    expect(readOnlyInput.value).toBe("12.5");

    typeIn("加工利润", "0.2");
    expect(onProfitFixedChange).toHaveBeenCalledWith("0.2");
    typeIn("利润率", "3.5");
    expect(onProfitPctChange).toHaveBeenCalledWith("3.5");
  });
});
