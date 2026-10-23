/**
 * 报价工作台 · 新建询盘失败反馈（P0-B2/Q9）。
 *
 * 旧行为：createInquiry mutation 无 onError —— 点「+ 新建询盘」失败时页面毫无反应。
 * 现在：失败写入汇总卡 notice（含后端 detail 原文）；pending 期间按钮禁用。
 *
 * 说明：工作台体量大，这里只桩掉与 Q9 无关的重组件（产品行/参数字卡/汇总卡/批量导入），
 * 业务动作仍走真实的 `useMutation` + mocked apiClient。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, Fragment, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));

vi.mock("@/lib/api/client", () => {
  const client = {
    get: mocks.get,
    post: mocks.post,
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  };
  return { default: client, apiClient: client };
});
vi.mock("@/lib/auth/auth-context", () => ({
  useAuth: () => ({
    user: { account_type: "customer", role: "user" },
    isLoading: false,
  }),
}));
vi.mock("../../hooks/use-export-quote-import", () => ({
  useExportProducts: () => ({ data: { products: [] }, isLoading: false }),
  useExportTermsTemplate: () => ({ data: null, isLoading: false }),
}));
vi.mock("@/lib/fx/use-latest-fx", () => ({
  useLatestFxRate: () => ({ data: { rate: 7.1 } }),
}));
vi.mock("@/lib/workstation/use-upstream", () => ({
  useCustomerName: () => ({ data: null }),
  useOrderOptions: () => ({ data: [] }),
}));
vi.mock("@/lib/trade-doc/render", () => ({
  getAvailableTemplates: () => [],
}));
vi.mock("../../components/bulk-import-dialog", () => ({
  BulkImportEntry: () => null,
}));
vi.mock("@/components/shared/sortable-list", () => ({
  SortableList: ({
    items,
    renderItem,
  }: {
    items: unknown[];
    renderItem: (item: unknown, index: number) => ReactNode;
  }) => (
    <>
      {items.map((item, index) => (
        <Fragment key={index}>{renderItem(item, index)}</Fragment>
      ))}
    </>
  ),
  SortableGrip: () => null,
}));
vi.mock("../../components/quote-line-card", () => ({
  QuoteLineCard: () => null,
  newLineDraft: () => ({
    id: "line-1",
    productKey: "",
    spec: {},
    pieces: "1",
    costOverride: "",
    profitPctOverride: "",
    packagingId: "",
    result: null,
    built: null,
    error: null,
  }),
}));
vi.mock("../workbench-params-card", () => ({
  WorkbenchParamsCard: ({
    setCustomer,
    onCreateInquiry,
    creatingInquiry,
  }: {
    setCustomer: (c: { id: string; name: string }) => void;
    onCreateInquiry?: () => void;
    creatingInquiry?: boolean;
  }) => (
    <div>
      <button
        type="button"
        onClick={() => setCustomer({ id: "1", name: "客户A" })}
      >
        pick-customer
      </button>
      <button
        type="button"
        disabled={creatingInquiry}
        onClick={() => onCreateInquiry?.()}
      >
        {creatingInquiry ? "创建中…" : "+ 新建询盘"}
      </button>
    </div>
  ),
}));
vi.mock("../../components/quote-summary-card", () => ({
  QuoteSummaryCard: ({
    notice,
  }: {
    notice: { tone: string; text: string } | null;
  }) => <div data-testid="notice">{notice?.text ?? ""}</div>,
}));

import { QuoteWorkbenchView } from "../quote-workbench-view";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

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
        <QuoteWorkbenchView />
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

/** 打开参数卡并选中客户（「新建询盘」只在有客户时出现）。 */
async function openParamsWithCustomer() {
  await settle(2);
  await click(findButton("选择客户"));
  await click(findButton("pick-customer"));
  await settle(2);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockResolvedValue({ data: { items: [] } });
});

afterEach(() => {
  unmount();
  vi.restoreAllMocks();
});

describe("报价工作台 · 新建询盘（Q9）", () => {
  it("失败 → 汇总卡 notice 如实显示原因", async () => {
    mocks.post.mockRejectedValue(
      Object.assign(new Error("Unprocessable"), {
        response: {
          status: 422,
          data: {
            detail: {
              error: "validation",
              code: "INQUIRY_PRODUCT_REQUIRED",
              message: "新建询盘需要先选一个产品",
            },
          },
        },
      }),
    );
    mount();
    await openParamsWithCustomer();
    await click(findButton("+ 新建询盘"));
    await settle();

    expect(mocks.post).toHaveBeenCalledWith("/customers/1/inquiries", {
      channel: "quote",
      product_name_raw: null,
    });
    const notice = document.querySelector('[data-testid="notice"]');
    expect(notice?.textContent).toContain("新建询盘失败");
    expect(notice?.textContent).toContain("新建询盘需要先选一个产品");
  });

  it("pending 期间不重复建询盘", async () => {
    mocks.post.mockImplementation(() => new Promise(() => {}));
    mount();
    await openParamsWithCustomer();

    const button = findButton("+ 新建询盘");
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle();

    expect(mocks.post).toHaveBeenCalledTimes(1);
    const pending = findButton("创建中…");
    expect(pending.disabled).toBe(true);
    await act(async () => {
      pending.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(mocks.post).toHaveBeenCalledTimes(1);
  });
});
