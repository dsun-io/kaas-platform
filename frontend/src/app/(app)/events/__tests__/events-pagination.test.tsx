import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import apiClient from "@/lib/api/client";

// 这两个页面走**具名导入**（`import { apiClient } from "@/lib/api/client"`），
// 只 mock default 会让 apiClient 为 undefined ⇒ 查询直接抛错、一个请求都发不出
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
// events 页整页包在 RouteGuard adminOnly 里；这里只验分页，鉴权由 RouteGuard 自己的测试兜
vi.mock("@/components/route-guard", () => ({
  RouteGuard: ({ children }: { children: ReactNode }) => children,
}));

import EventsPage from "../page";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type GetResp = Awaited<ReturnType<typeof apiClient.get>>;
const ok = (data: unknown) => ({ data }) as unknown as GetResp;
const PAGE_SIZE = 20;
const TOTAL = 45;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let client: QueryClient | null = null;

async function settle(times = 3) {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** 等输入类筛选的 300ms 防抖窗口过去（再 settle 让请求落地） */
async function waitDebounce() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 350));
  });
  await settle();
}

/** 一条符合 `EventsResponseSchema` 的事件行 */
function eventRow(n: number) {
  return {
    id: `evt-${n}`,
    event_type: "audit.access",
    event_source: "frontend",
    schema_version: 1,
    actor_id: "admin-1",
    tenant_id: "default",
    // 不给 session_id / trace_id：EventsResponseSchema 里它们是 `string().optional()`，
    // 显式 null 会触发 zod 告警（后者不是本测试要验的东西）
    payload: { resource_id: "/events" },
    created_at: "2026-10-20T01:00:00Z",
    sampled: false,
  };
}

function eventsUrl(page: number) {
  const start = (page - 1) * PAGE_SIZE;
  const count = Math.max(0, Math.min(PAGE_SIZE, TOTAL - start));
  return {
    items: Array.from({ length: count }, (_, i) => eventRow(start + i + 1)),
    total: TOTAL,
    page,
    page_size: PAGE_SIZE,
  };
}

function eventCalls() {
  return vi
    .mocked(apiClient.get)
    .mock.calls.filter(([url]) => String(url).startsWith("/events"));
}

/** 最近一次请求的完整 URL（含 query） */
function lastUrl() {
  const calls = eventCalls();
  return String(calls[calls.length - 1]?.[0] ?? "");
}

function lastPageParam(): number | null {
  const url = lastUrl();
  const match = /[?&]page=(\d+)/.exec(url);
  return match ? Number(match[1]) : null;
}

async function mount() {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const tree: ReactNode = (
    <QueryClientProvider client={client}>
      <EventsPage />
    </QueryClientProvider>
  );
  act(() => root!.render(tree));
  await settle();
}

function button(label: string) {
  return Array.from(container!.querySelectorAll("button")).find((el) =>
    (el.textContent ?? "").includes(label),
  );
}

/** React 受控 input 要用原生 setter + input 事件才会触发 onChange */
async function typeInto(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  await act(async () => {
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  window.localStorage.clear();
  // 筛选改存 URL（U-P1E）：每个用例从干净 URL 开始，避免上一条的筛选串场
  window.history.replaceState(null, "", "/events");
  vi.mocked(apiClient.get).mockImplementation(async (url: string) => {
    const path = String(url);
    const match = /[?&]page=(\d+)/.exec(path);
    return ok(eventsUrl(match ? Number(match[1]) : 1));
  });
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  client?.clear();
  root = null;
  container = null;
  client = null;
});

describe("事件列表分页（C25）", () => {
  it("第 1 页请求 page=1&page_size=20，并显示总数与当前范围", async () => {
    await mount();

    expect(eventCalls()).toHaveLength(1);
    expect(lastUrl()).toContain("page=1");
    expect(lastUrl()).toContain(`page_size=${PAGE_SIZE}`);
    expect(container!.textContent).toContain("共 45 条");
    expect(container!.textContent).toContain("第 1–20 条 / 共 45 条");
    expect(container!.textContent).toContain("第 1 / 3 页");
  });

  it("点「下一页」按 page=2 重新请求并显示第 21–40 条", async () => {
    await mount();
    await act(async () => {
      button("下一页")!.click();
    });
    await settle();

    expect(eventCalls()).toHaveLength(2);
    expect(lastPageParam()).toBe(2);
    expect(container!.textContent).toContain("第 21–40 条 / 共 45 条");
    expect(container!.textContent).toContain("第 2 / 3 页");
  });

  it("翻到第 2 页后再改筛选 ⇒ 回到第 1 页（不留在第 2 页看空结果）", async () => {
    await mount();
    await act(async () => {
      button("下一页")!.click();
    });
    await settle();
    expect(lastPageParam()).toBe(2);

    const tenantInput = container!.querySelector<HTMLInputElement>(
      'input[placeholder="空间 ID"]',
    );
    expect(tenantInput).not.toBeNull();
    await typeInto(tenantInput!, "default");
    // 输入防抖 300ms：停顿后才发请求（U-P1E）
    await waitDebounce();

    expect(lastPageParam()).toBe(1);
    expect(lastUrl()).toContain("tenant_id=default");
  });

  it("事件类型/来源翻中文；原始数据默认折叠，点「查看详情」才出现", async () => {
    await mount();

    expect(container!.textContent).toContain("访问审计");
    expect(container!.textContent).toContain("界面操作");
    expect(container!.textContent).not.toContain("audit.access");

    const detailButton = Array.from(container!.querySelectorAll("button")).find(
      (el) => el.getAttribute("aria-label") === "查看事件详情",
    );
    await act(async () => {
      detailButton!.click();
    });
    await settle();

    // 详情只给中文摘要；原始数据收在「查看详情（一般不需要看）」后面
    expect(document.body.textContent).toContain("查看详情（一般不需要看）");
    expect(document.body.textContent).toContain("访问对象");
    // 资源名给中文摘要（"/events" ⇒ "事件审计"），不是一串路由
    expect(document.body.textContent).toContain("事件审计");
    expect(document.body.textContent).not.toContain('"/events"');
    expect(document.body.textContent).not.toContain('"resource_id"');

    const rawButton = Array.from(document.body.querySelectorAll("button")).find(
      (el) => (el.textContent ?? "").includes("查看详情（一般不需要看）"),
    );
    await act(async () => {
      rawButton!.click();
    });
    expect(document.body.textContent).toContain('"resource_id"');
  });
});
