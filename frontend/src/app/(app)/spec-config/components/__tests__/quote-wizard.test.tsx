/**
 * spec-config 向导提交（P0-B2/SC1）—— 失败反馈 + pending 防重。
 *
 * 旧行为：`handleSubmit` 直接 `await submitMutation.mutateAsync(payload)`，
 * 失败即未处理 rejection —— 页面没有任何错误出口，用户以为没点上会无限重点。
 *
 * 钉住：
 * 1. 提交失败 → 页内 role="alert"（含后端 detail 原文），按钮恢复可点；
 * 2. 「再点一次提交」= 重试：会真的再发一次请求；
 * 3. pending 期间按钮禁用，不会重复提交。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mocks = vi.hoisted(() => ({ post: vi.fn() }));

vi.mock("@/lib/api/client", () => {
  const client = { post: mocks.post, get: vi.fn(), patch: vi.fn() };
  return { default: client, apiClient: client };
});
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock("../../hooks/use-bindings", () => ({
  // 一组"非必填"属性：步骤 1 可直接下一步；步骤 2 是定价步骤（由 PricingGroupForm 桩填值）。
  useBindings: () => ({
    data: [{ group_code: "identity", is_required: false }],
    isLoading: false,
  }),
}));
vi.mock("../DynamicSpecForm", () => ({
  DynamicSpecForm: () => <div data-testid="spec-form" />,
}));
vi.mock("../PricingGroupForm", () => ({
  PricingGroupForm: ({
    onChange,
  }: {
    onChange: (v: Record<string, string>) => void;
  }) => (
    <button
      type="button"
      data-testid="fill-pricing"
      onClick={() =>
        onChange({
          price: "100",
          price_unit: "cny_per_m",
          effective_from: "2026-10-01",
          effective_to: "",
          min_qty: "",
          note: "",
          change_reason: "首次定价",
        })
      }
    >
      fill-pricing
    </button>
  ),
}));

import { QuoteWizard } from "../QuoteWizard";

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

async function waitFor(check: () => boolean, timeout = 5000, label = "条件") {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) {
      throw new Error(
        `等待超时：${label}（当前文本：${document.body.textContent?.slice(0, 500) ?? ""}）`,
      );
    }
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
  }
}

function mount() {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <QueryClientProvider client={client!}>
        <QuoteWizard categoryId={1} categoryName="勾花网" />
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

async function click(el: HTMLElement) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await settle(2);
}

/** 推进到最后的「提交」步骤（步骤 1 组属性 → 步骤 2 定价 → … → 步骤 5 确认）。 */
async function goToSubmitStep() {
  await settle(2);
  await click(findButton("下一步")); // → 定价步骤
  await waitFor(
    () => document.querySelector('[data-testid="fill-pricing"]') !== null,
    undefined,
    "定价步骤渲染",
  );
  await click(document.querySelector('[data-testid="fill-pricing"]')!);
  await click(findButton("下一步"));
  await click(findButton("下一步"));
  await click(findButton("下一步"));
  await waitFor(
    () => document.body.textContent!.includes("提交"),
    undefined,
    "提交步骤",
  );
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  unmount();
  vi.restoreAllMocks();
});

describe("QuoteWizard · 向导提交", () => {
  it("提交失败 → 页内显示后端原因，且再点是重试", async () => {
    mocks.post.mockRejectedValue(
      Object.assign(new Error("Unprocessable"), {
        response: {
          status: 422,
          data: {
            detail: {
              error: "validation",
              code: "SPEC_PRICE_INVALID",
              message: "定价生效日期早于类目启用日期",
            },
          },
        },
      }),
    );
    mount();
    await goToSubmitStep();

    await click(findButton("提交"));
    await settle();

    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("提交失败");
    expect(alert?.textContent).toContain("定价生效日期早于类目启用日期");

    // 失败后按钮恢复 => 再点一次就是重试（第 2 次请求）
    expect(findButton("提交").disabled).toBe(false);
    await click(findButton("提交"));
    await settle();
    expect(mocks.post).toHaveBeenCalledTimes(2);
  });

  it("pending 期间不重复提交", async () => {
    mocks.post.mockImplementation(() => new Promise(() => {}));
    mount();
    await goToSubmitStep();

    await click(findButton("提交"));
    await settle();

    expect(mocks.post).toHaveBeenCalledTimes(1);
    const pendingButton = findButton("提交中...");
    expect(pendingButton.disabled).toBe(true);
    await click(pendingButton);
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(mocks.post.mock.calls[0]![0]).toBe("/spec/wizard/submit");
  });
});
