/**
 * 线索开发 · 批量抓取（U-P0B4 剩余）—— 失败出口 + pending 防重。
 *
 * 「开始抓取」(/leadgen/runs) 与「爬取网站 (10)」(/leads/crawl-batch) 是批量 mutation
 * （区别于单行 crawlOne）：原实现无 pending 防重、失败只重复 toast。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  toastSuccess: vi.fn(),
  toastInfo: vi.fn(),
}));

vi.mock("@/lib/api/client", () => {
  const client = { get: mocks.get, post: mocks.post, patch: vi.fn() };
  return { default: client, apiClient: client };
});
vi.mock("@/components/route-guard", () => ({
  RouteGuard: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/lib/events/use-page-view", () => ({ usePageView: () => {} }));
vi.mock("sonner", () => ({
  toast: {
    success: mocks.toastSuccess,
    error: vi.fn(),
    info: mocks.toastInfo,
  },
}));

import LeadgenPage from "../page";
import {
  CRAWL_STATUS_TONES,
  INQUIRY_STATUS_TONES,
  OUTREACH_STATUS_TONES,
  RUN_STATUS_TONES,
  toneForStatus,
} from "@/lib/status-tones";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const LEAD = {
  id: 9,
  place_id: null,
  company_name: "德克萨斯围栏公司",
  country: "US",
  region: null,
  city: "Houston",
  email: "buyer@example.com",
  website: "https://example.com",
  phone: null,
  industry: "fence",
  google_rating: 4.5,
  google_reviews: 20,
  fit_score: 80,
  fit_reasons: ["匹配"],
  opening_line: null,
  outreach_status: "opened",
  inquiry_status: "won",
  demand_index: null,
  blank_index: null,
  created_at: "2026-10-01T00:00:00Z",
  shop_type: null,
  product_name: null,
  product_name_cn: null,
  product_image_url: null,
  spec_raw: null,
  link_url: null,
  can_supply: null,
  supply_notes: null,
  crawl_status: "blocked",
  crawled_at: null,
};
const RUNS = [
  {
    id: 1,
    status: "succeeded",
    leads_found: 10,
    leads_kept: 8,
    error: null,
    deduplicated: false,
    started_at: "2026-10-01T00:00:00Z",
    finished_at: null,
  },
  {
    id: 2,
    status: "pending",
    leads_found: null,
    leads_kept: null,
    error: null,
    deduplicated: false,
    started_at: null,
    finished_at: null,
  },
];

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let client: QueryClient | null = null;

async function settle(times = 8) {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function waitFor(check: () => boolean, timeout = 5000, label = "条件") {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) {
      throw new Error(
        `等待超时：${label}（当前文本：${document.body.textContent?.slice(0, 400) ?? ""}）`,
      );
    }
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
  }
}

function mount() {
  client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <QueryClientProvider client={client!}>
        <LeadgenPage />
      </QueryClientProvider>,
    );
  });
}

function unmount() {
  if (root) act(() => root!.unmount());
  container?.remove();
  document.body.innerHTML = "";
  root = null;
  container = null;
  client?.clear();
  client = null;
}

function findButton(text: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll("button")).find((b) =>
    (b.textContent ?? "").includes(text),
  );
  if (!button) throw new Error(`没找到按钮「${text}」`);
  return button;
}

function badgeByText(text: string): HTMLElement {
  const badge = Array.from(
    document.querySelectorAll<HTMLElement>("span.badge"),
  ).find((el) => (el.textContent ?? "").trim() === text);
  if (!badge) throw new Error(`没找到徽标「${text}」`);
  return badge;
}

async function click(el: HTMLElement) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await settle(2);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockImplementation(async (url: string) => {
    if (url === "/leadgen/regions") return { data: { items: [] } };
    if (url === "/leadgen/runs") return { data: { items: RUNS } };
    if (String(url).startsWith("/leads"))
      return { data: { items: [LEAD], total: 1 } };
    return { data: { items: [] } };
  });
});

afterEach(() => {
  unmount();
  vi.restoreAllMocks();
});

describe("线索开发 · 批量抓取", () => {
  it("开始抓取失败 → 页内显示原因；pending 期间不重复提交", async () => {
    mocks.post.mockRejectedValue(
      Object.assign(new Error("Unprocessable"), {
        response: {
          status: 422,
          data: {
            detail: {
              error: "validation",
              code: "LEADGEN_QUOTA_EXCEEDED",
              message: "本月抓取配额已用完",
            },
          },
        },
      }),
    );
    mount();
    await waitFor(
      () => (document.body.textContent ?? "").includes("开始抓取"),
      undefined,
      "页面渲染",
    );
    await click(findButton("开始抓取"));
    await settle();

    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("抓取失败");
    expect(alert?.textContent).toContain("本月抓取配额已用完");
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(mocks.post.mock.calls[0]![0]).toBe("/leadgen/runs");

    // pending 防重
    mocks.post.mockImplementation(() => new Promise(() => {}));
    await click(findButton("开始抓取"));
    await settle();
    expect(mocks.post).toHaveBeenCalledTimes(2);
    const pending = findButton("运行中…");
    expect(pending.disabled).toBe(true);
    await click(pending);
    expect(mocks.post).toHaveBeenCalledTimes(2);
  });

  it("批量爬取失败 → 页内显示原因；pending 期间不重复提交", async () => {
    mocks.post.mockRejectedValue(
      Object.assign(new Error("Forbidden"), {
        response: {
          status: 403,
          data: {
            detail: {
              error: "forbidden",
              code: "WORKSTATION_NOT_SUBSCRIBED",
              message: "该工位未开通",
            },
          },
        },
      }),
    );
    mount();
    await waitFor(
      () => (document.body.textContent ?? "").includes("爬取网站"),
      undefined,
      "页面渲染",
    );
    await click(findButton("爬取网站"));
    await settle();

    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("批量爬取失败");
    expect(alert?.textContent).toContain("该工位未开通");
    expect(mocks.post.mock.calls[0]![0]).toBe("/leads/crawl-batch");

    mocks.post.mockImplementation(() => new Promise(() => {}));
    await click(findButton("爬取网站"));
    await settle();
    expect(mocks.post).toHaveBeenCalledTimes(2);
    const pending = findButton("爬取中…");
    expect(pending.disabled).toBe(true);
    await click(pending);
    expect(mocks.post).toHaveBeenCalledTimes(2);
  });
});

describe("线索开发 · 状态 tone 收敛到 lib/status-tones", () => {
  it("列表/历史徽标 tone 与单一来源一致（含行为差异：run pending 由 info→default）", async () => {
    mount();
    await waitFor(
      () => (document.body.textContent ?? "").includes(LEAD.company_name),
      undefined,
      "列表加载",
    );

    // fit_score 80 → success；crawl blocked → danger；outreach opened → purple；inquiry won → success
    expect(badgeByText("80").className).toContain("badge-success");
    expect(badgeByText("被拦截").className).toContain("badge-danger");
    expect(badgeByText("已打开").className).toContain("badge-purple");
    // 运行历史：succeeded → success；pending → default（旧实现兜底 info）
    expect(badgeByText("成功").className).toContain("badge-success");
    expect(badgeByText("待运行").className).toContain("badge-default");

    // 单一来源本身的映射（含列表未渲染的 inquiry 域）
    expect(toneForStatus(INQUIRY_STATUS_TONES, "won")).toBe("success");
    expect(toneForStatus(INQUIRY_STATUS_TONES, "following")).toBe("purple");
    expect(toneForStatus(OUTREACH_STATUS_TONES, "opened")).toBe("purple");
    expect(toneForStatus(CRAWL_STATUS_TONES, "blocked")).toBe("danger");
    expect(toneForStatus(RUN_STATUS_TONES, "pending")).toBe("default");
  });
});
