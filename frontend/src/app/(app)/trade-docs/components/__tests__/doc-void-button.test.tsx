/**
 * 单证「作废」二次确认（P0-B1 / 审计 T1）。
 *
 * 钉住：
 * 1. 点「作废」只开确认弹窗，**不发 PATCH**；确认后才 PATCH status=void；
 * 2. 提交中连点两次只发一次 PATCH；
 * 3. 失败原因（如 409）显示在弹窗里且弹窗不关。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mocks = vi.hoisted(() => ({
  patch: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@/lib/api/client", () => {
  const client = { patch: mocks.patch };
  return { default: client, apiClient: client };
});
vi.mock("sonner", () => ({
  toast: { success: mocks.toastSuccess, error: vi.fn() },
}));

import { DocVoidButton } from "../doc-void-button";
import type { TradeDocRow } from "../../hooks/use-trade-docs";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const DOC = {
  id: 5,
  doc_no: "CI-202610-0001",
  doc_type: "ci",
  status: "issued",
  currency: "USD",
  total_amount: 12000,
  raw_payload: null,
  created_at: null,
  issued_at: null,
} as unknown as TradeDocRow;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let client: QueryClient | null = null;

async function settle(times = 6) {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function mount(element: ReactNode) {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <QueryClientProvider client={client!}>{element}</QueryClientProvider>,
    );
  });
}

function unmount() {
  if (root) act(() => root!.unmount());
  container?.remove();
  document.body.innerHTML = "";
  root = null;
  container = null;
  client?.clear();
  client = null;
}

function findButton(text: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll("button")).find((b) =>
    (b.textContent ?? "").includes(text),
  );
  if (!button) throw new Error(`没找到按钮「${text}」`);
  return button;
}

async function click(el: HTMLElement) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await settle(2);
}

async function doubleClick(el: HTMLElement) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await settle(2);
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  unmount();
  vi.restoreAllMocks();
});

describe("DocVoidButton", () => {
  it("未确认不发 PATCH；确认后 PATCH status=void 一次", async () => {
    mocks.patch.mockResolvedValue({ data: { ...DOC, status: "void" } });
    mount(<DocVoidButton doc={DOC} />);

    await click(findButton("作废"));
    expect(document.body.textContent).toContain("作废单证 CI-202610-0001？");
    expect(document.body.textContent).toContain("不可恢复");
    expect(mocks.patch).not.toHaveBeenCalled();

    await click(findButton("确认作废"));
    await settle();

    expect(mocks.patch).toHaveBeenCalledTimes(1);
    expect(mocks.patch).toHaveBeenCalledWith("/trade-docs/5", {
      status: "void",
    });
    expect(mocks.toastSuccess).toHaveBeenCalledWith("已作废");
  });

  it("提交中连点两次只发一次 PATCH（pending 防重）", async () => {
    mocks.patch.mockImplementation(() => new Promise(() => {}));
    mount(<DocVoidButton doc={DOC} />);

    await click(findButton("作废"));
    await doubleClick(findButton("确认作废"));
    await settle();

    expect(mocks.patch).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain("提交中…");
  });

  it("PATCH 失败时错误显示在弹窗里且弹窗不关", async () => {
    mocks.patch.mockRejectedValue(
      Object.assign(new Error("Conflict"), {
        response: {
          status: 409,
          data: {
            detail: {
              error: "conflict",
              code: "DOC_NOT_ISSUED",
              message: "只有已签发单证可以作废",
            },
          },
        },
      }),
    );
    mount(<DocVoidButton doc={DOC} />);

    await click(findButton("作废"));
    await click(findButton("确认作废"));
    await settle();

    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("只有已签发单证可以作废");
    expect(document.body.textContent).toContain("确认作废");
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });
});
