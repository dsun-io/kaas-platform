/**
 * M3 仪表盘页面（设计 §7）—— 加载 / 错误 / 空态 / 有数据 / 时间范围切换。
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
  direct?: { count: number; amount: number };
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

function funnelCalls() {
  return vi
    .mocked(apiClient.get)
    .mock.calls.filter(([url]) => String(url) === "/dashboard/funnel");
}

/** 从 axios 请求配置里取 range 参数（mock 的 config 是 unknown，测试里按需收窄）。 */
function requestedRange(config?: unknown): string {
  const params = (config as { params?: { range?: string } } | undefined)
    ?.params;
  return params?.range ?? "today";
}

function lastRangeParam(): string | undefined {
  const calls = funnelCalls();
  const config = calls[calls.length - 1]?.[1];
  return requestedRange(config);
}

function textOf(selector: string): string {
  const node = container!.querySelector(selector);
  if (!node) throw new Error(`找不到元素 ${selector}`);
  return node.textContent?.trim() ?? "";
}

function button(label: string) {
  return Array.from(container!.querySelectorAll("button")).find((el) =>
    (el.textContent ?? "").includes(label),
  );
}

function stageCount(name: string): string {
  return textOf(`[data-testid="funnel-stage-count-${name}"]`);
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(apiClient.get).mockImplementation(
    async (_url: string, config?: unknown) => {
      const range = requestedRange(config);
      const scale = range === "30d" ? 4 : 1;
      return ok(
        payload({
          stages: [
            { name: "inquiry", label: "询盘", count: 20 * scale },
            { name: "quoted", label: "已报价", count: 12 * scale },
            { name: "ordered", label: "已下单", count: 5 * scale },
            {
              name: "completed",
              label: "已成笔",
              count: 3 * scale,
              amount: 42000 * scale,
            },
          ],
        }),
      );
    },
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
    vi.mocked(apiClient.get).mockRejectedValue(new Error("boom"));
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
});

describe("DashboardPage · 空态", () => {
  it("时间窗内没有询盘：漏斗/渠道/直接下单都是明确空态，「看近 30 天」可切范围", async () => {
    vi.mocked(apiClient.get).mockImplementation(
      async (_url: string, config?: unknown) => {
        const range = requestedRange(config);
        if (range === "30d") {
          return ok(
            payload({
              stages: [
                { name: "inquiry", label: "询盘", count: 80 },
                { name: "quoted", label: "已报价", count: 40 },
                { name: "ordered", label: "已下单", count: 10 },
                { name: "completed", label: "已成笔", count: 4, amount: 90000 },
              ],
            }),
          );
        }
        return ok(
          payload({
            stages: EMPTY_STAGES,
            channels: [],
            direct: { count: 0, amount: 0 },
          }),
        );
      },
    );

    mount();
    await settle();

    expect(container!.textContent).toContain("该时间窗内还没有询盘");
    expect(container!.textContent).toContain("暂无渠道数据");
    expect(container!.textContent).toContain("本时间窗内没有直接下单");
    // 应收概览永远是「待补后端」空态（没有聚合端点，不造数）
    expect(container!.textContent).toContain("待补后端聚合接口");

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
    expect(urls).not.toContain("/dashboard/summary");
  });

  it("分渠道表按综合分降序，渠道显示中文标签", async () => {
    mount();
    await settle();

    const rows = Array.from(container!.querySelectorAll("tbody tr"));
    expect(
      rows.map((row) => row.querySelector("td")?.textContent?.trim()),
    ).toEqual(["阿里巴巴", "其他", "邮件"]);

    // 第一行（alibaba=52 分）列值：询盘 10 / 报价 6 / 订单 3 / 已成笔 2 / 30% / 20% / 52
    const firstRowCells = Array.from(rows[0]!.querySelectorAll("td")).map(
      (cell) => cell.textContent?.trim(),
    );
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
    vi.mocked(apiClient.get).mockImplementation(async () =>
      ok(
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
      ),
    );

    mount();
    await settle();

    expect(textOf('[data-testid="conversion-inquiry_to_quote"]')).toBe("—");
    expect(textOf('[data-testid="conversion-quote_to_order"]')).toBe("—");
    expect(textOf('[data-testid="conversion-order_to_completed"]')).toBe("—");
    expect(textOf('[data-testid="conversion-inquiry_to_completed"]')).toBe("—");
    // 渠道级 0% 是"算出来就是 0"，必须显示 0% 而不是「—」
    expect(textOf("tbody tr td:nth-child(6)")).toBe("0%");
  });
});

describe("DashboardPage · 时间范围", () => {
  it("切换近 90 天：按 range=90d 重新请求并刷新漏斗数字", async () => {
    vi.mocked(apiClient.get).mockImplementation(
      async (_url: string, config?: unknown) => {
        const range = requestedRange(config);
        const count = range === "90d" ? 180 : 20;
        return ok(
          payload({
            stages: [
              { name: "inquiry", label: "询盘", count },
              { name: "quoted", label: "已报价", count: Math.round(count / 2) },
              {
                name: "ordered",
                label: "已下单",
                count: Math.round(count / 4),
              },
              {
                name: "completed",
                label: "已成笔",
                count: Math.round(count / 10),
                amount: 0,
              },
            ],
          }),
        );
      },
    );

    mount();
    await settle();

    expect(funnelCalls()).toHaveLength(1);
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
    expect(lastRangeParam()).toBe("90d");
    expect(stageCount("inquiry")).toBe("180");
  });
});
