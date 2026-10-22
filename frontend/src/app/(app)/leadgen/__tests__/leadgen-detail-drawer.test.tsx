/**
 * 线索详情抽屉（U-P0B6/X2）。
 *
 * 旧实现：详情是列表下方 200 行内联面板（整页下推）。
 * 现在：DetailDrawer（右侧抽屉）+ 打开→关闭→焦点归还 + 筛选变化不影响已打开详情。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));

vi.mock("@/lib/api/client", () => {
  const client = { get: mocks.get, post: mocks.post, patch: vi.fn() };
  return { default: client, apiClient: client };
});
vi.mock("@/components/route-guard", () => ({
  RouteGuard: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/lib/events/use-page-view", () => ({ usePageView: () => {} }));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import LeadgenPage from "../page";

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
  phone: "+1 555 0100",
  industry: "fence",
  google_rating: 4.5,
  google_reviews: 20,
  fit_score: 80,
  fit_reasons: ["匹配"],
  opening_line: null,
  outreach_status: "none",
  inquiry_status: "none",
  demand_index: null,
  blank_index: null,
  created_at: "2026-10-01T00:00:00Z",
  shop_type: "retail",
  product_name: null,
  product_name_cn: null,
  product_image_url: null,
  spec_raw: null,
  link_url: null,
  can_supply: null,
  supply_notes: null,
  crawl_status: "pending",
  crawled_at: null,
};
const DETAIL = {
  ...LEAD,
  outreach_history: [],
  inquiry_history: [],
};

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

function findExactButton(text: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll("button")).find(
    (b) => (b.textContent ?? "").trim() === text,
  );
  if (!button) throw new Error(`没找到按钮「${text}」`);
  return button;
}

async function click(el: HTMLElement) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await settle(2);
}

function setSearch(value: string) {
  const el = document.querySelector<HTMLInputElement>(
    'input[placeholder="搜索公司 / 城市…"]',
  );
  if (!el) throw new Error("没找到搜索框");
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockImplementation(async (url: string) => {
    if (url === "/leadgen/regions") return { data: { items: [] } };
    if (url === "/leadgen/runs") return { data: { items: [] } };
    if (url === "/leads/9") return { data: DETAIL };
    if (String(url).startsWith("/leads"))
      return { data: { items: [LEAD], total: 1 } };
    return { data: { items: [] } };
  });
});

afterEach(() => {
  unmount();
  vi.restoreAllMocks();
});

describe("线索详情 · DetailDrawer", () => {
  it("详情打开为右侧抽屉；关闭后焦点回到「详情」按钮", async () => {
    mount();
    await waitFor(
      () => (document.body.textContent ?? "").includes(LEAD.company_name),
      undefined,
      "线索列表加载",
    );

    const detailButton = findButton("详情");
    await click(detailButton);
    await waitFor(
      () => document.querySelector('[role="dialog"]') !== null,
      undefined,
      "抽屉打开",
    );

    const drawer = document.querySelector('[role="dialog"]')!;
    expect(drawer.textContent).toContain(LEAD.company_name);
    expect(drawer.textContent).toContain("Google 评分");
    expect(drawer.textContent).toContain("产品信息（来自官网爬取）");

    await click(findExactButton("关闭"));
    await waitFor(
      () => document.querySelector('[role="dialog"]') === null,
      undefined,
      "抽屉关闭",
    );
    expect(document.activeElement).toBe(detailButton);
  });

  it("筛选变化后已打开的详情不被清掉", async () => {
    mount();
    await waitFor(
      () => (document.body.textContent ?? "").includes(LEAD.company_name),
      undefined,
      "线索列表加载",
    );
    const detailButton = findButton("详情");
    await click(detailButton);
    await waitFor(
      () => document.querySelector('[role="dialog"]') !== null,
      undefined,
      "抽屉打开",
    );

    // 改筛选 ⇒ 列表 key 变化并重取；抽屉内容不受影响
    setSearch("Houston");
    await settle();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain(
      "Google 评分",
    );
  });
});
