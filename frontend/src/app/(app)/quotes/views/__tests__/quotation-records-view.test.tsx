/**
 * X7（审计 §1.5）：报价记录页不再四层同屏堆叠。
 *
 * 钉死：
 *  1. 主视图是 quote_orders（报价单记录）；
 *  2. 旧 quotations 台账默认收起（有容器/标题），展开后过滤条件与台账表仍在、可用；
 *  3. 手工补录改为弹窗（不占主视图版面）。
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

import { QuotationRecordsView } from "../quotation-records-view";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type GetResp = Awaited<ReturnType<typeof apiClient.get>>;
const ok = (data: unknown) => ({ data }) as unknown as GetResp;

const LEGACY_QUOTATION = {
  id: "q-01",
  quotation_id: "Q-2025-0001",
  customer_id: "1",
  product_category: "牛栏网",
  product_spec: {},
  quantity: 10,
  unit_price: 3.85,
  status: "matched",
  source: "quotations_db",
  spec_hash: "h1",
  confidence: "high",
  discount: 0,
  notes: "",
  effective_from: "2026-10-01T00:00:00Z",
  created_at: "2026-10-01T00:00:00Z",
};

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
        <QuotationRecordsView />
      </QueryClientProvider>,
    ),
  );
  await settle();
}

function buttonByText(text: string): HTMLButtonElement | undefined {
  return Array.from(container!.querySelectorAll("button")).find(
    (b) => (b.textContent ?? "").trim() === text,
  ) as HTMLButtonElement | undefined;
}

beforeEach(() => {
  vi.resetAllMocks();
  window.localStorage.clear();
  vi.mocked(apiClient.get).mockImplementation(async (url: string) => {
    const path = String(url);
    if (path.startsWith("/quotes")) {
      return ok({ items: [], total: 0, page: 1, page_size: 50 });
    }
    if (path.startsWith("/quotations")) {
      return ok({ items: [LEGACY_QUOTATION], total: 1 });
    }
    if (path === "/auth/me") {
      return ok({ account_type: "internal", is_tenant_admin: true });
    }
    return ok({ items: [] });
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

describe("报价记录页（X7 堆叠收敛）", () => {
  it("旧台账默认收起；展开后过滤条件与台账表仍可用", async () => {
    await mount();

    // 主视图在首屏
    expect(container!.textContent).toContain("报价单记录");
    // 旧台账容器在，但内容默认不渲染
    expect(container!.textContent).toContain("历史台账（旧 quotations 表）");
    expect(container!.textContent).not.toContain("Q-2025-0001");
    expect(container!.querySelector('input[placeholder="客户 ID"]')).toBeNull();

    const expand = buttonByText("展开旧台账");
    expect(expand).toBeTruthy();
    expect(expand!.getAttribute("aria-expanded")).toBe("false");
    act(() => expand!.click());
    await settle();

    expect(buttonByText("收起旧台账")!.getAttribute("aria-expanded")).toBe(
      "true",
    );
    expect(container!.textContent).toContain("Q-2025-0001");
    expect(
      container!.querySelector('input[placeholder="客户 ID"]'),
    ).not.toBeNull();
    expect(container!.textContent).toContain("（共 1 条）");
  });

  it("手工补录改为弹窗（不占主视图版面）", async () => {
    await mount();

    const manual = buttonByText("手工补录");
    expect(manual).toBeTruthy();
    expect(container!.textContent).not.toContain("手工补录报价（旧台账）");

    act(() => manual!.click());
    await settle();

    // Dialog 走 portal，文案出现在 body
    expect(document.body.textContent).toContain("手工补录报价（旧台账）");
    expect(document.body.textContent).toContain("补录写入旧 quotations 事实表");
  });
});
