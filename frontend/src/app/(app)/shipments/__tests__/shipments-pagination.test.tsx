/**
 * U-P1E（R50）：出货列表接 PaginationBar（原来 page_size=100 硬编码、无翻页）。
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
    patch: vi.fn(),
    delete: vi.fn(),
  };
  return { default: client, apiClient: client };
});
vi.mock("@/lib/events/use-page-view", () => ({ usePageView: () => {} }));
vi.mock("@/lib/workstation/use-upstream", () => ({
  useOrderOptions: () => ({ data: [] }),
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import ShipmentsPage from "../page";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type GetResp = Awaited<ReturnType<typeof apiClient.get>>;
const ok = (data: unknown) => ({ data }) as unknown as GetResp;
const PAGE_SIZE = 20;
const TOTAL = 45;

function shipmentRow(n: number) {
  return {
    id: n,
    shipment_no: `SH-202610-${String(n).padStart(4, "0")}`,
    order_id: 1,
    customer_name: "客户A",
    consignee: null,
    cargo_desc: null,
    bl_no: null,
    bl_type: null,
    pol_name: null,
    pod_name: null,
    vessel: null,
    voyage: null,
    container_no: null,
    etd: null,
    eta: null,
    status: "booking",
  };
}

function pageOf(page: number) {
  const start = (page - 1) * PAGE_SIZE;
  const count = Math.max(0, Math.min(PAGE_SIZE, TOTAL - start));
  return {
    items: Array.from({ length: count }, (_, i) => shipmentRow(start + i + 1)),
    total: TOTAL,
    page,
    page_size: PAGE_SIZE,
  };
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
        <ShipmentsPage />
      </QueryClientProvider>,
    ),
  );
  await settle();
}

function shipmentCalls() {
  return vi
    .mocked(apiClient.get)
    .mock.calls.filter(([url]) => String(url) === "/shipments");
}

function lastParams() {
  const calls = shipmentCalls();
  const config = calls[calls.length - 1]?.[1] as
    | { params?: Record<string, unknown> }
    | undefined;
  return config?.params;
}

function buttonByText(text: string) {
  return Array.from(container!.querySelectorAll("button")).find((b) =>
    (b.textContent ?? "").trim().includes(text),
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(apiClient.get).mockImplementation(async (url: string) => {
    if (String(url) === "/shipments") {
      const calls = vi
        .mocked(apiClient.get)
        .mock.calls.filter(([u]) => String(u) === "/shipments");
      const config = calls[calls.length - 1]?.[1] as
        | { params?: { page?: number } }
        | undefined;
      return ok(pageOf(Number(config?.params?.page ?? 1)));
    }
    if (String(url) === "/orders") return ok({ items: [], total: 0 });
    return ok({ items: [] });
  });
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  document.body.innerHTML = "";
  client?.clear();
  root = null;
  container = null;
  client = null;
});

describe("出货列表分页", () => {
  it("首屏带 page=1&page_size=20 并显示范围；下一页带 page=2", async () => {
    await mount();

    expect(lastParams()).toMatchObject({ page: 1, page_size: PAGE_SIZE });
    expect(container!.textContent).toContain("第 1–20 条 / 共 45 条");
    expect(container!.textContent).toContain("第 1 / 3 页");

    act(() => buttonByText("下一页")!.click());
    await settle();

    expect(lastParams()).toMatchObject({ page: 2, page_size: PAGE_SIZE });
    expect(container!.textContent).toContain("第 21–40 条 / 共 45 条");
  });

  it("改状态筛选回第 1 页（并带上 status 参数）", async () => {
    await mount();
    act(() => buttonByText("下一页")!.click());
    await settle();
    expect(lastParams()).toMatchObject({ page: 2 });

    const select = document.querySelector(
      'select[aria-label="状态筛选"]',
    ) as HTMLSelectElement;
    act(() => {
      select.value = "in_transit";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle();

    expect(lastParams()).toMatchObject({ page: 1, status: "in_transit" });
  });
});
