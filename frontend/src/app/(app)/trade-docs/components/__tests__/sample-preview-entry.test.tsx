/**
 * 样板预览入口（问题 6）：默认收起、点开才在对话框里渲染 —— 18 类原型能力不变。
 *
 * 钉住两件事：
 * 1. 默认**不渲染**任何预览（没有 iframe、没有对话框）⇒ 不再占页面顶部一大块空间；
 * 2. 点「打开样板预览」后对话框出现，类型下拉仍是全 18 类，iframe 用内置样例渲染。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// DocPreview 的归档/对账 hook 依赖真实接口；样板预览不该触发它们，这里给最小替身。
vi.mock("../../hooks/use-trade-docs", () => ({
  useUploadTradeDocFile: () => ({ mutate: vi.fn(), isPending: false }),
  useArchiveRenderedPdf: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useCheckTradeDocRenderFingerprint: () => ({
    mutate: vi.fn(),
    isPending: false,
    data: undefined,
    isError: false,
  }),
}));

import { SamplePreviewEntry } from "../sample-preview-entry";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<SamplePreviewEntry />));
}

async function settle(times = 8) {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function waitFor(check: () => boolean, label: string, timeout = 5000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) {
      throw new Error(
        `等待超时：${label}（当前文本：${document.body.textContent?.slice(0, 300) ?? ""}）`,
      );
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

function buttonByText(text: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll("button")).find((b) =>
    (b.textContent ?? "").includes(text),
  );
  if (!button) throw new Error(`没找到按钮：${text}`);
  return button as HTMLButtonElement;
}

function click(node: Element) {
  act(() => {
    node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  document.body.innerHTML = "";
  root = null;
  container = null;
});

describe("样板预览入口 · 默认收起 / 按需打开", () => {
  it("默认只渲染一行入口：没有对话框、没有 iframe（不再占顶部空间）", async () => {
    mount();
    await settle();

    expect(document.body.textContent).toContain("样板预览");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("点开后对话框里有全 18 类类型下拉与样例 iframe", async () => {
    mount();
    await settle();

    click(buttonByText("打开样板预览"));
    await waitFor(
      () => document.querySelector('[role="dialog"]') !== null,
      "样板预览对话框出现",
    );

    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("样板预览（不需要真实单据）");
    const options = dialog.querySelectorAll("select option");
    expect(options.length).toBe(18);
    expect(document.querySelectorAll("iframe").length).toBe(1);
  });
});
