/**
 * 市场对照搜索防抖（U-P1E / 审计 M1）。
 *
 * 原本「按品名查询 / 港口情报 / 品名对照」三处输入都是**每个击键一次请求**；
 * 这里钉死：连续输入只发最终一次请求，且请求参数是最终值。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import apiClient from "@/lib/api/client";

vi.mock("@/lib/api/client", () => {
  const client = {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  };
  return { default: client, apiClient: client };
});

import { MarketView } from "../components/market-view";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type GetResp = Awaited<ReturnType<typeof apiClient.get>>;
const ok = (data: unknown) => ({ data }) as unknown as GetResp;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let client: QueryClient | null = null;

async function settle(times = 4) {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function waitDebounce() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 350));
  });
  await settle();
}

async function mount() {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      <QueryClientProvider client={client!}>
        <MarketView />
      </QueryClientProvider>,
    ),
  );
  await settle();
}

function clickTab(label: string) {
  const trigger = Array.from(
    container!.querySelectorAll("[data-slot='tabs-trigger']"),
  ).find((el) => (el.textContent ?? "").trim() === label);
  if (!trigger) throw new Error(`没找到 tab「${label}」`);
  act(() => {
    trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function callsWith(prefix: string): unknown[][] {
  return vi
    .mocked(apiClient.get)
    .mock.calls.filter(([url]) => String(url).startsWith(prefix));
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(apiClient.get).mockImplementation(async (url: string) => {
    const path = String(url);
    if (path === "/market/regions") return ok([]);
    return ok([]);
  });
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  document.body.innerHTML = "";
  client?.clear();
  root = null;
  container = null;
  client = null;
});

describe("市场对照搜索防抖", () => {
  it("按品名查询：连续输入只发最终一次 name-lookup", async () => {
    await mount();
    clickTab("按品名查询");
    await settle();

    const input = container!.querySelector<HTMLInputElement>(
      'input[placeholder^="输入品名"]',
    );
    expect(input).not.toBeNull();

    setInputValue(input!, "c");
    setInputValue(input!, "ch");
    setInputValue(input!, "chain");
    await settle();

    // 防抖窗口内：一次都不发（原来会发 3 次）
    expect(callsWith("/market/name-lookup")).toHaveLength(0);

    await waitDebounce();

    const calls = callsWith("/market/name-lookup");
    expect(calls).toHaveLength(1);
    expect(String(calls[0]?.[0])).toContain("q=chain");
  });

  it("港口情报：国家代码输入同样防抖，且带最终值", async () => {
    await mount();
    clickTab("港口情报");
    await settle();
    // 进入 tab 时先用空筛选请求一次
    expect(callsWith("/market/ports")).toHaveLength(1);

    const input = container!.querySelector<HTMLInputElement>(
      'input[placeholder^="输入国家代码"]',
    );
    expect(input).not.toBeNull();
    setInputValue(input!, "U");
    setInputValue(input!, "US");
    await settle();
    expect(callsWith("/market/ports")).toHaveLength(1);

    await waitDebounce();

    const calls = callsWith("/market/ports");
    expect(calls).toHaveLength(2);
    expect(String(calls[1]?.[0])).toContain("country_code=US");
  });
});
