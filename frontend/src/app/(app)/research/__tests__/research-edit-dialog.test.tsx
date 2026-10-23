/**
 * 调研产品编辑弹窗（U-P0B6/X4）。
 *
 * 旧实现：158 行编辑表单平铺在列表下方（整页跳动、编辑态与列表互相牵制）。
 * 现在 Dialog：草稿独立；失败留弹窗；关闭后焦点归还触发按钮；筛选变化不影响提交。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  patch: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@/lib/api/client", () => {
  const client = {
    get: mocks.get,
    post: vi.fn(),
    patch: mocks.patch,
    delete: vi.fn(),
  };
  return { default: client, apiClient: client };
});
vi.mock("@/components/route-guard", () => ({
  RouteGuard: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/lib/events/use-page-view", () => ({ usePageView: () => {} }));
vi.mock("sonner", () => ({
  toast: { success: mocks.toastSuccess, error: vi.fn(), info: vi.fn() },
}));
vi.mock("../components/manual-research-dialog", () => ({
  ManualResearchDialog: () => null,
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
const STATS = { total: 1, can_supply_yes: 1, by_country: [], by_category: [] };

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

function findExactButton(text: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll("button")).find(
    (b) => (b.textContent ?? "").trim() === text,
  );
  if (!button) throw new Error(`没找到按钮「${text}」`);
  return button;
}

function editButton(): HTMLButtonElement {
  const button =
    document.querySelector<HTMLButtonElement>('button[title="深化"]');
  if (!button) throw new Error("没找到「深化」按钮");
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
    'input[placeholder="搜索产品 / 店铺…"]',
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

async function openEdit() {
  await waitFor(
    () => (document.body.textContent ?? "").includes(PRODUCT.product_name_cn),
    undefined,
    "产品列表加载",
  );
  await click(editButton());
  await waitFor(
    () => document.querySelector('[role="dialog"]') !== null,
    undefined,
    "编辑弹窗打开",
  );
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

describe("调研产品 · 编辑弹窗", () => {
  it("打开→关闭→焦点归还；筛选变化后仍可提交（用原产品 id）", async () => {
    mocks.patch.mockResolvedValue({ data: {} });
    mount();
    await openEdit();

    expect(document.querySelector('[role="dialog"]')!.textContent).toContain(
      "深化记录 · Chain Link Fence",
    );

    // 改筛选 ⇒ 列表重取；弹窗与草稿不受影响
    setSearch("fence");
    await settle();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();

    await click(findExactButton("保存"));
    await waitFor(() => mocks.patch.mock.calls.length > 0, undefined, "PATCH");
    expect(mocks.patch).toHaveBeenCalledTimes(1);
    expect(mocks.patch.mock.calls[0]![0]).toBe("/research/products/77");
    expect(mocks.patch.mock.calls[0]![1]).toMatchObject({
      product_name_cn: "勾花围栏",
      can_supply: true,
    });
    expect(mocks.toastSuccess).toHaveBeenCalledWith("已保存");
    await waitFor(
      () => document.querySelector('[role="dialog"]') === null,
      undefined,
      "成功后关闭",
    );

    // 重新打开再取消：焦点归还「深化」按钮（列表可能已重取，重新取按钮节点）
    const secondOpener = editButton();
    await click(secondOpener);
    await waitFor(
      () => document.querySelector('[role="dialog"]') !== null,
      undefined,
      "再次打开",
    );
    await click(findExactButton("取消"));
    await waitFor(
      () => document.querySelector('[role="dialog"]') === null,
      undefined,
      "取消关闭",
    );
    // 焦点归还是 closeEdit 里的 setTimeout(0)：先等它真的发生再断言，
    // 否则在并发跑测试（CPU 争用）时会在 timer 之前就断言 ⇒ 假红。
    await waitFor(
      () => document.activeElement === secondOpener,
      undefined,
      "焦点归还",
    );
    expect(document.activeElement).toBe(secondOpener);
  });

  it("保存失败 → 弹窗内显示原因且不关闭，可重试", async () => {
    mocks.patch.mockRejectedValue(
      Object.assign(new Error("Forbidden"), {
        response: {
          status: 403,
          data: {
            detail: {
              error: "forbidden",
              code: "TEAM_ADMIN_REQUIRED",
              message: "仅团队管理员可修改调研记录",
            },
          },
        },
      }),
    );
    mount();
    await openEdit();
    await click(findExactButton("保存"));
    await settle();

    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("保存失败");
    expect(alert?.textContent).toContain("仅团队管理员可修改调研记录");
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();

    await click(findExactButton("保存"));
    expect(mocks.patch).toHaveBeenCalledTimes(2);
  });

  it("FormField 收编：每个字段都有 label 关联（可 getByLabelText）", async () => {
    mount();
    await openEdit();

    /** 等价 testing-library 的 getByLabelText：label[for] → 控件 */
    function byLabelText(text: string): HTMLElement | null {
      const label = Array.from(document.querySelectorAll("label")).find(
        (l) => (l.textContent ?? "").replace("*", "").trim() === text,
      );
      const id = label?.getAttribute("for");
      return id ? document.getElementById(id) : null;
    }

    expect(byLabelText("本地产品")).toBeInstanceOf(HTMLInputElement);
    expect(byLabelText("中文产品名")).toBeInstanceOf(HTMLInputElement);
    expect(byLabelText("类目")).toBeInstanceOf(HTMLSelectElement);
    expect(byLabelText("当地价格")).toBeInstanceOf(HTMLInputElement);
    expect(byLabelText("币种")).toBeInstanceOf(HTMLInputElement);
    expect(byLabelText("可供货")).toBeInstanceOf(HTMLSelectElement);
    expect(byLabelText("供货备注")).toBeInstanceOf(HTMLInputElement);
    expect(byLabelText("市场备注")).toBeInstanceOf(HTMLTextAreaElement);
  });
});
