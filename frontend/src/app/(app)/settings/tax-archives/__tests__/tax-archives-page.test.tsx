/**
 * 税务档案 · 产品税率「停用」（P0-B1）—— 二次确认 + pending 防重回归。
 *
 * 钉住：
 * 1. 点「停用」只开确认弹窗，**不发 DELETE**；确认后才 DELETE /product-tax-rates/{id}；
 * 2. 提交中连点两次只发一次请求；
 * 3. 失败原因（403/404）显示在弹窗里且弹窗不关。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  delete: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@/lib/api/client", () => {
  const client = {
    get: mocks.get,
    delete: mocks.delete,
    post: vi.fn(),
    patch: vi.fn(),
  };
  return { default: client, apiClient: client };
});
vi.mock("@/lib/events/use-page-view", () => ({ usePageView: () => {} }));
vi.mock("@/lib/team/team-context", () => ({
  useTeam: () => ({ isTeamAdmin: true }),
}));
vi.mock("sonner", () => ({
  toast: { success: mocks.toastSuccess, error: vi.fn() },
}));
vi.mock("../components/fx-rate-card", () => ({ FxRateCard: () => null }));
vi.mock("../components/fx-history-card", () => ({ FxHistoryCard: () => null }));

import TaxArchivesPage from "../page";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const ARCHIVE = {
  id: 1,
  name: "默认企业税档",
  code: "TAX-DEFAULT",
  effective_from: "2026-09-01",
  effective_to: null,
  tax_values: { output_vat_rate: 0.13, misc_fee_rate: 0.03 },
  source: "manual",
  status: "active",
  created_at: null,
  updated_at: null,
};
const PRODUCT_TAX = {
  id: 33,
  product_key: "field_fence",
  input_vat_rate: 0.1,
  rebate_rate: 0.13,
  status: "active",
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
        <TaxArchivesPage />
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

/** 产品税率行里的按钮（页面上还有税档「停用」按钮，按行 scope 避免点错）。 */
function productTaxButton(label: string): HTMLButtonElement {
  const row = Array.from(document.querySelectorAll("tr")).find((tr) =>
    (tr.textContent ?? "").includes("field_fence"),
  );
  if (!row) throw new Error("没找到产品税率行");
  const button = Array.from(row.querySelectorAll("button")).find((b) =>
    (b.textContent ?? "").includes(label),
  );
  if (!button) throw new Error(`产品税率行里没有按钮「${label}」`);
  return button;
}

async function click(el: HTMLElement) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await settle(2);
}

async function doubleClick(el: HTMLElement) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await settle(2);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockImplementation(async (url: string) => {
    if (url === "/tax-archives") return { data: { items: [ARCHIVE] } };
    if (url === "/product-tax-rates") return { data: { items: [PRODUCT_TAX] } };
    if (url === "/export-quote/products")
      return {
        data: { products: [{ key: "field_fence", name: "牛栏网" }], total: 1 },
      };
    return { data: { items: [] } };
  });
});

afterEach(() => {
  unmount();
  vi.restoreAllMocks();
});

describe("产品税率 · 停用二次确认", () => {
  it("未确认不发 DELETE；确认后只发一次", async () => {
    mocks.delete.mockResolvedValue({ data: { id: 33, status: "inactive" } });
    mount();
    await waitFor(
      () => (document.body.textContent ?? "").includes("field_fence"),
      undefined,
      "产品税率加载",
    );

    await click(productTaxButton("停用"));
    expect(document.body.textContent).toContain("停用产品「牛栏网」的税率？");
    expect(mocks.delete).not.toHaveBeenCalled();

    await click(findConfirm("确认停用"));
    await waitFor(
      () => mocks.delete.mock.calls.length > 0,
      undefined,
      "DELETE",
    );
    expect(mocks.delete).toHaveBeenCalledTimes(1);
    expect(mocks.delete).toHaveBeenCalledWith("/product-tax-rates/33");
    expect(mocks.toastSuccess).toHaveBeenCalledWith("产品税率已停用");
  });

  it("提交中连点两次只发一次请求（pending 防重）", async () => {
    mocks.delete.mockImplementation(() => new Promise(() => {}));
    mount();
    await waitFor(
      () => (document.body.textContent ?? "").includes("field_fence"),
      undefined,
      "产品税率加载",
    );
    await click(productTaxButton("停用"));
    await doubleClick(findConfirm("确认停用"));
    await settle();

    expect(mocks.delete).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain("提交中…");
  });

  it("失败原因显示在弹窗里且弹窗不关", async () => {
    mocks.delete.mockRejectedValue(
      Object.assign(new Error("Forbidden"), {
        response: {
          status: 403,
          data: {
            detail: {
              error: "forbidden",
              code: "TEAM_ADMIN_REQUIRED",
              message: "不能停用其他团队的产品税率",
            },
          },
        },
      }),
    );
    mount();
    await waitFor(
      () => (document.body.textContent ?? "").includes("field_fence"),
      undefined,
      "产品税率加载",
    );
    await click(productTaxButton("停用"));
    await click(findConfirm("确认停用"));
    await settle();

    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("不能停用其他团队的产品税率");
    expect(document.body.textContent).toContain("确认停用");
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });
});

function findConfirm(text: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll("button")).find(
    (b) => (b.textContent ?? "").trim() === text,
  );
  if (!button) throw new Error(`没找到按钮「${text}」`);
  return button;
}
