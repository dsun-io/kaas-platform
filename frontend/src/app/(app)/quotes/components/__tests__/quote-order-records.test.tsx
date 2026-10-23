/**
 * 报价单记录视图（`quote-order-records.tsx`）—— 对内/对外双视图测试。
 *
 * 钉死口径（UNCERTAIN #19）：
 * 1. internal 账号：行项明细带 税前成本 / 利润 / 利润率 列（读 cost_breakdown）；
 * 2. customer 账号：**没有**这三列（后端已剥除，前端按账号类型再守卫一次）；
 * 3. 列表展示 报价单号/客户/时间/报价人/金额/状态 全维度。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { QuoteOrderRecords } from "../quote-order-records";

const mocks = vi.hoisted(() => {
  const ITEM = {
    id: 11,
    quote_order_id: 1,
    sku_id: null,
    product_name: "Field Fence",
    spec_snapshot: { specification: "1.5m × 50m" },
    qty: 12,
    qty_unit: "ROLLS",
    unit_price: 301.03,
    currency: "USD",
    line_amount: 3612.36,
    sort_order: 0,
    cost_breakdown: {
      currency_cny_per_m2: {
        cost_pretax: 8.75,
        profit_amount: 1.2,
        quote_excl_vat: 10.1,
      },
    },
    created_at: "2026-10-17T02:30:00.000Z",
  };
  const LIST = {
    items: [
      {
        id: 1,
        quote_no: "QUO-20261017-001",
        customer_id: 1,
        customer_name: "联佳丝网",
        inquiry_id: 1,
        status: "sent",
        currency: "USD",
        total_amount: 3612.36,
        created_by: "1",
        created_at: "2026-10-17T02:30:00.000Z",
        item_count: 1,
      },
    ],
    total: 1,
    page: 1,
    page_size: 50,
  };
  const DETAIL = { ...LIST.items[0], items: [ITEM] };
  return {
    get: vi.fn(),
    accountType: "internal" as string,
    LIST,
    DETAIL,
    /** 当前总数（分页测试改它；默认 1 = 单页，不渲染分页条） */
    total: 1,
    /** useQuoteOrders 收到的参数（分页断言用） */
    calls: [] as Array<{ page?: number; page_size?: number } | undefined>,
  };
});

vi.mock("@/lib/api/client", () => ({
  default: { get: mocks.get },
  apiClient: { get: mocks.get },
}));

vi.mock("../../hooks/use-quote-orders", () => ({
  QUOTE_ORDERS_PAGE_SIZE: 20,
  useQuoteOrders: (params?: { page?: number; page_size?: number }) => {
    mocks.calls.push(params);
    const page = params?.page ?? 1;
    const pageSize = params?.page_size ?? 20;
    const total = Math.max(1, mocks.total);
    const start = (page - 1) * pageSize;
    const count = Math.max(0, Math.min(pageSize, total - start));
    const items = Array.from({ length: count }, (_, i) => ({
      ...mocks.LIST.items[0],
      id: start + i + 1,
      quote_no: `QUO-20261017-${String(start + i + 1).padStart(3, "0")}`,
    }));
    return {
      data: { items, total, page, page_size: pageSize },
      isLoading: false,
      isFetching: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    };
  },
  useQuoteOrder: (id: number | null) => ({
    data: id === 1 ? mocks.DETAIL : null,
    isLoading: false,
  }),
  useUpdateQuoteOrder: () => ({
    mutateAsync: async () => ({}),
    isPending: false,
  }),
}));

vi.mock("@/hooks/use-role", () => ({
  useRole: () => ({ user: { account_type: mocks.accountType } }),
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let client: QueryClient | null = null;

async function settle(times = 3) {
  await act(async () => {
    for (let i = 0; i < times; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
  });
}

function mount(element: ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  root = createRoot(container);
  act(() => {
    root!.render(
      <QueryClientProvider client={client!}>{element}</QueryClientProvider>,
    );
  });
}

function unmount() {
  if (root) act(() => root!.unmount());
  container?.remove();
  client?.clear();
  root = null;
  container = null;
  client = null;
}

/** 点列表第一行（报价单号单元格所在行） */
function clickFirstRow() {
  const cell = Array.from(container!.querySelectorAll("td")).find((td) =>
    td.textContent?.includes("QUO-20261017-001"),
  );
  if (!cell) throw new Error("没找到报价单行");
  act(() => {
    cell.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mount(<QuoteOrderRecords />);
});

afterEach(() => {
  unmount();
});

describe("QuoteOrderRecords 双视图", () => {
  it("internal：列表全维度 + 明细带成本/利润/利润率列", async () => {
    mocks.accountType = "internal";
    await settle();
    const text = document.body.textContent ?? "";
    for (const col of ["报价单号", "客户", "时间", "报价人", "金额", "状态"]) {
      expect(text).toContain(col);
    }
    expect(text).toContain("QUO-20261017-001");
    expect(text).toContain("联佳丝网");

    clickFirstRow();
    await settle();
    const drawerText = document.body.textContent ?? "";
    expect(drawerText).toContain("税前成本");
    expect(drawerText).toContain("利润");
    expect(drawerText).toContain("利润率");
    // 8.75 成本、利润率 = 1.2/10.1 ≈ 11.9%
    expect(drawerText).toContain("8.7500");
    expect(drawerText).toContain("11.9%");
  });

  it("customer：明细**没有**成本/利润列", async () => {
    mocks.accountType = "customer";
    await settle();
    clickFirstRow();
    await settle();
    const drawerText = document.body.textContent ?? "";
    // 对外价格照常可见
    expect(drawerText).toContain("Field Fence");
    expect(drawerText).toContain("301.03");
    // 内部列绝不出现（后端剥除 + 前端守卫双保险）
    expect(drawerText).not.toContain("税前成本");
    expect(drawerText).not.toContain("利润率");
    expect(drawerText).not.toContain("8.7500");
  });
});

/** 改 mocks.total 后重挂（beforeEach 已挂过一次；分页断言要从第 1 页重新开始）。 */
function remount() {
  unmount();
  mocks.calls.length = 0;
  mount(<QuoteOrderRecords />);
}

describe("QuoteOrderRecords 分页（P1-E）", () => {
  function nextButton() {
    return Array.from(document.querySelectorAll("button")).find((b) =>
      (b.textContent ?? "").includes("下一页"),
    ) as HTMLButtonElement | undefined;
  }

  async function clickNext() {
    await act(async () => {
      nextButton()!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle();
  }

  it("默认请求 page=1 / page_size=20，并展示后端 total", async () => {
    mocks.total = 45;
    remount();
    await settle();

    expect(mocks.calls[0]).toMatchObject({ page: 1, page_size: 20 });
    const text = document.body.textContent ?? "";
    expect(text).toContain("共 45 单");
    expect(text).toContain("第 1–20 条 / 共 45 条");
    expect(text).toContain("第 1 / 3 页");
  });

  it("点下一页 ⇒ 请求 page=2，显示第 21–40 条", async () => {
    mocks.total = 45;
    remount();
    await settle();

    await clickNext();

    expect(mocks.calls.at(-1)).toMatchObject({ page: 2, page_size: 20 });
    const text = document.body.textContent ?? "";
    expect(text).toContain("第 21–40 条 / 共 45 条");
    expect(text).toContain("第 2 / 3 页");
  });

  it("末页按实际条数展示（45 条 ⇒ 第 41–45 条，下一页禁用）", async () => {
    mocks.total = 45;
    remount();
    await settle();

    await clickNext();
    await clickNext();

    expect(mocks.calls.at(-1)).toMatchObject({ page: 3 });
    expect(document.body.textContent).toContain("第 41–45 条 / 共 45 条");
    expect(nextButton()!.disabled).toBe(true);
  });

  it("只有一页（total ≤ page_size）时不渲染分页条", async () => {
    mocks.total = 1;
    remount();
    await settle();
    expect(document.body.textContent).not.toContain("上一页");
  });
});
