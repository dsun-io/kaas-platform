/**
 * U-P1E/待办：客户列表分页（后端 GET /customers 支持 page/page_size）。
 *
 * 钉死：page=1&page_size=20、翻页带 page=2、筛选/搜索变化回第 1 页；
 * 标题计数仍用 total（不是当前页条数）。
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
vi.mock("@/lib/events/use-page-view", () => ({ usePageView: () => {} }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import CustomersPage from "../page";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type GetResp = Awaited<ReturnType<typeof apiClient.get>>;
const ok = (data: unknown) => ({ data }) as unknown as GetResp;
const PAGE_SIZE = 20;
const TOTAL = 45;

function customerRow(n: number) {
  return {
    id: n,
    company_name: `客户 ${n}`,
    abbr: null,
    country: "CN",
    address: null,
    default_port: null,
    credit_level: null,
    stage: "active",
    manual_stage: "active",
    notes: null,
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-10-20T00:00:00Z",
  };
}

function pageOf(page: number) {
  const start = (page - 1) * PAGE_SIZE;
  const count = Math.max(0, Math.min(PAGE_SIZE, TOTAL - start));
  return {
    items: Array.from({ length: count }, (_, i) => customerRow(start + i + 1)),
    total: TOTAL,
    page,
    page_size: PAGE_SIZE,
  };
}

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

async function sleepMs(ms: number) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
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
        <CustomersPage />
      </QueryClientProvider>,
    ),
  );
  await settle();
}

function listCalls() {
  return vi
    .mocked(apiClient.get)
    .mock.calls.filter(([url]) => String(url).startsWith("/customers?"));
}

function paramsOfLast() {
  const calls = listCalls();
  return new URL(String(calls[calls.length - 1]?.[0] ?? ""), "http://localhost")
    .searchParams;
}

function buttonByText(text: string) {
  return Array.from(container!.querySelectorAll("button")).find((b) =>
    (b.textContent ?? "").trim().includes(text),
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  window.localStorage.clear();
  vi.mocked(apiClient.get).mockImplementation(async (url: string) => {
    const path = String(url);
    if (path.startsWith("/customers?")) {
      const params = new URL(path, "http://localhost").searchParams;
      return ok(pageOf(Number(params.get("page") ?? 1)));
    }
    return ok({ items: [] });
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

describe("客户列表分页", () => {
  it("首屏 page=1&page_size=20；下一页 page=2；搜索变化回第 1 页", async () => {
    await mount();

    expect(paramsOfLast().get("page")).toBe("1");
    expect(paramsOfLast().get("page_size")).toBe(String(PAGE_SIZE));
    expect(container!.textContent).toContain("第 1–20 条 / 共 45 条");
    expect(container!.textContent).toContain("第 1 / 3 页");
    // 计数仍用 total
    expect(container!.textContent).toContain("共 45 家客户");

    act(() => buttonByText("下一页")!.click());
    await settle();
    expect(paramsOfLast().get("page")).toBe("2");
    expect(container!.textContent).toContain("第 21–40 条 / 共 45 条");

    const input = container!.querySelector<HTMLInputElement>(
      'input[placeholder^="搜索客户"]',
    )!;
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;
    act(() => {
      setter.call(input, "联佳");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await sleepMs(450);
    expect(paramsOfLast().get("page")).toBe("1");
    expect(paramsOfLast().get("q")).toBe("联佳");
  });
});
