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
vi.mock("@/components/route-guard", () => ({
  RouteGuard: ({ children }: { children: ReactNode }) => children,
}));

import AuditLogPage from "../page";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

function auditRow(n: number) {
  return {
    id: `op-${n}`,
    action: "tenant.reload",
    actor_id: "admin-1",
    resource_type: "tenant",
    resource_id: "lianjia",
    reason: "手动刷新租户配置",
    timestamp: "2026-10-20T01:00:00Z",
  };
}

function auditPage(page: number) {
  const start = (page - 1) * PAGE_SIZE;
  const count = Math.max(0, Math.min(PAGE_SIZE, TOTAL - start));
  return {
    items: Array.from({ length: count }, (_, i) => auditRow(start + i + 1)),
    total: TOTAL,
    page,
    page_size: PAGE_SIZE,
  };
}

function auditCalls() {
  return vi
    .mocked(apiClient.get)
    .mock.calls.filter(([url]) => String(url).startsWith("/admin/audit-log"));
}

function lastUrl() {
  const calls = auditCalls();
  return String(calls[calls.length - 1]?.[0] ?? "");
}

function lastPageParam(): number | null {
  const match = /[?&]page=(\d+)/.exec(lastUrl());
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
      <AuditLogPage />
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

/** 原生 select 要用原生 setter + change 事件才会触发 onChange */
async function selectValue(el: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLSelectElement.prototype,
    "value",
  )?.set;
  await act(async () => {
    setter?.call(el, value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  window.localStorage.clear();
  vi.mocked(apiClient.get).mockImplementation(async (url: string) => {
    const match = /[?&]page=(\d+)/.exec(String(url));
    return ok(auditPage(match ? Number(match[1]) : 1));
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

describe("操作日志分页（C25）", () => {
  it("第 1 页请求 page=1&page_size=20，并显示总数与当前范围", async () => {
    await mount();

    expect(auditCalls()).toHaveLength(1);
    expect(lastUrl()).toContain("page=1");
    expect(lastUrl()).toContain(`page_size=${PAGE_SIZE}`);
    expect(container!.textContent).toContain("45 条记录");
    expect(container!.textContent).toContain("第 1–20 条 / 共 45 条");
    expect(container!.textContent).toContain("第 1 / 3 页");
  });

  it("点「下一页」按 page=2 重新请求并显示第 21–40 条", async () => {
    await mount();
    await act(async () => {
      button("下一页")!.click();
    });
    await settle();

    expect(auditCalls()).toHaveLength(2);
    expect(lastPageParam()).toBe(2);
    expect(container!.textContent).toContain("第 21–40 条 / 共 45 条");
    expect(container!.textContent).toContain("第 2 / 3 页");
  });

  it("翻到第 2 页后再改筛选 ⇒ 回到第 1 页并带上筛选参数", async () => {
    await mount();
    await act(async () => {
      button("下一页")!.click();
    });
    await settle();
    expect(lastPageParam()).toBe(2);

    const actionSelect = container!.querySelector<HTMLSelectElement>("select");
    expect(actionSelect).not.toBeNull();
    await selectValue(actionSelect!, "tenant.reload");
    await settle();

    expect(lastPageParam()).toBe(1);
    expect(lastUrl()).toContain("action=tenant.reload");
  });

  it("操作名/对象类型翻中文；原始数据默认折叠，点「查看详情」才出现", async () => {
    await mount();

    // 内部代码 tenant.reload / tenant 不出现在列表上，改为中文说法
    expect(container!.textContent).toContain("重载空间配置");
    expect(container!.textContent).toContain("空间");
    expect(container!.textContent).not.toContain('"tenant.reload"');

    // 展开一行：先给摘要，原始 JSON 仍是折叠的
    const row = container!.querySelector<HTMLTableRowElement>("tbody tr")!;
    await act(async () => {
      row.click();
    });
    await settle();
    expect(container!.textContent).toContain("查看详情（一般不需要看）");
    expect(container!.textContent).not.toContain('"resource_type"');

    // 点「查看详情」才把原始 JSON 铺开
    await act(async () => {
      button("查看详情（一般不需要看）")!.click();
    });
    expect(container!.textContent).toContain('"resource_type"');
  });
});
