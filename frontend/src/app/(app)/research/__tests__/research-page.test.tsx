/**
 * 调研工位（/research）—— P0-B1 删除调研产品止血回归。
 *
 * 钉住：
 * 1. 点「移除」先弹二次确认（写明"深化数据不可恢复"），**不发 DELETE**；
 * 2. 确认后才 DELETE /research/products/{id}；
 * 3. 提交中连点两次只发一次请求（pending 防重）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  delete: vi.fn(),
  patch: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/lib/api/client", () => {
  const client = {
    get: mocks.get,
    delete: mocks.delete,
    patch: mocks.patch,
    post: vi.fn(),
  };
  return { default: client, apiClient: client };
});
vi.mock("@/components/route-guard", () => ({
  RouteGuard: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/lib/events/use-page-view", () => ({ usePageView: () => {} }));
vi.mock("sonner", () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));

import ResearchPage from "../page";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const PRODUCT = {
  id: 77,
  source_ref: 12,
  source: "google_maps",
  product_name: "Chain Link Fence",
  product_name_cn: "勾花围栏",
  product_image_url: null,
  spec_raw: "1.8m x 25m",
  spec_normalized: null,
  product_category: "fence",
  country: "US",
  region: null,
  city: "Houston",
  shop_name: "Texas Fence",
  shop_type: "retail",
  address: null,
  phone: null,
  email: null,
  website: null,
  link_url: null,
  price_local: 12,
  price_currency: "USD",
  market_note: "热销",
  can_supply: true,
  supply_notes: null,
  research_status: "confirmed",
  created_at: "2026-10-01T00:00:00Z",
};

const STATS = {
  total: 1,
  can_supply_yes: 1,
  by_country: [],
  by_category: [],
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
        `等待超时：${label}（当前页面文本：${document.body.textContent?.slice(0, 400) ?? ""}）`,
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
        <ResearchPage />
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

async function click(text: string) {
  await act(async () => {
    findButton(text).dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await settle(2);
}

async function doubleClick(text: string) {
  await act(async () => {
    const button = findButton(text);
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await settle(2);
}

/** 移除按钮只有图标（title="移除"）。 */
function findRemoveButton(): HTMLButtonElement {
  const button =
    document.querySelector<HTMLButtonElement>('button[title="移除"]');
  if (!button) throw new Error("没找到「移除」按钮");
  return button;
}

/** 深化按钮只有图标（title="深化"）。 */
function findEditButton(): HTMLButtonElement {
  const button =
    document.querySelector<HTMLButtonElement>('button[title="深化"]');
  if (!button) throw new Error("没找到「深化」按钮");
  return button;
}

function findExactButton(text: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll("button")).find(
    (b) => (b.textContent ?? "").trim() === text,
  );
  if (!button) throw new Error(`没找到按钮「${text}」`);
  return button;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockImplementation(async (url: string) => {
    if (url === "/research/stats") return { data: STATS };
    if (url === "/research/categories") return { data: { items: [] } };
    if (String(url).startsWith("/research/products"))
      return { data: { items: [PRODUCT], total: 1 } };
    return { data: { items: [] } };
  });
});

afterEach(() => {
  unmount();
  vi.restoreAllMocks();
});

describe("调研产品 · 移除二次确认", () => {
  it("未确认不发 DELETE；确认后只发一次", async () => {
    mocks.delete.mockResolvedValue({ data: { ok: true } });
    mount();
    await waitFor(
      () => (document.body.textContent ?? "").includes(PRODUCT.product_name_cn),
      undefined,
      "产品列表加载",
    );

    await act(async () => {
      findRemoveButton().dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    await settle(2);

    expect(document.body.textContent).toContain("从调研集移除");
    expect(document.body.textContent).toContain("不可恢复");
    expect(mocks.delete).not.toHaveBeenCalled();

    await click("确认移除");
    await waitFor(
      () => mocks.delete.mock.calls.length > 0,
      undefined,
      "删除请求",
    );
    expect(mocks.delete).toHaveBeenCalledTimes(1);
    expect(mocks.delete).toHaveBeenCalledWith("/research/products/77");
    expect(mocks.toastSuccess).toHaveBeenCalledWith("已从调研集中移除");
  });

  it("提交中连点两次只发一次请求（pending 防重）", async () => {
    mocks.delete.mockImplementation(() => new Promise(() => {}));
    mount();
    await waitFor(
      () => (document.body.textContent ?? "").includes(PRODUCT.product_name_cn),
      undefined,
      "产品列表加载",
    );
    await act(async () => {
      findRemoveButton().dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    await settle(2);
    await doubleClick("确认移除");
    await settle();

    expect(mocks.delete).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain("提交中…");
  });
});

describe("调研产品 · 深化记录保存 pending 防重（P0-B4）", () => {
  it("保存中连点两次只 PATCH 一次", async () => {
    mocks.patch.mockImplementation(() => new Promise(() => {}));
    mount();
    await waitFor(
      () => (document.body.textContent ?? "").includes(PRODUCT.product_name_cn),
      undefined,
      "产品列表加载",
    );

    await act(async () => {
      findEditButton().dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    await settle(2);
    expect(document.body.textContent).toContain("深化记录");

    await act(async () => {
      const button = findExactButton("保存");
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle(2);

    expect(mocks.patch).toHaveBeenCalledTimes(1);
    expect(mocks.patch).toHaveBeenCalledWith(
      "/research/products/77",
      expect.objectContaining({ product_name_cn: "勾花围栏" }),
    );
    expect(document.body.textContent).toContain("保存中…");
  });
});
