/**
 * 单证台账「URL 筛选 + 分页」状态层（U-P1E / 审计 T3）。
 *
 * 为什么测 hook 而不是整页：trade-docs/page.tsx 很重（开单表单/预览/PDF），
 * 整页挂载成本高且易被无关改动打红；分页参数 / URL 同步 / 切筛选回第 1 页
 * 都是这个 hook 的职责，用最小 Harness 精确钉死。
 *
 * 文件放在 `hooks/__tests__/` 属于本任务写范围（trade-docs/hooks/**）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import apiClient from "@/lib/api/client";

vi.mock("@/lib/api/client", () => {
  const client = {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  };
  return { default: client, apiClient: client };
});

import {
  TRADE_DOCS_EXPORT_PAGE_SIZE,
  TRADE_DOCS_PAGE_SIZE,
  fetchAllTradeDocs,
} from "../use-trade-docs";
import { useTradeDocsLedger } from "../use-trade-docs-ledger";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type GetResp = Awaited<ReturnType<typeof apiClient.get>>;
const ok = (data: unknown) => ({ data }) as unknown as GetResp;

const TOTAL = 45;

function docRow(n: number, patch: Record<string, unknown> = {}) {
  return {
    id: n,
    doc_no: `DOC-202610-${String(n).padStart(4, "0")}`,
    doc_type: "pi",
    order_id: 9,
    customer_id: null,
    status: "draft",
    currency: "USD",
    total_amount: 1000,
    issued_at: null,
    issued_by: null,
    raw_payload: null,
    created_at: "2026-10-22T00:00:00Z",
    ...patch,
  };
}

function pageOf(page: number, pageSize: number) {
  const start = (page - 1) * pageSize;
  const count = Math.max(0, Math.min(pageSize, TOTAL - start));
  return {
    items: Array.from({ length: count }, (_, i) => docRow(start + i + 1)),
    total: TOTAL,
    page,
    page_size: pageSize,
  };
}

function tradeDocCalls() {
  return vi
    .mocked(apiClient.get)
    .mock.calls.filter(([url]) => String(url) === "/trade-docs");
}

function lastParams(): Record<string, unknown> {
  const calls = tradeDocCalls();
  const config = calls[calls.length - 1]?.[1] as
    | { params?: Record<string, unknown> }
    | undefined;
  return config?.params ?? {};
}

function searchParam(key: string): string | null {
  return new URLSearchParams(window.location.search).get(key);
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let client: QueryClient | null = null;

async function settle(times = 4) {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function Harness() {
  const ledger = useTradeDocsLedger();
  return (
    <div>
      <label>
        单证类型
        <input
          aria-label="doc-type"
          value={ledger.docType}
          onChange={(event) => ledger.setDocType(event.target.value)}
        />
      </label>
      <label>
        状态
        <input
          aria-label="status"
          value={ledger.status}
          onChange={(event) => ledger.setStatus(event.target.value)}
        />
      </label>
      <button type="button" onClick={() => ledger.setPage(ledger.page + 1)}>
        下一页
      </button>
      <span data-testid="page">{ledger.page}</span>
      <span data-testid="total">{ledger.total}</span>
      <span data-testid="rows">{ledger.rows.length}</span>
    </div>
  );
}

async function mount() {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      <QueryClientProvider client={client!}>
        <Harness />
      </QueryClientProvider>,
    ),
  );
  await settle();
}

function text(testId: string): string {
  return (
    container!.querySelector(`[data-testid="${testId}"]`)?.textContent ?? ""
  );
}

function setInput(label: string, value: string) {
  const input = container!.querySelector(
    `input[aria-label="${label}"]`,
  ) as HTMLInputElement | null;
  if (!input) throw new Error(`没找到输入框「${label}」`);
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  window.history.replaceState(null, "", "/trade-docs");
  vi.mocked(apiClient.get).mockImplementation(async (url: string, config) => {
    if (String(url) !== "/trade-docs") return ok({ items: [], total: 0 });
    const params = (config as { params?: Record<string, unknown> } | undefined)
      ?.params;
    const page = Number(params?.page ?? 1);
    const pageSize = Number(params?.page_size ?? TRADE_DOCS_PAGE_SIZE);
    return ok(pageOf(page, pageSize));
  });
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  client?.clear();
  root = null;
  container = null;
  client = null;
});

describe("单证台账分页 + URL 筛选", () => {
  it("默认请求 page=1&page_size=20，并用 total 渲染真实总数", async () => {
    await mount();

    expect(tradeDocCalls()).toHaveLength(1);
    expect(lastParams()).toMatchObject({
      page: 1,
      page_size: TRADE_DOCS_PAGE_SIZE,
    });
    expect(text("page")).toBe("1");
    expect(text("total")).toBe(String(TOTAL));
    expect(text("rows")).toBe(String(TRADE_DOCS_PAGE_SIZE));
  });

  it("翻页：page=2 重新请求（不再写死 page_size=100 的一次性列表）", async () => {
    await mount();
    act(() => {
      const button = Array.from(container!.querySelectorAll("button")).find(
        (el) => (el.textContent ?? "").trim() === "下一页",
      );
      button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle();

    expect(text("page")).toBe("2");
    expect(lastParams()).toMatchObject({
      page: 2,
      page_size: TRADE_DOCS_PAGE_SIZE,
    });
  });

  it("改筛选：写进 URL，并回到第 1 页（不留在第 2 页看空结果）", async () => {
    await mount();
    act(() => {
      const button = Array.from(container!.querySelectorAll("button")).find(
        (el) => (el.textContent ?? "").trim() === "下一页",
      );
      button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle();
    expect(text("page")).toBe("2");

    setInput("doc-type", "ci");
    await settle();

    expect(searchParam("doc_type")).toBe("ci");
    expect(text("page")).toBe("1");
    expect(lastParams()).toMatchObject({
      doc_type: "ci",
      page: 1,
      page_size: TRADE_DOCS_PAGE_SIZE,
    });
  });

  it("URL 初始值水合：?doc_type=ci&status=issued 直接带进查询", async () => {
    window.history.replaceState(
      null,
      "",
      "/trade-docs?doc_type=ci&status=issued",
    );
    await mount();

    expect(lastParams()).toMatchObject({
      doc_type: "ci",
      status: "issued",
      page: 1,
      page_size: TRADE_DOCS_PAGE_SIZE,
    });
  });

  it("清空筛选：URL 参数被删掉，查询回到无筛选第 1 页", async () => {
    window.history.replaceState(
      null,
      "",
      "/trade-docs?doc_type=pi&status=draft",
    );
    await mount();

    setInput("doc-type", "");
    setInput("status", "");
    await settle();

    expect(searchParam("doc_type")).toBeNull();
    expect(searchParam("status")).toBeNull();
    const params = lastParams();
    expect(params.page).toBe(1);
    expect(params.doc_type).toBeUndefined();
    expect(params.status).toBeUndefined();
  });

  it("导出取全部筛选结果：按 page_size=200 逐页拉齐（不把导出偷偷变成导当前页）", async () => {
    const allRows = Array.from({ length: 205 }, (_, i) => docRow(i + 1));
    vi.mocked(apiClient.get).mockImplementation(async (url: string, config) => {
      if (String(url) !== "/trade-docs") return ok({ items: [], total: 0 });
      const params = (
        config as { params?: Record<string, unknown> } | undefined
      )?.params;
      const page = Number(params?.page ?? 1);
      const pageSize = Number(params?.page_size ?? 200);
      const start = (page - 1) * pageSize;
      return ok({
        items: allRows.slice(start, start + pageSize),
        total: allRows.length,
        page,
        page_size: pageSize,
      });
    });

    const rows = await fetchAllTradeDocs({ doc_type: "pi", status: "draft" });

    expect(rows).toHaveLength(205);
    const calls = tradeDocCalls();
    expect(calls).toHaveLength(2);
    expect(
      calls.map(
        ([, config]) => (config as { params?: Record<string, unknown> }).params,
      ),
    ).toEqual([
      {
        doc_type: "pi",
        status: "draft",
        page: 1,
        page_size: TRADE_DOCS_EXPORT_PAGE_SIZE,
      },
      {
        doc_type: "pi",
        status: "draft",
        page: 2,
        page_size: TRADE_DOCS_EXPORT_PAGE_SIZE,
      },
    ]);
  });
});
