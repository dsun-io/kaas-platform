/**
 * 人工录入报价（P0-B2/Q15）—— 失败反馈 + pending 防重 + 成功反馈。
 *
 * 旧行为：`onSubmit` 直接 `await mutateAsync`，无 try/catch（失败即未处理 rejection），
 * 成功也不 toast。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@/lib/api/client", () => {
  const client = { post: mocks.post, get: vi.fn(), patch: vi.fn() };
  return { default: client, apiClient: client };
});
vi.mock("sonner", () => ({
  toast: { success: mocks.toastSuccess, error: vi.fn(), info: vi.fn() },
}));

import { NewQuotationForm } from "../new-quotation-form";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

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

function mount(onSuccess?: () => void) {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <QueryClientProvider client={client!}>
        <NewQuotationForm onSuccess={onSuccess} />
      </QueryClientProvider>,
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

async function submit() {
  const button = findButton("提交报价");
  await act(async () => {
    button.click();
  });
  await settle(2);
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  unmount();
  vi.restoreAllMocks();
});

describe("NewQuotationForm · 人工录入报价", () => {
  it("失败 → 页内显示原因；成功 → toast + onSuccess", async () => {
    const onSuccess = vi.fn();
    mocks.post.mockRejectedValue(
      Object.assign(new Error("Unprocessable"), {
        response: {
          status: 422,
          data: {
            detail: {
              error: "validation",
              code: "QUOTE_UNIT_PRICE_INVALID",
              message: "单价与品类不匹配",
            },
          },
        },
      }),
    );
    mount(onSuccess);
    await settle(2);
    await submit();
    await settle();

    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("录入失败");
    expect(alert?.textContent).toContain("单价与品类不匹配");
    expect(onSuccess).not.toHaveBeenCalled();
    expect(mocks.toastSuccess).not.toHaveBeenCalled();

    // 改好后重试：成功后 toast + onSuccess
    mocks.post.mockResolvedValue({ data: { id: "q-1", spec_hash: "h-1" } });
    await submit();
    await settle();
    expect(mocks.post).toHaveBeenCalledTimes(2);
    expect(mocks.post.mock.calls[0]![0]).toBe("/quotations");
    expect(mocks.toastSuccess).toHaveBeenCalledWith("报价已录入");
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it("pending 期间不重复提交（按钮禁用）", async () => {
    mocks.post.mockImplementation(() => new Promise(() => {}));
    mount();
    await settle(2);
    await submit();
    await settle();

    expect(mocks.post).toHaveBeenCalledTimes(1);
    const pending = findButton("提交中");
    expect(pending.disabled).toBe(true);
    await act(async () => {
      pending.click();
    });
    expect(mocks.post).toHaveBeenCalledTimes(1);
  });
});
