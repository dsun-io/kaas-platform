/**
 * 审批详情与决策：拒绝必填理由 / 批准二次确认（受影响单证）/ 自批提示 / 单证过滤。
 *
 * 详情抽屉与确认弹窗都走 base-ui Portal，渲染在 document.body 下 —— 断言用
 * `document` 查询（与 order-status-dialog.test.tsx 同口径）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import apiClient from "@/lib/api/client";

const toastSuccess = vi.fn();
const toastError = vi.fn();

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
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
    info: vi.fn(),
  },
}));

import ApprovalsPage from "../page";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type GetResp = Awaited<ReturnType<typeof apiClient.get>>;
type PostResp = Awaited<ReturnType<typeof apiClient.post>>;
const okGet = (data: unknown) => ({ data }) as unknown as GetResp;
const okPost = (data: unknown) => ({ data }) as unknown as PostResp;

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

function approvalItem(patch: Record<string, unknown> = {}) {
  return {
    id: 1,
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

function buttonByText(label: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll("button")).find(
    (el) => (el.textContent ?? "").trim() === label,
  );
  if (!button) throw new Error(`没找到按钮「${label}」`);
  return button;
}

function buttonByAria(label: string): HTMLButtonElement {
  const button = document.querySelector(
    `button[aria-label="${label}"]`,
  ) as HTMLButtonElement | null;
  if (!button) throw new Error(`没找到按钮 aria-label「${label}」`);
  return button;
}

function click(element: HTMLButtonElement) {
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function setTextareaValue(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  )!.set!;
  act(() => {
    setter.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
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

async function openDetail() {
  await mount();
  click(buttonByAria("查看申请 #1"));
  await settle();
}

function mockCommonGet(item: ReturnType<typeof approvalItem>) {
  vi.mocked(apiClient.get).mockImplementation(async (url: string) => {
    const path = String(url);
    if (path === "/approvals") {
      return okGet({ items: [item], total: 1, page: 1, page_size: 20 });
    }
    if (path === "/trade-docs") {
      return okGet({
        items: [
          {
            id: 71,
            order_id: 9,
            doc_type: "pi",
            doc_no: "PI-202610-0001",
            status: "draft",
          },
          {
            id: 72,
            order_id: 9,
            doc_type: "ci",
            doc_no: "CI-202610-0002",
            status: "issued",
          },
          // 其他订单的单证不能算「受影响」——mock 忽略 order_id 过滤时必须由前端挡住
          {
            id: 73,
            order_id: 5,
            doc_type: "bl",
            doc_no: "BL-OTHER-ORDER",
            status: "issued",
          },
        ],
        total: 3,
        page: 1,
        page_size: 100,
      });
    }
    return okGet({ items: [], total: 0, page: 1, page_size: 20 });
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  toastSuccess.mockClear();
  toastError.mockClear();
  window.history.replaceState(null, "", "/approvals");
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

describe("审批详情与决策", () => {
  it("详情展示新旧明细对比、原因与受影响单证（只列本订单）", async () => {
    mockCommonGet(approvalItem());
    await openDetail();

    const text = document.body.textContent ?? "";
    expect(text).toContain("变更申请 #1");
    expect(text).toContain("SO-202610-0009");
    expect(text).toContain("客户要求加量");
    expect(text).toContain("新旧明细对比");
    expect(text).toContain("修改");
    expect(text).toContain("单价");
    // 受影响单证：本订单两张，其他订单那张被过滤
    expect(text).toContain("PI-202610-0001");
    expect(text).toContain("CI-202610-0002");
    expect(text).not.toContain("BL-OTHER-ORDER");
  });

  it("拒绝必填理由：空理由不提交，弹窗内提示；填写后才 POST reject", async () => {
    mockCommonGet(approvalItem());
    vi.mocked(apiClient.post).mockResolvedValue(
      okPost({
        ...approvalItem({
          status: "rejected",
          decision_reason: "请补充单价依据",
        }),
      }),
    );
    await openDetail();

    click(buttonByText("拒绝"));
    await settle();

    click(buttonByText("确认拒绝"));
    await settle();

    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("拒绝必须填写理由");
    expect(vi.mocked(apiClient.post)).not.toHaveBeenCalled();

    const textarea = document.querySelector(
      "#approval-reject-reason",
    ) as HTMLTextAreaElement | null;
    expect(textarea).not.toBeNull();
    setTextareaValue(textarea!, "请补充单价依据");
    click(buttonByText("确认拒绝"));
    await settle(6);

    expect(vi.mocked(apiClient.post)).toHaveBeenCalledWith(
      "/orders/9/item-change-requests/1/reject",
      { reason: "请补充单价依据" },
      { silent: true },
    );
    expect(toastSuccess).toHaveBeenCalledWith(
      expect.stringContaining("已拒绝"),
    );
  });

  it("批准：二次确认列出受影响单证，确认后 POST approve 并用新总额提示", async () => {
    mockCommonGet(approvalItem());
    vi.mocked(apiClient.post).mockResolvedValue(
      okPost({
        ...approvalItem({ status: "approved", decided_by: 1 }),
        applied: true,
        affected_docs: [],
        new_total_amount: 1200,
      }),
    );
    await openDetail();

    click(buttonByText("批准"));
    await settle();

    const confirmText = document.body.textContent ?? "";
    expect(confirmText).toContain("确认批准");
    expect(confirmText).toContain("受影响单证需人工复核/重开");
    expect(confirmText).toContain("PI-202610-0001");

    click(buttonByText("确认批准"));
    await settle(6);

    expect(vi.mocked(apiClient.post)).toHaveBeenCalledWith(
      "/orders/9/item-change-requests/1/approve",
      {},
      { silent: true },
    );
    expect(toastSuccess).toHaveBeenCalledWith(
      expect.stringContaining("已批准"),
    );
  });

  it("自批提示：申请人=当前用户时说明默认不能自批（单人团队由内核放行）", async () => {
    mockCommonGet(approvalItem({ requested_by: 1, requester_name: "我" }));
    await openDetail();
    expect(document.body.textContent).toContain("默认不能自批");
  });

  it("后端拒绝（403 SELF_APPROVAL）：错误原文显示在确认弹窗，不吞掉原因", async () => {
    mockCommonGet(approvalItem());
    vi.mocked(apiClient.post).mockRejectedValue(
      Object.assign(new Error("Forbidden"), {
        response: {
          status: 403,
          data: {
            detail: {
              error: "forbidden",
              code: "SELF_APPROVAL",
              detail: "不能审批自己提交的申请",
            },
          },
        },
      }),
    );
    await openDetail();

    click(buttonByText("批准"));
    await settle();
    click(buttonByText("确认批准"));
    await settle(6);

    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("不能审批自己提交的申请");
    expect(toastSuccess).not.toHaveBeenCalledWith(
      expect.stringContaining("已批准"),
    );
  });
});
