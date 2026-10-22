/**
 * X6（审计 §1.5）：audit-log 折叠行必须**键盘可达**。
 *
 * 原来只有 onClick —— 键盘用户无法展开任何一条日志的原始 JSON。
 * 现在：tr 有 tabIndex=0 + aria-expanded，Enter/Space 切换；展开后
 * 「查看详情（一般不需要看）」仍是原生 button（本身可键盘操作）。
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

import AuditLogPage from "../page";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type GetResp = Awaited<ReturnType<typeof apiClient.get>>;
const ok = (data: unknown) => ({ data }) as unknown as GetResp;

const ENTRY = {
  id: "op-1",
  action: "tenant.reload",
  actor_id: "admin-1",
  resource_type: "tenant",
  resource_id: "lianjia",
  reason: "手动刷新租户配置",
  timestamp: "2026-10-20T01:00:00Z",
};

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
        <AuditLogPage />
      </QueryClientProvider>,
    ),
  );
  await settle();
}

function summaryRow(): HTMLTableRowElement {
  const row = container!.querySelector("tbody tr");
  if (!row) throw new Error("没找到日志行");
  return row as HTMLTableRowElement;
}

function pressKey(key: string) {
  act(() => {
    summaryRow().dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true }),
    );
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  window.localStorage.clear();
  vi.mocked(apiClient.get).mockResolvedValue(
    ok({
      items: [ENTRY],
      total: 1,
      page: 1,
      page_size: 20,
    }) as never,
  );
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

describe("操作日志折叠行键盘可达", () => {
  it("tr 可聚焦、带 aria-expanded；Enter 展开 / Space 收起", async () => {
    await mount();

    const row = summaryRow();
    expect(row.getAttribute("tabindex")).toBe("0");
    expect(row.getAttribute("aria-expanded")).toBe("false");

    pressKey("Enter");
    await settle();
    expect(summaryRow().getAttribute("aria-expanded")).toBe("true");
    expect(container!.textContent).toContain("操作人");
    expect(container!.textContent).toContain("手动刷新租户配置");

    pressKey(" ");
    await settle();
    expect(summaryRow().getAttribute("aria-expanded")).toBe("false");
    expect(container!.textContent).not.toContain("操作人");
  });

  it("展开后「查看详情」按钮可切换原始 JSON（aria-expanded）", async () => {
    await mount();
    pressKey("Enter");
    await settle();

    const rawButton = Array.from(container!.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").includes("查看详情（一般不需要看）"),
    );
    expect(rawButton).toBeTruthy();
    expect(rawButton!.getAttribute("aria-expanded")).toBe("false");

    act(() => rawButton!.click());
    await settle();

    expect(rawButton!.getAttribute("aria-expanded")).toBe("true");
    expect(container!.textContent).toContain('"action": "tenant.reload"');
  });
});
