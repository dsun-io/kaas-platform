/**
 * U-P1E（C5/C6/C3）：客户页搜索防抖、计数用 total、删联系人失败不再静默。
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
vi.mock("@/lib/events/use-page-view", () => ({ usePageView: () => {} }));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import CustomersPage from "../page";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type GetResp = Awaited<ReturnType<typeof apiClient.get>>;
const ok = (data: unknown) => ({ data }) as unknown as GetResp;

const CUSTOMER = {
  id: 1,
  company_name: "联佳丝网",
  abbr: "LJ",
  country: "CN",
  address: null,
  default_port: "Shanghai",
  credit_level: "A",
  stage: "active",
  manual_stage: "active",
  notes: null,
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-10-20T00:00:00Z",
};

const CONTACT = {
  id: 9,
  name: "王经理",
  position: null,
  phone: null,
  email: null,
  whatsapp: null,
  is_primary: true,
  created_at: "2026-10-01T00:00:00Z",
};

const DETAIL = {
  ...CUSTOMER,
  contacts: [CONTACT],
  inquiries: [],
  stage_log: [],
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

async function waitFor(check: () => boolean, timeout = 5000, label = "条件") {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) {
      throw new Error(
        `等待超时：${label}（当前文本：${document.body.textContent?.slice(0, 300) ?? ""}）`,
      );
    }
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
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
        <CustomersPage />
      </QueryClientProvider>,
    ),
  );
  await settle();
}

function customerListCalls() {
  return vi
    .mocked(apiClient.get)
    .mock.calls.filter(
      ([url]) =>
        String(url).startsWith("/customers?") || String(url) === "/customers",
    );
}

function setSearchInput(value: string) {
  const input = document.querySelector<HTMLInputElement>(
    'input[placeholder^="搜索客户"]',
  );
  if (!input) throw new Error("没找到客户搜索框");
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  window.localStorage.clear();
  vi.mocked(apiClient.get).mockImplementation(async (url: string) => {
    const path = String(url);
    if (path === "/customers/1") return ok(DETAIL);
    if (path === "/customers/1/records") return ok({});
    if (path.startsWith("/customers")) {
      // total=7 > items.length=1：计数必须用 total（C6）
      return ok({ items: [CUSTOMER], total: 7 });
    }
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

describe("客户列表 C6：计数用 total", () => {
  it("显示后端 total（7）而不是当前页条数（1）", async () => {
    await mount();
    await waitFor(
      () => (document.body.textContent ?? "").includes(CUSTOMER.company_name),
      undefined,
      "客户列表加载",
    );
    expect(document.body.textContent).toContain("共 7 家客户");
  });
});

describe("客户搜索 C5：防抖", () => {
  it("连续输入只发最终一次请求（不请求中间值）", async () => {
    await mount();
    await waitFor(
      () => (document.body.textContent ?? "").includes(CUSTOMER.company_name),
      undefined,
      "客户列表加载",
    );
    const before = customerListCalls().length;

    // 同一 tick 内连打两次（防抖窗口内）
    setSearchInput("联");
    setSearchInput("联佳");
    await sleepMs(450);

    const after = customerListCalls().slice(before);
    const urls = after.map(([url]) => String(url));
    expect(urls.length).toBe(1);
    expect(urls[0]).toContain(`q=${encodeURIComponent("联佳")}`);
    expect(
      urls.some((url) => url.includes(`q=${encodeURIComponent("联")}&`)),
    ).toBe(false);
  });
});

describe("删联系人 C3：失败不再静默", () => {
  it("DELETE 失败 ⇒ 页内 role=alert 显示原因，确认行保留可重试", async () => {
    vi.mocked(apiClient.delete).mockRejectedValueOnce({
      response: {
        status: 500,
        data: {
          detail: {
            error: "internal",
            code: "X",
            message: "联系人删除服务不可用",
          },
        },
      },
    });

    await mount();
    await waitFor(
      () => (document.body.textContent ?? "").includes(CUSTOMER.company_name),
      undefined,
      "客户列表加载",
    );

    const row = document.querySelector('[data-testid="customer-card"]');
    expect(row).not.toBeNull();
    await act(async () => {
      (row as HTMLElement).click();
    });
    await settle();

    await waitFor(
      () => (document.body.textContent ?? "").includes("联系人（1）"),
      undefined,
      "客户详情",
    );

    const deleteButton = Array.from(document.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").trim() === "删除",
    );
    expect(deleteButton).toBeTruthy();
    act(() => deleteButton!.click());
    await settle(2);

    const confirm = Array.from(document.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").trim() === "确认删除",
    );
    expect(confirm).toBeTruthy();
    await act(async () => {
      confirm!.click();
    });
    await sleepMs(30);

    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("删除联系人失败");
    expect(alert?.textContent).toContain("联系人删除服务不可用");
    // 确认行还在 ⇒ 用户可以直接重试（不是失败即关闭的假成功）
    expect(
      Array.from(document.querySelectorAll("button")).some(
        (b) => (b.textContent ?? "").trim() === "确认删除",
      ),
    ).toBe(true);
    expect(vi.mocked(apiClient.delete)).toHaveBeenCalledTimes(1);
  });
});
