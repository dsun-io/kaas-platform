/**
 * M3 仪表盘页面（设计 §7）+ P0-A A3/A5（应收真实数据 / direct 分币种）。
 *
 * 测试范式照 `orders/__tests__/orders-pagination.test.tsx`：react-dom/client + act，
 * 不用 @testing-library/react（本项目未引入）；只 mock apiClient 与页面级副作用。
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
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import DashboardPage from "../page";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type GetResp = Awaited<ReturnType<typeof apiClient.get>>;
const ok = (data: unknown) => ({ data }) as unknown as GetResp;

interface StageFixture {
  name: string;
  label: string;
  count: number;
  amount?: number;
}

interface ChannelFixture {
  channel: string;
  inquiry_count: number;
  quote_count: number;
  order_count: number;
  completed_count: number;
  conversion_rates: {
    inquiry_to_order: number | null;
    inquiry_to_completed: number | null;
  };
  composite_score: number;
}

interface DirectCurrencyFixture {
  currency: string;
  count: number;
  amount: number;
}

interface RatesFixture {
  inquiry_to_quote: number | null;
  quote_to_order: number | null;
  order_to_completed: number | null;
  inquiry_to_completed: number | null;
}

interface PayloadOverrides {
  stages?: StageFixture[];
  rates?: RatesFixture;
  channels?: ChannelFixture[];
  direct?: {
    count: number;
    amount: number;
    by_currency?: DirectCurrencyFixture[];
  };
}

interface ReceivableCurrencyFixture {
  currency: string;
  total: number;
  received: number;
  outstanding: number;
  count: number;
}

interface ReceivableStatusFixture {
  status: string;
  count: number;
  total: number;
}

interface ReceivablesOverrides {
  by_currency?: ReceivableCurrencyFixture[];
  by_status?: ReceivableStatusFixture[];
  totals?: { count: number };
}

const DEFAULT_STAGES: StageFixture[] = [
  { name: "inquiry", label: "询盘", count: 20 },
  { name: "quoted", label: "已报价", count: 12 },
  { name: "ordered", label: "已下单", count: 5 },
  { name: "completed", label: "已成笔", count: 3, amount: 42000 },
];

const EMPTY_STAGES: StageFixture[] = [
  { name: "inquiry", label: "询盘", count: 0 },
  { name: "quoted", label: "已报价", count: 0 },
  { name: "ordered", label: "已下单", count: 0 },
  { name: "completed", label: "已成笔", count: 0, amount: 0 },
];

const DEFAULT_CHANNELS: ChannelFixture[] = [
  {
    channel: "email",
    inquiry_count: 4,
    quote_count: 2,
    order_count: 1,
    completed_count: 1,
    conversion_rates: { inquiry_to_order: 25, inquiry_to_completed: 25 },
    composite_score: 18,
  },
  {
    channel: "alibaba",
    inquiry_count: 10,
    quote_count: 6,
    order_count: 3,
    completed_count: 2,
    conversion_rates: { inquiry_to_order: 30, inquiry_to_completed: 20 },
    composite_score: 52,
  },
  {
    channel: "other",
    inquiry_count: 6,
    quote_count: 4,
    order_count: 1,
    completed_count: 0,
    conversion_rates: { inquiry_to_order: 16.67, inquiry_to_completed: 0 },
    composite_score: 24,
  },
];

function payload(overrides: PayloadOverrides = {}) {
  const stages = overrides.stages ?? DEFAULT_STAGES;
  const inquiryCount = stages[0]?.count ?? 0;
  const quotedCount = stages[1]?.count ?? 0;
  const orderedCount = stages[2]?.count ?? 0;
  return {
    range: "today",
    since: "2026-10-22T00:00:00+00:00",
    funnel: {
      stages,
      conversion_rates: overrides.rates ?? {
        inquiry_to_quote: 60,
        quote_to_order: 41.67,
        order_to_completed: 60,
        inquiry_to_completed: 15,
      },
      // 与内核 compute_composite_score 同式：询盘×1 + 报价×2 + 订单×10
      composite_score: inquiryCount + quotedCount * 2 + orderedCount * 10,
    },
    channels: overrides.channels ?? DEFAULT_CHANNELS,
    direct_orders: overrides.direct ?? { count: 2, amount: 18000 },
    deprecated_summary: false,
  };
}

/** 与内核 since_map 同口径的阶段计数（30d 放大 4 倍，便于断言 range 切换刷新）。 */
function scaledStages(range: string): StageFixture[] {
  const scale = range === "30d" ? 4 : 1;
  return [
    { name: "inquiry", label: "询盘", count: 20 * scale },
    { name: "quoted", label: "已报价", count: 12 * scale },
    { name: "ordered", label: "已下单", count: 5 * scale },
    {
      name: "completed",
      label: "已成笔",
      count: 3 * scale,
      amount: 42000 * scale,
    },
  ];
}

function receivablesPayload(overrides: ReceivablesOverrides = {}) {
  return {
    range: "today",
    since: "2026-10-22T00:00:00+00:00",
    by_currency: overrides.by_currency ?? [
      {
        currency: "USD",
        total: 25000,
        received: 16000,
        outstanding: 9000,
        count: 3,
      },
    ],
    by_status: overrides.by_status ?? [
      { status: "unpaid", count: 2, total: 20000 },
      { status: "paid", count: 1, total: 5000 },
    ],
    totals: overrides.totals ?? { count: 3 },
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

function mount() {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const tree: ReactNode = (
    <QueryClientProvider client={client}>
      <DashboardPage />
    </QueryClientProvider>
  );
  act(() => root!.render(tree));
}

/** 从 axios 请求配置里取 range 参数（mock 的 config 是 unknown，测试里按需收窄）。 */
function requestedRange(config?: unknown): string {
  const params = (config as { params?: { range?: string } } | undefined)
    ?.params;
  return params?.range ?? "today";
}

function callsTo(path: string) {
  return vi
    .mocked(apiClient.get)
    .mock.calls.filter(([url]) => String(url) === path);
}

function funnelCalls() {
  return callsTo("/dashboard/funnel");
}

function receivablesCalls() {
  return callsTo("/dashboard/receivables");
}

function lastRangeParam(): string | undefined {
  const calls = funnelCalls();
  const config = calls[calls.length - 1]?.[1];
  return requestedRange(config);
}

/** 按 URL 路由 mock：两个端点可各自成功/失败/挂起。 */
function mockDashboardApis(
  funnel: (range: string) => unknown,
  receivables: (range: string) => unknown,
) {
  vi.mocked(apiClient.get).mockImplementation(
    async (url: string, config?: unknown) => {
      const path = String(url);
      const range = requestedRange(config);
      if (path === "/dashboard/receivables") {
        return ok(receivables(range));
      }
      return ok(funnel(range));
    },
  );
}

function textOf(selector: string): string {
  const node = container!.querySelector(selector);
  if (!node) throw new Error(`找不到元素 ${selector}`);
  return node.textContent?.trim() ?? "";
}

function button(label: string, scope: ParentNode = container!) {
  return Array.from(scope.querySelectorAll("button")).find((el) =>
    (el.textContent ?? "").includes(label),
  );
}

function stageCount(name: string): string {
  return textOf(`[data-testid="funnel-stage-count-${name}"]`);
}

beforeEach(() => {
  vi.resetAllMocks();
  mockDashboardApis(
    (range) => payload({ stages: scaledStages(range) }),
    () => receivablesPayload(),
  );
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  client?.clear();
  root = null;
  container = null;
  client = null;
});

describe("DashboardPage · 加载与错误", () => {
  it("加载中：保留唯一 h1 页头，数据区是骨架（aria-busy）而不是纯文本", async () => {
    mount();

    expect(container!.querySelector("h1")?.textContent).toBe("仪表盘");
    expect(
      container!.querySelectorAll('[aria-busy="true"]').length,
    ).toBeGreaterThan(0);

    await settle();
  });

  it("错误：页头仍在，显示可重试的错误提示，点重试会重新请求", async () => {
    mockDashboardApis(
      () => {
        throw new Error("boom");
      },
      () => receivablesPayload(),
    );
    mount();
    await settle();

    expect(container!.querySelector("h1")?.textContent).toBe("仪表盘");
    expect(container!.textContent).toContain("读取仪表盘数据失败");
    expect(container!.textContent).toContain("boom");
    const before = funnelCalls().length;

    await act(async () => {
      button("重试")!.click();
    });
    await settle();

    expect(funnelCalls().length).toBeGreaterThan(before);
  });

  it("应收加载中：只该卡显示骨架（不拖住已就绪的漏斗）", async () => {
    let resolveReceivables: ((value: GetResp) => void) | null = null;
    vi.mocked(apiClient.get).mockImplementation(
      async (url: string, config?: unknown) => {
        if (String(url) === "/dashboard/receivables") {
          return new Promise<GetResp>((resolve) => {
            resolveReceivables = resolve;
          });
        }
        return ok(payload({ stages: scaledStages(requestedRange(config)) }));
      },
    );

    mount();
    await settle();

    // 漏斗已渲染；应收卡在骨架态
    expect(stageCount("inquiry")).toBe("20");
    expect(container!.textContent).toContain("订单应收概览");
    expect(container!.querySelectorAll('[aria-busy="true"]').length).toBe(1);

    await act(async () => {
      resolveReceivables!(ok(receivablesPayload()));
    });
    await settle();

    expect(container!.querySelectorAll('[aria-busy="true"]').length).toBe(0);
    expect(container!.textContent).toContain("共 3 笔应收");
  });

  it("应收错误：ErrorState（role=alert）只在本卡，重试只重发应收请求", async () => {
    mockDashboardApis(
      () => payload(),
      () => {
        throw new Error("receivables boom");
      },
    );
    mount();
    await settle();

    const alert = container!.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toContain("应收数据读取失败");
    expect(alert!.textContent).toContain("receivables boom");
    // 漏斗不受影响
    expect(stageCount("inquiry")).toBe("20");

    const before = receivablesCalls().length;
    const funnelBefore = funnelCalls().length;
    await act(async () => {
      button("重试", alert!)!.click();
    });
    await settle();

    expect(receivablesCalls().length).toBe(before + 1);
    expect(funnelCalls().length).toBe(funnelBefore);
  });
});

describe("DashboardPage · 空态", () => {
  it("时间窗内没有询盘/应收/直接下单：三个明确空态 +「看近 30 天」可切范围", async () => {
    mockDashboardApis(
      (range) => {
        if (range === "30d") {
          return payload({
            stages: [
              { name: "inquiry", label: "询盘", count: 80 },
              { name: "quoted", label: "已报价", count: 40 },
              { name: "ordered", label: "已下单", count: 10 },
              { name: "completed", label: "已成笔", count: 4, amount: 90000 },
            ],
          });
        }
        return payload({
          stages: EMPTY_STAGES,
          channels: [],
          direct: { count: 0, amount: 0 },
        });
      },
      () =>
        receivablesPayload({
          by_currency: [],
          by_status: [],
          totals: { count: 0 },
        }),
    );

    mount();
    await settle();

    expect(container!.textContent).toContain("该时间窗内还没有询盘");
    expect(container!.textContent).toContain("暂无渠道数据");
    expect(container!.textContent).toContain("本时间窗内没有直接下单");
    expect(container!.textContent).toContain("本时间窗内没有应收");

    await act(async () => {
      button("看近 30 天")!.click();
    });
    await settle();

    expect(lastRangeParam()).toBe("30d");
    expect(stageCount("inquiry")).toBe("80");
  });
});

describe("DashboardPage · 有数据", () => {
  it("四阶段数字 / 成交金额 / 转化率 / 综合分 / 直接下单都按后端值渲染", async () => {
    mount();
    await settle();

    expect(stageCount("inquiry")).toBe("20");
    expect(stageCount("quoted")).toBe("12");
    expect(stageCount("ordered")).toBe("5");
    expect(stageCount("completed")).toBe("3");
    expect(container!.textContent).toContain("成交金额 42,000.00");

    expect(textOf('[data-testid="conversion-inquiry_to_quote"]')).toBe("60%");
    expect(textOf('[data-testid="conversion-quote_to_order"]')).toBe("41.67%");
    expect(textOf('[data-testid="conversion-order_to_completed"]')).toBe("60%");
    expect(textOf('[data-testid="conversion-inquiry_to_completed"]')).toBe(
      "15%",
    );
    // 综合分 = 20×1 + 12×2 + 5×10 = 94（内核 D-6 权重）
    expect(textOf('[data-testid="composite-score"]')).toBe("94");

    expect(textOf('[data-testid="direct-orders-count"]')).toBe("2");
    expect(textOf('[data-testid="direct-orders-amount"]')).toBe("18,000.00");

    // 新页面不再依赖废弃的三表混计数端点
    const urls = vi
      .mocked(apiClient.get)
      .mock.calls.map(([url]) => String(url));
    expect(urls).toContain("/dashboard/funnel");
    expect(urls).toContain("/dashboard/receivables");
    expect(urls).not.toContain("/dashboard/summary");
  });

  it("分渠道表按综合分降序，渠道显示中文标签", async () => {
    mount();
    await settle();

    // 页面上有多张表（渠道 / 直接下单 / 应收）⇒ 按 aria-label 精确定位渠道表
    const channelTable = container!.querySelector(
      'table[aria-label="分渠道转化"]',
    );
    expect(channelTable).not.toBeNull();
    const channelRows = Array.from(channelTable!.querySelectorAll("tbody tr"));
    expect(
      channelRows.map((row) => row.querySelector("td")?.textContent?.trim()),
    ).toEqual(["阿里巴巴", "其他", "邮件"]);

    const firstRowCells = Array.from(
      channelRows[0]!.querySelectorAll("td"),
    ).map((cell) => cell.textContent?.trim());
    expect(firstRowCells).toEqual([
      "阿里巴巴",
      "10",
      "6",
      "3",
      "2",
      "30%",
      "20%",
      "52",
    ]);
  });

  it("转化率分母为 0（后端 null）显示「—」，不渲染成 0%", async () => {
    mockDashboardApis(
      () =>
        payload({
          rates: {
            inquiry_to_quote: null,
            quote_to_order: null,
            order_to_completed: null,
            inquiry_to_completed: null,
          },
          channels: [
            {
              channel: "email",
              inquiry_count: 3,
              quote_count: 0,
              order_count: 0,
              completed_count: 0,
              conversion_rates: {
                inquiry_to_order: 0,
                inquiry_to_completed: 0,
              },
              composite_score: 3,
            },
          ],
        }),
      () => receivablesPayload(),
    );

    mount();
    await settle();

    expect(textOf('[data-testid="conversion-inquiry_to_quote"]')).toBe("—");
    expect(textOf('[data-testid="conversion-quote_to_order"]')).toBe("—");
    expect(textOf('[data-testid="conversion-order_to_completed"]')).toBe("—");
    expect(textOf('[data-testid="conversion-inquiry_to_completed"]')).toBe("—");
    // 渠道级 0% 是"算出来就是 0"，必须显示 0% 而不是「—」
    expect(
      textOf('table[aria-label="分渠道转化"] tbody tr td:nth-child(6)'),
    ).toBe("0%");
  });
});

describe("DashboardPage · 应收真实数据（P0-A A3）", () => {
  it("按币种分行显示 total/received/outstanding/count，并给状态笔数摘要", async () => {
    mockDashboardApis(
      () => payload(),
      () =>
        receivablesPayload({
          by_currency: [
            {
              currency: "EUR",
              total: 5000,
              received: 1000,
              outstanding: 4000,
              count: 1,
            },
            {
              currency: "USD",
              total: 20000,
              received: 15000,
              outstanding: 5000,
              count: 2,
            },
          ],
          by_status: [
            { status: "paid", count: 1, total: 5000 },
            { status: "unpaid", count: 2, total: 20000 },
          ],
          totals: { count: 3 },
        }),
    );

    mount();
    await settle();

    const eur = container!.querySelector(
      '[data-testid="receivable-currency-EUR"]',
    );
    const usd = container!.querySelector(
      '[data-testid="receivable-currency-USD"]',
    );
    expect(eur?.textContent).toContain("5,000.00");
    expect(eur?.textContent).toContain("1,000.00");
    expect(eur?.textContent).toContain("4,000.00");
    expect(usd?.textContent).toContain("20,000.00");
    expect(usd?.textContent).toContain("15,000.00");
    expect(usd?.textContent).toContain("5,000.00");

    // 多币种不合并金额：不得出现两币种原值相加的假数字
    expect(container!.textContent).not.toContain("25,000.00");
    expect(container!.textContent).toContain("多币种按行分列，未做跨币种合计");

    // 状态摘要按 unpaid→partial→paid 固定顺序（接口顺序被重排）
    const statusChips = Array.from(
      container!.querySelectorAll('[data-testid^="receivable-status-"]'),
    ).map((el) => el.textContent?.trim());
    expect(statusChips).toEqual(["未收 2 笔", "已收清 1 笔"]);
  });
});

describe("DashboardPage · 直接下单分币种（P0-A A5）", () => {
  it("有 by_currency 时按币种展示 count/amount，顶层 amount 降级为口径脚注", async () => {
    mockDashboardApis(
      () =>
        payload({
          direct: {
            count: 3,
            amount: 25000,
            by_currency: [
              { currency: "EUR", count: 1, amount: 5000 },
              { currency: "USD", count: 2, amount: 20000 },
            ],
          },
        }),
      () => receivablesPayload(),
    );

    mount();
    await settle();

    expect(textOf('[data-testid="direct-orders-count"]')).toBe("3");
    const cellsOf = (currency: string) =>
      Array.from(
        container!.querySelectorAll(
          `[data-testid="direct-currency-${currency}"] td`,
        ),
      ).map((cell) => cell.textContent?.trim());
    expect(cellsOf("EUR")).toEqual(["EUR", "1", "5,000.00"]);
    expect(cellsOf("USD")).toEqual(["USD", "2", "20,000.00"]);

    // 跨币种原值相加只做脚注提示，不冒充可加总金额
    expect(textOf('[data-testid="direct-orders-amount"]')).toBe("25,000.00");
    expect(container!.textContent).toContain("跨币种原值相加为");
    expect(container!.textContent).toContain("未折算汇率");
  });
});

describe("DashboardPage · 时间范围", () => {
  it("切换近 90 天：漏斗与应收都按 range=90d 重新请求并刷新", async () => {
    mockDashboardApis(
      (range) => {
        const count = range === "90d" ? 180 : 20;
        return payload({
          stages: [
            { name: "inquiry", label: "询盘", count },
            { name: "quoted", label: "已报价", count: Math.round(count / 2) },
            { name: "ordered", label: "已下单", count: Math.round(count / 4) },
            {
              name: "completed",
              label: "已成笔",
              count: Math.round(count / 10),
              amount: 0,
            },
          ],
        });
      },
      () => receivablesPayload(),
    );

    mount();
    await settle();

    expect(funnelCalls()).toHaveLength(1);
    expect(receivablesCalls()).toHaveLength(1);
    expect(lastRangeParam()).toBe("today");

    const ninetyDay = Array.from(
      container!.querySelectorAll<HTMLButtonElement>('[role="radio"]'),
    ).find((radio) => radio.textContent?.trim() === "近 90 天");
    expect(ninetyDay).toBeDefined();

    await act(async () => {
      ninetyDay!.click();
    });
    await settle();

    expect(funnelCalls()).toHaveLength(2);
    expect(receivablesCalls()).toHaveLength(2);
    expect(lastRangeParam()).toBe("90d");
    const lastReceivablesConfig = receivablesCalls()[1]?.[1];
    expect(requestedRange(lastReceivablesConfig)).toBe("90d");
    expect(stageCount("inquiry")).toBe("180");
  });
});
