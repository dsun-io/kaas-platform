/**
 * 税与让利区（从 product-quote-view 拆出）—— 拆分回归网。
 *
 * 纯受控输入区（6 对值/回调），只锁两件事：值渲染正确、变更回传正确。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

import { TaxGivebackSection } from "../tax-giveback-section";

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

describe("TaxGivebackSection", () => {
  it("六个输入渲染初始值 + 变更回传（以进项票税点/出口退税率为例）", () => {
    const onInputVatRatePctChange = vi.fn();
    const onRebateRatePctChange = vi.fn();
    mount(
      <TaxGivebackSection
        inputVatRatePct="10"
        onInputVatRatePctChange={onInputVatRatePctChange}
        rebateRatePct="13"
        onRebateRatePctChange={onRebateRatePctChange}
        giveRatioPct="80"
        onGiveRatioPctChange={vi.fn()}
        stampRatePct=""
        onStampRatePctChange={vi.fn()}
        stampBase="profit"
        onStampBaseChange={vi.fn()}
        outputVatRatePct="0"
        onOutputVatRatePctChange={vi.fn()}
      />,
    );
    const text = container!.textContent ?? "";
    // 出口退税率填了 → 提示文案是「可退比例 = …」而不是「⚠ 未填」
    expect(text).toContain("可退比例 = 13%");
    expect(text).not.toContain("⚠ 未填");

    typeIn("进项票税点", "11");
    expect(onInputVatRatePctChange).toHaveBeenCalledWith("11");
    typeIn("出口退税率", "9");
    expect(onRebateRatePctChange).toHaveBeenCalledWith("9");
  });

  it("出口退税率留空 → 显示「⚠ 未填」警告文案", () => {
    mount(
      <TaxGivebackSection
        inputVatRatePct=""
        onInputVatRatePctChange={vi.fn()}
        rebateRatePct=""
        onRebateRatePctChange={vi.fn()}
        giveRatioPct=""
        onGiveRatioPctChange={vi.fn()}
        stampRatePct=""
        onStampRatePctChange={vi.fn()}
        stampBase=""
        onStampBaseChange={vi.fn()}
        outputVatRatePct=""
        onOutputVatRatePctChange={vi.fn()}
      />,
    );
    expect(container!.textContent).toContain("⚠ 未填");
  });
});
