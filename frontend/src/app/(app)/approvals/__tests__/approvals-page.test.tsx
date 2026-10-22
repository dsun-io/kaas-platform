/**
 * 审批中心页面：三视图（待我审批 / 我发起的 / 已处理）的请求参数与列表字段。
 *
 * 测试范式照 `orders/__tests__/orders-pagination.test.tsx`：直接 mock `apiClient`，
 * 用 createRoot + QueryClientProvider 挂载**整页**，不引 @testing-library/react。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import apiClient from "@/lib/api/client";

vi.mock("@/lib/api/client", () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));
vi.mock("@/lib/events/use-page-view", () => ({ usePageView: () => {} }));
vi.mock("@/lib/auth/auth-context", () => ({
  useAuth: () => ({
    user: { user_id: 1, display_name: "管理员", role: "admin", team_id: 1 },
    isLoading: false,
    isAuthenticated: true,
  }),
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import ApprovalsPage from "../page";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type GetResp = Awaited<ReturnType<typeof apiClient.get>>;
const ok = (data: unknown) => ({ data }) as unknown as GetResp;

function changeLine(qty: number, amount: number) {
  return {
    sku_id: 1,
    product_name: "牛栏网",
    spec_snapshot: { specification: "热镀锌 1.8m" },
    qty,
    qty_unit: "卷",
    unit_price: 100,
    currency: "USD",
    line_amount: amount,
  };
}

function approvalItem(id: number, patch: Record<string, unknown> = {}) {
  return {
    id,
    order_id: 9,
    order_no: "SO-202610-0009",
    requested_by: 2,
    requester_name: "张三",
    reason: "客户要求加量",
    items: [changeLine(12, 1200)],
    snapshot: [changeLine(10, 1000)],
    status: "pending",
    decided_by: null,
    decided_at: null,
    decision_reason: null,
    team_id: 1,
    created_at: "2026-10-22T10:00:00+08:00",
    order_status: "confirmed",
    order_total_amount: 12000,
    order_currency: "USD",
    ...patch,
  };
}

const PENDING = approvalItem(1);
const MINE = approvalItem(2, { requester_name: "我", requested_by: 1 });
const DONE = approvalItem(3, {
  status: "approved",
  decided_by: 1,
  decided_at: "2026-10-22T12:00:00+08:00",
  decision_reason: "同意",
});

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

function approvalCalls() {
  return vi
    .mocked(apiClient.get)
    .mock.calls.filter(([url]) => String(url) === "/approvals");
}

function lastApprovalParams(): Record<string, unknown> {
  const calls = approvalCalls();
  const config = calls[calls.length - 1]?.[1] as
    | { params?: Record<string, unknown> }
    | undefined;
  return config?.params ?? {};
}

function tabButton(label: string): HTMLButtonElement {
  const tabs = Array.from(
    container!.querySelectorAll("[data-slot='tabs-trigger']"),
  ) as HTMLButtonElement[];
  const target = tabs.find((tab) => (tab.textContent ?? "").trim() === label);
  if (!target) throw new Error(`没找到视图「${label}」`);
  return target;
}

async function mount() {
  client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const tree: ReactNode = (
    <QueryClientProvider client={client}>
      <ApprovalsPage />
    </QueryClientProvider>
  );
  act(() => root!.render(tree));
  await settle();
}

beforeEach(() => {
  vi.resetAllMocks();
  window.history.replaceState(null, "", "/approvals");
  vi.mocked(apiClient.get).mockImplementation(async (url: string, config) => {
    const path = String(url);
    if (path === "/approvals") {
      const params = (
        config as { params?: Record<string, unknown> } | undefined
      )?.params;
      const view = String(params?.view ?? "pending");
      const rows =
        view === "pending" ? [PENDING] : view === "mine" ? [MINE] : [DONE];
      return ok({ items: rows, total: rows.length, page: 1, page_size: 20 });
    }
    if (path === "/trade-docs") {
      return ok({ items: [], total: 0, page: 1, page_size: 100 });
    }
    return ok({ items: [], total: 0, page: 1, page_size: 20 });
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

describe("审批中心三视图", () => {
  it("默认「待我审批」：GET /approvals?view=pending，并渲染类型/订单号/申请人/时间/金额变化/状态", async () => {
    await mount();
    expect(lastApprovalParams()).toMatchObject({ view: "pending", page: 1 });
    const text = container!.textContent ?? "";
    expect(text).toContain("货物明细变更");
    expect(text).toContain("SO-202610-0009");
    expect(text).toContain("张三");
    expect(text).toContain("2026-10-22 10:00");
    expect(text).toContain("+USD 200.00");
    expect(text).toContain("待审批");
  });

  it("切「我发起的」：按 view=mine 重新请求并显示我发起的行", async () => {
    await mount();
    act(() => tabButton("我发起的").click());
    await settle();
    expect(lastApprovalParams()).toMatchObject({ view: "mine", page: 1 });
    expect(container!.textContent).toContain("我发起的");
  });

  it("切「已处理」：按 view=done 重新请求，显示已批准与处理意见入口", async () => {
    await mount();
    act(() => tabButton("已处理").click());
    await settle();
    expect(lastApprovalParams()).toMatchObject({ view: "done", page: 1 });
    expect(container!.textContent).toContain("已批准");
  });

  it("空列表：三种视图各自的空态文案（不只一行「暂无数据」）", async () => {
    vi.mocked(apiClient.get).mockImplementation(async (url: string) => {
      const path = String(url);
      if (path === "/approvals") {
        return ok({ items: [], total: 0, page: 1, page_size: 20 });
      }
      return ok({ items: [], total: 0, page: 1, page_size: 20 });
    });
    await mount();
    expect(container!.textContent).toContain("没有待你审批的变更申请");
    act(() => tabButton("我发起的").click());
    await settle();
    expect(container!.textContent).toContain("你还没有发起过变更申请");
    act(() => tabButton("已处理").click());
    await settle();
    expect(container!.textContent).toContain("还没有你处理过的申请");
  });

  it("深链 ?focus=<rid>：在待批列表里命中后自动打开详情", async () => {
    window.history.replaceState(null, "", "/approvals?focus=1");
    await mount();
    // 焦点场景放大页大小，确保不在第一页的申请也能找到
    expect(lastApprovalParams()).toMatchObject({
      view: "pending",
      page: 1,
      page_size: 100,
    });
    expect(document.body.textContent).toContain("变更申请 #1");
  });
});
