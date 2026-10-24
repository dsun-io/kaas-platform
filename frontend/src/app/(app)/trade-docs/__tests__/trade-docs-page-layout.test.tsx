/**
 * 单证页布局（问题 6）：开单升为一等公民、样板预览收编成一行按需入口。
 *
 * 钉住三件事：
 * 1. **顺序**：PageHeader → 开单（第一步）→ 样板预览入口 → 单证台账；
 * 2. 样板预览**默认收起**（页面里没有对话框/iframe，不再占顶部大块空间）；
 * 3. 开单表单里带「成品预览」入口（开单前检查成品）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const mocks = vi.hoisted(() => ({ create: vi.fn(), post: vi.fn() }));

vi.mock("@/lib/events/use-page-view", () => ({ usePageView: () => {} }));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// 台账 hook 属于数据层，已有独立测试（trade-docs-ledger.test.tsx）；这里只要空列表结构
vi.mock("../hooks/use-trade-docs-ledger", () => ({
  useTradeDocsLedger: () => ({
    docType: "",
    status: "",
    setDocType: vi.fn(),
    setStatus: vi.fn(),
    page: 1,
    setPage: vi.fn(),
    filters: { page: 1, page_size: 20 },
    list: {
      isLoading: false,
      isError: false,
      isFetching: false,
      data: { items: [], total: 0, page: 1, page_size: 20 },
    },
    rows: [],
    total: 0,
  }),
}));

vi.mock("../hooks/use-trade-docs", () => ({
  TRADE_DOCS_PAGE_SIZE: 20,
  fetchAllTradeDocs: vi.fn(async () => []),
  useTradeDocRenderData: () => ({
    data: null,
    isLoading: false,
    isError: false,
  }),
  useUpdateTradeDoc: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useRefreshSources: () => ({ mutate: vi.fn(), isPending: false }),
  useCreateTradeDoc: () => ({ mutateAsync: mocks.create, isPending: false }),
  useUploadTradeDocFile: () => ({ mutate: vi.fn(), isPending: false }),
  useArchiveRenderedPdf: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useCheckTradeDocRenderFingerprint: () => ({
    mutate: vi.fn(),
    isPending: false,
    data: undefined,
    isError: false,
  }),
}));

vi.mock("@/lib/workstation/use-upstream", () => ({
  useOrderOptions: () => ({ data: [] }),
  useQuoteOptions: () => ({ data: [] }),
  toCustomerIdPayload: (id: number | string) => id,
}));

// 重型远程客户选择器：与本测试关注的布局无关
vi.mock("@/components/customer-picker", () => ({
  CustomerPicker: () => <div data-testid="customer-picker" />,
}));

vi.mock("@/lib/api/client", () => ({
  default: {
    get: vi.fn(),
    post: mocks.post,
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

import TradeDocsPage from "../page";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<TradeDocsPage />));
}

async function settle(times = 8) {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

beforeEach(() => {
  window.history.replaceState(null, "", "/trade-docs");
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  document.body.innerHTML = "";
  root = null;
  container = null;
});

describe("单证页布局 · 开单是一等公民", () => {
  it("顺序：开单（第一步）→ 样板预览入口 → 单证台账", async () => {
    mount();
    await settle();

    const text = document.body.textContent ?? "";
    const createIdx = text.indexOf("开单（第一步）");
    const sampleIdx = text.indexOf("样板预览");
    const ledgerIdx = text.indexOf("单证台账");

    expect(createIdx).toBeGreaterThan(-1);
    expect(sampleIdx).toBeGreaterThan(createIdx);
    expect(ledgerIdx).toBeGreaterThan(sampleIdx);
  });

  it("样板预览默认收起：页面里没有对话框、没有样例 iframe", async () => {
    mount();
    await settle();

    expect(
      Array.from(document.querySelectorAll("button")).some((b) =>
        (b.textContent ?? "").includes("打开样板预览"),
      ),
    ).toBe(true);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("开单表单里有「成品预览」入口（开单前先看成品）", async () => {
    mount();
    await settle();

    expect(
      Array.from(document.querySelectorAll("button")).some((b) =>
        (b.textContent ?? "").includes("成品预览"),
      ),
    ).toBe(true);
    // 只渲染页面不该产生任何写请求
    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
