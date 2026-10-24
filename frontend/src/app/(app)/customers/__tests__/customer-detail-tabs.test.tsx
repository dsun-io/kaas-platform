/**
 * 问题 5：客户详情「询盘」tab 的计数要把**订单**算进去。
 *
 * 钉死的口径：
 *   1. tab 计数 = 询盘数 + 订单数；订单来自详情页 `GET /customers/{id}/records`
 *      的树（报价下的订单 + 直接归属客户的订单），不是列表页当前页条数；
 *   2. 计数与内容必须对得上：有询盘来源的订单在询盘卡片的最新一步（订单号/状态）
 *      里可见；没有询盘来源的订单（直接下单 / 未关联询盘报价下的）在
 *      「直接下单（正常分类）」区块单独列出 —— 不允许「计数加了、内容看不到」；
 *   3. 纯订单客户（0 询盘）不显示「暂无询盘」空态；
 *   4. records 还没回来 / 读不到时，订单数未知，显示 "N+" 而不是 0（不误导）。
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
// 详情抽屉里的单证预览/阶段历史会读团队快照与其它端点：给一个平台管理员快照，
// 未列出的端点统一回空（本用例只关心 tab 计数与订单可见性）。
vi.mock("@/lib/team/team-context", () => ({
  useTeam: () => ({
    snapshot: {
      ok: true,
      isPlatformAdmin: true,
      workstations: [],
      codes: ["full_chain"],
    },
  }),
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { CustomerDetailPanel } from "../components/customer-detail-panel";
import type { Customer } from "../components/customer-types";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type GetResp = Awaited<ReturnType<typeof apiClient.get>>;
const ok = (data: unknown) => ({ data }) as unknown as GetResp;

const CUSTOMER: Customer = {
  id: 1,
  company_name: "测试客户",
  abbr: "TST",
  country: "US",
  address: null,
  default_port: null,
  credit_level: null,
  stage: "active",
  manual_stage: "active",
  notes: null,
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-01T00:00:00Z",
};

const INQUIRY = {
  id: 101,
  customer_id: 1,
  inquiry_no: "INQ-202610-0101",
  channel: "email",
  product_name_raw: "牛栏网 2.5mm",
  quantity: 1000,
  quantity_unit: "m",
  application: null,
  items: [],
  status: "quoted",
  stage: null,
  created_at: "2026-10-01T00:00:00Z",
};

function detailWith(inquiries: unknown[]): unknown {
  return { ...CUSTOMER, contacts: [], inquiries, stage_log: [] };
}

function recordOrder(id: number, orderNo: string, status = "confirmed") {
  return {
    id,
    order_no: orderNo,
    status,
    currency: "USD",
    total_amount: 1000,
    created_at: "2026-10-02T00:00:00Z",
    source_type: "direct",
    source_channel: null,
    documents: [],
  };
}

function recordQuote(
  id: number,
  quoteNo: string,
  inquiryId: number | null,
  orders: unknown[],
) {
  return {
    id,
    quote_no: quoteNo,
    status: "sent",
    currency: "USD",
    total_amount: 1000,
    created_at: "2026-10-01T00:00:00Z",
    inquiry_id: inquiryId,
    documents: [],
    orders,
  };
}

function recordsPayload(
  quotes: Array<{ orders: unknown[] }>,
  directOrders: unknown[],
) {
  const orderCount =
    quotes.reduce((n, quote) => n + quote.orders.length, 0) +
    directOrders.length;
  return {
    counts: { quotes: quotes.length, orders: orderCount, documents: 0 },
    quotes,
    direct: { orders: directOrders, documents: [] },
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

async function waitFor(check: () => boolean, label: string, timeout = 5000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) {
      throw new Error(
        `等待超时：${label}（当前文本：${(document.body.textContent ?? "").slice(0, 400)}）`,
      );
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
}

async function mountPanel(detail: unknown, records: () => Promise<unknown>) {
  vi.mocked(apiClient.get).mockImplementation(async (url: string) => {
    const path = String(url);
    if (path === "/customers/1") return ok(detail);
    if (path === "/customers/1/records") return ok(await records());
    if (path.startsWith("/inquiries/")) return ok({ items: [] });
    return ok({});
  });
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      <QueryClientProvider client={client!}>
        <CustomerDetailPanel
          customer={CUSTOMER}
          onClose={() => {}}
          onUpdated={() => {}}
        />
      </QueryClientProvider>,
    ),
  );
  await settle();
}

function tabTexts(): string[] {
  return Array.from(document.querySelectorAll('button[role="tab"]')).map(
    (button) => button.textContent ?? "",
  );
}

function inquiryTab(): HTMLButtonElement {
  const tab = Array.from(
    document.querySelectorAll<HTMLButtonElement>('button[role="tab"]'),
  ).find((button) => (button.textContent ?? "").includes("询盘/订单"));
  if (!tab)
    throw new Error(`没找到「询盘/订单」tab：${tabTexts().join(" | ")}`);
  return tab;
}

async function openInquiryTab() {
  await waitFor(
    () => /询盘\/订单 \(\d/.test(tabTexts().join("|")),
    "询盘/订单 tab 出现",
  );
  await act(async () => {
    inquiryTab().click();
  });
  await settle();
}

function bodyText(): string {
  return document.body.textContent ?? "";
}

beforeEach(() => {
  vi.resetAllMocks();
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

describe("客户详情「询盘/订单」tab 计数（问题 5）", () => {
  it("计数 = 询盘数 + 订单数，且每个被计数的订单都能在 tab 内容里找到", async () => {
    // 1 条询盘；3 笔订单：询盘报价下的 ORD-201、未关联询盘报价下的 ORD-202、
    // 直接归属客户的 ORD-203。
    await mountPanel(detailWith([INQUIRY]), async () =>
      recordsPayload(
        [
          recordQuote(11, "QUO-11", 101, [recordOrder(201, "ORD-201")]),
          recordQuote(12, "QUO-12", null, [recordOrder(202, "ORD-202")]),
        ],
        [recordOrder(203, "ORD-203", "shipped")],
      ),
    );
    await waitFor(
      () => tabTexts().some((text) => text.includes("询盘/订单 (4)")),
      "tab 计数含订单 (1+3=4)",
    );

    await openInquiryTab();
    // 头部把询盘数/订单数都摊开，用户能对账
    expect(bodyText()).toContain("1 条询盘 · 3 个订单");
    // 有询盘来源的订单：询盘卡片的最新一步带订单号（不用进抽屉也能看到）
    expect(bodyText()).toContain("订单 ORD-201");
    // 没有询盘来源的订单：直接归属客户的 + 未关联询盘报价下的，单独列出
    expect(bodyText()).toContain("ORD-203");
    expect(bodyText()).toContain("ORD-202");
  });

  it("纯订单客户（0 询盘）：计数含订单，不显示「暂无询盘」空态", async () => {
    await mountPanel(detailWith([]), async () =>
      recordsPayload(
        [recordQuote(21, "QUO-21", null, [recordOrder(302, "ORD-302")])],
        [recordOrder(301, "ORD-301")],
      ),
    );
    await waitFor(
      () => tabTexts().some((text) => text.includes("询盘/订单 (2)")),
      "纯订单客户 tab 计数 (0+2=2)",
    );

    await openInquiryTab();
    expect(bodyText()).toContain("0 条询盘 · 2 个订单");
    expect(bodyText()).not.toContain("暂无询盘");
    expect(bodyText()).toContain("ORD-301");
    expect(bodyText()).toContain("ORD-302");
  });

  it("无订单客户：计数只有询盘数", async () => {
    await mountPanel(detailWith([INQUIRY]), async () => recordsPayload([], []));
    await waitFor(
      () => tabTexts().some((text) => text.includes("询盘/订单 (1)")),
      "无订单客户 tab 计数 (1+0=1)",
    );

    await openInquiryTab();
    expect(bodyText()).toContain("1 条询盘 · 0 个订单");
  });

  it("询盘与订单都为 0 时才显示「暂无询盘」", async () => {
    await mountPanel(detailWith([]), async () => recordsPayload([], []));
    await waitFor(
      () => tabTexts().some((text) => text.includes("询盘/订单 (0)")),
      "空客户 tab 计数 (0)",
    );

    await openInquiryTab();
    expect(bodyText()).toContain("暂无询盘");
  });

  it("records 读不到时订单数未知：显示 N+ 而不是假 0", async () => {
    await mountPanel(detailWith([INQUIRY]), async () => {
      throw new Error("records down");
    });
    await waitFor(
      () => tabTexts().some((text) => text.includes("询盘/订单 (1+)")),
      "订单数未知时显示 1+",
    );

    await openInquiryTab();
    expect(bodyText()).toContain("订单暂时读不到");
    expect(bodyText()).not.toContain("0 个订单");
  });
});
