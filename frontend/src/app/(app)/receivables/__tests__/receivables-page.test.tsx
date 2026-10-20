import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";

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
vi.mock("@/components/route-guard", () => ({
  RouteGuard: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/lib/events/use-page-view", () => ({ usePageView: () => {} }));

import ReceivablesPage from "../page";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TODAY = new Date(2026, 9, 21);

type GetResp = Awaited<ReturnType<typeof apiClient.get>>;
const ok = (data: unknown) => ({ data }) as unknown as GetResp;

const ROWS = [
  {
    id: 9001,
    order_id: 11,
    currency: "USD",
    total_amount: 26450,
    received_amount: 7935,
    status: "partial",
    order_no: "ORD-202609-0001",
    customer_name: "Lone Star Fence Co",
  },
  {
    id: 9002,
    order_id: 12,
    currency: "USD",
    total_amount: 12300,
    received_amount: 0,
    status: "unpaid",
    order_no: "ORD-202609-0002",
    customer_name: "Gulf Coast Wire Mesh",
  },
];

function receivableCalls() {
  return vi
    .mocked(apiClient.get)
    .mock.calls.filter(([url]) => String(url) === "/receivables");
}

function financialCalls() {
  return receivableCalls().map(([, config]) => (config as { params?: Record<string, unknown> })?.params);
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

function text() {
  return container!.textContent ?? "";
}

async function mount() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      <QueryClientProvider client={client!}>
        <ReceivablesPage />
      </QueryClientProvider>,
    ),
  );
  await settle();
}

async function changeSelect(el: HTMLSelectElement, value: string) {
  await act(async () => {
    el.value = value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await settle();
}

async function typeInput(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  await act(async () => {
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function toggle(el: HTMLInputElement) {
  await act(async () => {
    el.click();
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.setSystemTime?.(TODAY);
  vi.mocked(apiClient.get).mockImplementation(async (url: string, config) => {
    const path = String(url);
    const params = (config as { params?: Record<string, unknown> })?.params ?? {};
    if (path === "/receivables") {
      // 列表与汇总窗口都命中这里：按 page_size 区分返回集
      if (params.page_size === 200) {
        return ok({ items: ROWS, total: ROWS.length, page: 1, page_size: 200 });
      }
      const status = params.status;
      const items = status ? ROWS.filter((row) => row.status === status) : ROWS;
      return ok({ items, total: 45, page: Number(params.page ?? 1), page_size: 20 });
    }
    const scheduleMatch = /^\/orders\/(\d+)\/payment-schedules$/.exec(path);
    if (scheduleMatch) {
      const orderId = Number(scheduleMatch[1]);
      // 订单 11 有一期已过期未付；订单 12 没有计划 ⇒ 逾期列「未知」
      const items =
        orderId === 11
          ? [{ id: 1, order_id: 11, status: "pending", due_date: "2026-10-01", amount: 7935 }]
          : [];
      return ok({ items, total: items.length });
    }
    return ok({ items: [], total: 0 });
  });
});

afterEach(() => {
  vi.useRealTimers();
  if (root) act(() => root!.unmount());
  container?.remove();
  client?.clear();
  root = null;
  container = null;
  client = null;
});

describe("应收台账页面（C36 #7）", () => {
  it("汇总卡按币种显示总额/已收/未收；列表显示 45 条总数与分页范围", async () => {
    await mount();

    const body = text();
    expect(body).toContain("应收台账");
    // 汇总：两行都 USD ⇒ total 38750 / received 7935 / outstanding 30815
    expect(body).toContain("USD 38,750.00");
    expect(body).toContain("USD 7,935.00");
    expect(body).toContain("USD 30,815.00");
    // 分页条：currentCount=2，total=45
    expect(body).toContain("第 1–2 条 / 共 45 条");
    // 首屏请求：默认 page=1、page_size=20、无 status
    expect(financialCalls()[0]).toMatchObject({ page: 1, page_size: 20 });
  });

  it("逾期红标来自该订单收款计划的到期日；无计划显示「未知」", async () => {
    await mount();
    await settle();

    const alert = container!.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    // 订单 11 最早未付到期 2026-10-01 ⇒ 逾期 20 天（系统时间已固定为 10-21）
    expect(alert!.textContent).toContain("逾期 20 天");
    expect(text()).toContain("未知");
  });

  it("状态筛选走服务端参数，并把页码重置为 1", async () => {
    await mount();
    const select = container!.querySelector<HTMLSelectElement>('select[aria-label="状态筛选"]')!;
    await changeSelect(select, "unpaid");

    const last = financialCalls().filter((p) => p?.page_size === 20).at(-1);
    expect(last).toMatchObject({ status: "unpaid", page: 1 });
  });

  it("客户名筛选与「只看逾期」只作用于当前页，并如实提示范围", async () => {
    await mount();
    await settle();

    // 客户名筛选：只剩 Lone Star
    const customerInput = container!.querySelector<HTMLInputElement>(
      'input[aria-label="客户筛选"]',
    )!;
    await typeInput(customerInput, "lone");
    expect(text()).toContain("Lone Star Fence Co");
    expect(text()).not.toContain("Gulf Coast Wire Mesh");

    // 清空客户 + 只看逾期：只剩真实逾期那行
    await typeInput(customerInput, "");
    const onlyOverdue = container!.querySelector<HTMLInputElement>(
      'input[aria-label="只看逾期"]',
    )!;
    await toggle(onlyOverdue);
    expect(text()).toContain("Lone Star Fence Co");
    expect(text()).not.toContain("Gulf Coast Wire Mesh");
    // 界面明确标注作用于当前页（不装成全量筛选）
    expect(text()).toContain("当前页");
  });
});
