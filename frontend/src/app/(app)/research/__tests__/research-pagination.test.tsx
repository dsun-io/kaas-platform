/**
 * U-P1E（R49/R50/R48 + tone 收敛）：调研工位分页 / 防抖 / 导出全量 / 状态 tone。
 *
 * 钉死：
 *  1. 搜索防抖：连续输入只发最终一次（不请求中间值）；
 *  2. 分页：page=1&page_size=20，翻页带 page=2；改筛选回第 1 页；
 *  3. 导出 CSV 拉**全部筛选结果**（page_size=200 逐页），并提示导出量（不再静默截断）；
 *  4. 运行状态 tone 来自 lib/status-tones 的 RUN_STATUS_TONES：
 *     running=info（旧实现是 danger）、pending=default、succeeded=success、failed=danger。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import apiClient from "@/lib/api/client";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/lib/api/client", () => {
  const client = {
    get: mocks.get,
    post: vi.fn(),
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
    error: mocks.toastError,
    info: vi.fn(),
  },
}));

import ResearchPage from "../page";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type GetResp = Awaited<ReturnType<typeof apiClient.get>>;
const ok = (data: unknown) => ({ data }) as unknown as GetResp;
const PAGE_SIZE = 20;
const TOTAL = 45;

function productRow(n: number) {
  return {
    id: n,
    source_ref: n,
    source: "google_maps",
    product_name: `Chain Link ${n}`,
    product_name_cn: `勾花围栏 ${n}`,
    product_image_url: null,
    spec_raw: null,
    spec_normalized: null,
    product_category: "fence",
    country: "US",
    region: null,
    city: "Houston",
    shop_name: `Texas Fence ${n}`,
    shop_type: "retail",
    address: null,
    phone: null,
    email: null,
    website: null,
    link_url: null,
    price_local: 10,
    price_currency: "USD",
    market_note: null,
    can_supply: true,
    supply_notes: null,
    research_status: "confirmed",
    created_at: "2026-10-01T00:00:00Z",
  };
}

function pageOf(page: number, size: number) {
  const start = (page - 1) * size;
  const count = Math.max(0, Math.min(size, TOTAL - start));
  return {
    items: Array.from({ length: count }, (_, i) => productRow(start + i + 1)),
    total: TOTAL,
    page,
    page_size: size,
  };
}

const RUNS = [
  {
    id: 1,
    status: "pending",
    config: {},
    products_found: null,
    products_kept: null,
    created_at: "2026-10-01T00:00:00Z",
  },
  {
    id: 2,
    status: "running",
    config: {},
    products_found: null,
    products_kept: null,
    created_at: "2026-10-02T00:00:00Z",
  },
  {
    id: 3,
    status: "succeeded",
    config: {},
    products_found: 10,
    products_kept: 3,
    created_at: "2026-10-03T00:00:00Z",
  },
  {
    id: 4,
    status: "failed",
    config: {},
    products_found: 0,
    products_kept: 0,
    created_at: "2026-10-04T00:00:00Z",
  },
];

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

async function sleepMs(ms: number) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
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
        <ResearchPage />
      </QueryClientProvider>,
    ),
  );
  await settle();
}

function productCalls() {
  return vi
    .mocked(apiClient.get)
    .mock.calls.filter(([url]) => String(url).startsWith("/research/products"));
}

function paramsOf(url: string) {
  return new URL(url, "http://localhost").searchParams;
}

function lastProductParams() {
  const calls = productCalls();
  return paramsOf(String(calls[calls.length - 1]?.[0] ?? ""));
}

function buttonByText(text: string) {
  return Array.from(container!.querySelectorAll("button")).find((b) =>
    (b.textContent ?? "").includes(text),
  );
}

function setSelectByOptionText(optionText: string, value: string) {
  const select = Array.from(container!.querySelectorAll("select")).find((s) =>
    Array.from(s.options).some((o) =>
      (o.textContent ?? "").includes(optionText),
    ),
  );
  if (!select) throw new Error(`没找到含选项「${optionText}」的 select`);
  act(() => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  // 导出 CSV 用到浏览器 API：jsdom 没有 createObjectURL，锚点点击也无副作用
  Object.defineProperty(URL, "createObjectURL", {
    value: vi.fn(() => "blob:mock"),
    configurable: true,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    value: vi.fn(),
    configurable: true,
  });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

  mocks.get.mockImplementation(async (url: string) => {
    const path = String(url);
    if (path === "/research/stats") {
      return ok({
        total: TOTAL,
        can_supply_yes: 0,
        by_country: [],
        by_category: [],
      });
    }
    if (path === "/research/categories") return ok({ items: [] });
    if (path.startsWith("/research/products")) {
      const params = paramsOf(path);
      const page = Number(params.get("page") ?? 1);
      const size = Number(params.get("page_size") ?? PAGE_SIZE);
      return ok(pageOf(page, size));
    }
    if (path.startsWith("/research/runs")) return ok({ items: RUNS });
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
  vi.restoreAllMocks();
});

describe("调研列表分页（R50）", () => {
  it("首屏 page=1&page_size=20；下一页 page=2；改筛选回第 1 页", async () => {
    await mount();

    const firstParams = paramsOf(String(productCalls()[0]?.[0]));
    expect(firstParams.get("page")).toBe("1");
    expect(firstParams.get("page_size")).toBe("20");
    expect(container!.textContent).toContain("第 1–20 条 / 共 45 条");
    expect(container!.textContent).toContain("第 1 / 3 页");

    act(() => buttonByText("下一页")!.click());
    await settle();
    expect(lastProductParams().get("page")).toBe("2");
    expect(container!.textContent).toContain("第 21–40 条 / 共 45 条");

    setSelectByOptionText("可供货：全部", "true");
    await settle();
    expect(lastProductParams().get("page")).toBe("1");
    expect(lastProductParams().get("can_supply")).toBe("true");
  });
});

describe("调研搜索防抖（R49）", () => {
  it("连续输入只发最终一次（不请求中间值）", async () => {
    await mount();
    const before = productCalls().length;
    const input = container!.querySelector<HTMLInputElement>(
      'input[placeholder="搜索产品 / 店铺…"]',
    );
    if (!input) throw new Error("没找到搜索框");
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;

    act(() => {
      setter.call(input, "chain");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      setter.call(input, "chain link");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await sleepMs(450);

    const after = productCalls()
      .slice(before)
      .map(([url]) => paramsOf(String(url)).get("search"));
    expect(after).toEqual(["chain link"]);
  });
});

describe("导出 CSV 拉全部筛选结果（R48）", () => {
  it("按 page_size=200 逐页拉完并提示导出量（不是只有当前页）", async () => {
    await mount();
    expect(container!.textContent).toContain("第 1–20 条 / 共 45 条");

    act(() => buttonByText("导出 CSV")!.click());
    await sleepMs(120);

    const exportCalls = productCalls().filter(
      ([url]) => paramsOf(String(url)).get("page_size") === "200",
    );
    expect(exportCalls).toHaveLength(1);
    expect(paramsOf(String(exportCalls[0]?.[0])).get("page")).toBe("1");

    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      "已导出当前筛选的全部 45 条（列表每页 20 条）",
    );
  });
});

describe("运行状态 tone 收敛（lib/status-tones RUN_STATUS_TONES）", () => {
  it("running=info（旧实现为 danger）、pending=default、succeeded=success、failed=danger", async () => {
    await mount();

    const trigger = Array.from(
      container!.querySelectorAll("[data-slot='tabs-trigger']"),
    ).find((el) => (el.textContent ?? "").trim() === "运行历史");
    expect(trigger).toBeTruthy();
    act(() => {
      trigger!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle(6);

    function badgeOf(text: string) {
      const el = Array.from(container!.querySelectorAll("span")).find(
        (s) =>
          (s.textContent ?? "").trim() === text &&
          s.className.includes("badge"),
      );
      if (!el) throw new Error(`没找到状态徽标「${text}」`);
      return el.className;
    }

    expect(badgeOf("运行中")).toContain("badge-info");
    expect(badgeOf("运行中")).not.toContain("badge-danger");
    expect(badgeOf("待运行")).toContain("badge-default");
    expect(badgeOf("成功")).toContain("badge-success");
    expect(badgeOf("失败")).toContain("badge-danger");
  });
});
