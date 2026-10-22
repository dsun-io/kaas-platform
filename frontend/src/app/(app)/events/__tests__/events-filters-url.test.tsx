/**
 * 事件审计筛选（U-P1E / 审计 E3）：搜索防抖 + 筛选入 URL + 清空筛选。
 *
 * 钉死：
 *  1. URL 里的筛选参数在首屏水合后直接进查询（刷新/分享不丢）；
 *  2. 连续击键只发**最终一次**请求（300ms 防抖），但 URL 是即时同步的；
 *  3. 「清空筛选」把 URL 参数清干净并回到第 1 页（文案保持 B3 的「清空筛选」）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
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
vi.mock("@/components/route-guard", () => ({
  RouteGuard: ({ children }: { children: ReactNode }) => children,
}));

import EventsPage from "../page";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type GetResp = Awaited<ReturnType<typeof apiClient.get>>;
const ok = (data: unknown) => ({ data }) as unknown as GetResp;

function eventRow(n: number) {
  return {
    id: `evt-${n}`,
    event_type: "audit.access",
    event_source: "frontend",
    schema_version: 1,
    actor_id: "admin-1",
    tenant_id: "default",
    payload: { resource_id: "/events" },
    created_at: "2026-10-20T01:00:00Z",
    sampled: false,
  };
}

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
        <EventsPage />
      </QueryClientProvider>,
    ),
  );
  await settle();
}

function eventCalls() {
  return vi
    .mocked(apiClient.get)
    .mock.calls.filter(([url]) => String(url).startsWith("/events"));
}

function lastUrl(): string {
  const calls = eventCalls();
  return String(calls[calls.length - 1]?.[0] ?? "");
}

function urlsWith(param: string): string[] {
  return eventCalls()
    .map(([url]) => String(url))
    .filter((url) => url.includes(param));
}

function buttonByText(label: string): HTMLButtonElement {
  const button = Array.from(container!.querySelectorAll("button")).find(
    (el) => (el.textContent ?? "").trim() === label,
  );
  if (!button) throw new Error(`没找到按钮「${label}」`);
  return button;
}

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

function tenantInput(): HTMLInputElement {
  const input = container!.querySelector<HTMLInputElement>(
    'input[placeholder="空间 ID"]',
  );
  if (!input) throw new Error("没找到空间 ID 输入框");
  return input;
}

beforeEach(() => {
  vi.resetAllMocks();
  window.history.replaceState(null, "", "/events");
  vi.mocked(apiClient.get).mockImplementation(async (url: string) => {
    const match = /[?&]page=(\d+)/.exec(String(url));
    const page = match ? Number(match[1]) : 1;
    return ok({
      items: Array.from({ length: 5 }, (_, i) =>
        eventRow((page - 1) * 5 + i + 1),
      ),
      total: 45,
      page,
      page_size: 20,
    });
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

describe("事件筛选 · URL 与防抖", () => {
  it("URL 里的筛选参数水合后直接带入查询（刷新/分享不丢筛选）", async () => {
    window.history.replaceState(
      null,
      "",
      "/events?tenant_id=acme&event_type=audit.access&event_source=frontend",
    );
    await mount();
    await waitDebounce();

    const url = lastUrl();
    expect(url).toContain("tenant_id=acme");
    expect(url).toContain("event_type=audit.access");
    expect(url).toContain("event_source=frontend");
    expect(url).toContain("page=1");
  });

  it("连续输入只发最终一次请求（300ms 防抖），但 URL 即时同步", async () => {
    await mount();
    expect(eventCalls()).toHaveLength(1);

    await typeInto(tenantInput(), "a");
    await typeInto(tenantInput(), "ac");
    await typeInto(tenantInput(), "acme");
    await settle();

    // URL 已同步（输入即时回显），但防抖窗口内不发请求
    expect(new URLSearchParams(window.location.search).get("tenant_id")).toBe(
      "acme",
    );
    expect(urlsWith("tenant_id")).toHaveLength(0);

    await waitDebounce();

    const withTenant = urlsWith("tenant_id=acme");
    expect(withTenant).toHaveLength(1);
    // 初始 1 次（无筛选）+ 防抖后 1 次（最终值），中间两次击键不发请求
    expect(eventCalls()).toHaveLength(2);
    expect(withTenant[0]).toContain("page=1");
  });

  it("「清空筛选」把 URL 参数清干净并回到第 1 页", async () => {
    await mount();

    await typeInto(tenantInput(), "acme");
    await waitDebounce();
    act(() => {
      buttonByText("下一页").dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    await settle();
    expect(lastUrl()).toContain("page=2");

    act(() => {
      buttonByText("清空筛选").dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    await waitDebounce();

    const params = new URLSearchParams(window.location.search);
    expect(params.get("tenant_id")).toBeNull();
    expect(params.get("event_type")).toBeNull();
    expect(params.get("actor_id")).toBeNull();
    expect(params.get("event_source")).toBeNull();
    expect(lastUrl()).toContain("page=1");
    expect(lastUrl()).not.toContain("tenant_id");
  });
});
