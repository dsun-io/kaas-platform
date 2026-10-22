/**
 * 线索开发（/leadgen）—— P0-B2/L3+L4：详情失败不再死路 + 扫描已回复 pending 防重。
 *
 * 旧行为：
 * - 「详情」裸 `apiClient.get` 无 catch/无状态 ⇒ 失败时按钮点了没反应（死路）；
 * - 「扫描已回复→询盘」无 pending ⇒ 可重复提交（重复建询盘）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@/lib/api/client", () => {
  const client = {
    get: mocks.get,
    post: mocks.post,
    patch: vi.fn(),
    delete: vi.fn(),
  };
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
    info: vi.fn(),
  },
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
  phone: null,
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
  shop_type: null,
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

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let client: QueryClient | null = null;

async function settle(times = 6) {
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
    if (url === "/leadgen/runs") return { data: { items: [] } };
    if (url === "/leads/9") return { data: LEAD };
    if (String(url).startsWith("/leads"))
      return { data: { items: [LEAD], total: 1 } };
    return { data: { items: [] } };
  });
});

afterEach(() => {
  unmount();
  vi.restoreAllMocks();
});

describe("线索开发 · 详情失败出口（L3）", () => {
  it("详情加载失败 → ErrorState（原因 + 重试），重试会再次请求", async () => {
    mocks.get.mockImplementation(async (url: string) => {
      if (url === "/leadgen/regions") return { data: { items: [] } };
      if (url === "/leadgen/runs") return { data: { items: [] } };
      if (url === "/leads/9")
        throw Object.assign(new Error("Server"), {
          response: {
            status: 500,
            data: {
              detail: {
                error: "internal",
                code: "INTERNAL_ERROR",
                message: "后端忙碌，请稍后重试",
              },
            },
          },
        });
      if (String(url).startsWith("/leads"))
        return { data: { items: [LEAD], total: 1 } };
      return { data: { items: [] } };
    });

    mount();
    await waitFor(
      () => (document.body.textContent ?? "").includes(LEAD.company_name),
      undefined,
      "线索列表加载",
    );
    await click(findButton("详情"));
    await settle();

    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("线索详情加载失败");
    expect(alert?.textContent).toContain("后端忙碌");
    const detailCalls = () =>
      mocks.get.mock.calls.filter((c) => c[0] === "/leads/9").length;
    expect(detailCalls()).toBe(1);

    await click(findButton("重试"));
    await settle();
    expect(detailCalls()).toBe(2);
  });
});

describe("线索开发 · 扫描已回复（L4）", () => {
  it("扫描失败 → 页内显示原因", async () => {
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
      () => (document.body.textContent ?? "").includes("扫描已回复"),
      undefined,
      "页面渲染",
    );
    await click(findButton("扫描已回复"));
    await settle();

    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("扫描失败");
    expect(alert?.textContent).toContain("该工位未开通");
  });

  it("pending 期间不重复扫描", async () => {
    mocks.post.mockImplementation(() => new Promise(() => {}));
    mount();
    await waitFor(
      () => (document.body.textContent ?? "").includes("扫描已回复"),
      undefined,
      "页面渲染",
    );
    await click(findButton("扫描已回复"));
    await settle();

    expect(mocks.post).toHaveBeenCalledTimes(1);
    const pending = findButton("扫描中…");
    expect(pending.disabled).toBe(true);
    await click(pending);
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(mocks.post.mock.calls[0]![0]).toBe("/leads/scan-replied");
  });
});
