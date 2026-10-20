/**
 * 手工汇率卡片（C36 #14）——最新汇率展示、录入校验与错误透出。
 *
 * 契约对齐 `POST /fx-rates`：rate<=0 ⇒ 422 扁平错误体；成功 201 返回行并失效 `["fx","latest"]`。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { FxRateCard } from "../fx-rate-card";

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));

vi.mock("@/lib/api/client", () => ({
  default: { get: mocks.get, post: mocks.post },
  apiClient: { get: mocks.get, post: mocks.post },
}));

const toastSuccess = vi.fn();
vi.mock("sonner", () => ({
  toast: { success: (...a: unknown[]) => toastSuccess(...a), error: vi.fn() },
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let client: QueryClient | null = null;

async function settle(times = 6) {
  await act(async () => {
    for (let i = 0; i < times; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
}

function mount(element: ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  root = createRoot(container);
  act(() => {
    root!.render(
      <QueryClientProvider client={client!}>{element}</QueryClientProvider>,
    );
  });
}

function clickButton(text: string) {
  const button = Array.from(document.querySelectorAll("button")).find(
    (b) => (b.textContent ?? "").trim() === text,
  );
  if (!button) throw new Error(`没找到按钮「${text}」`);
  act(() => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

/** 汇率输入框是「汇率 *」label 下的 input；用 placeholder 定位最稳 */
function setRate(value: string) {
  const input = Array.from(
    document.querySelectorAll<HTMLInputElement>("input"),
  ).find((i) => i.placeholder === "如 6.7029");
  if (!input) throw new Error("没找到汇率输入框");
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockResolvedValue({
    data: {
      base_currency: "USD",
      quote_currency: "CNY",
      rate: 6.7029,
      rate_date: "2026-09-28",
      source: "manual",
      is_stale: false,
    },
  });
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  document.body.innerHTML = "";
  root = null;
  container = null;
  client?.clear();
  client = null;
});

describe("FxRateCard", () => {
  it("展示当前最新汇率与来源；过期缓存标黄", async () => {
    mocks.get.mockResolvedValue({
      data: {
        base_currency: "USD",
        quote_currency: "CNY",
        rate: 6.7,
        rate_date: "2026-09-01",
        source: "cache",
        is_stale: true,
      },
    });
    mount(<FxRateCard />);
    await settle();
    const text = document.body.textContent ?? "";
    expect(text).toContain("6.7");
    expect(text).toContain("缓存已过期");
  });

  it("非法汇率本地拦截（不发 POST）", async () => {
    mount(<FxRateCard />);
    await settle();
    setRate("0");
    clickButton("保存汇率");
    await settle();
    expect(mocks.post).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "大于 0",
    );
  });

  it("合法汇率 POST /fx-rates 并提示成功", async () => {
    mocks.post.mockResolvedValue({
      data: {
        base_currency: "USD",
        quote_currency: "CNY",
        rate: 6.75,
        rate_date: "2026-10-21",
        source: "manual",
        is_stale: false,
      },
    });
    mount(<FxRateCard />);
    await settle();
    setRate("6.75");
    clickButton("保存汇率");
    await settle();

    expect(mocks.post).toHaveBeenCalledWith(
      "/fx-rates",
      expect.objectContaining({
        base_currency: "USD",
        quote_currency: "CNY",
        rate: 6.75,
        source: "manual",
      }),
      { silent: true },
    );
    expect(toastSuccess).toHaveBeenCalledWith(
      expect.stringContaining("USD/CNY = 6.75"),
    );
  });

  it("后端 422 invalid_rate 的 message 原样展示", async () => {
    mocks.post.mockRejectedValue(
      Object.assign(new Error("Unprocessable"), {
        response: {
          status: 422,
          data: { error: "invalid_rate", message: "rate must be > 0" },
        },
      }),
    );
    mount(<FxRateCard />);
    await settle();
    setRate("6.75");
    clickButton("保存汇率");
    await settle();
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      "rate must be > 0",
    );
  });
});
