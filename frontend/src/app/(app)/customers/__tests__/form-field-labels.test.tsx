/**
 * FormField 收编（P0-C）：客户/联系人表单的 label 关联与错误可读性。
 *
 * 钉死：
 *  1. 每个字段有真实 <label for>（点标签可聚焦；等价 getByLabelText）；
 *  2. 提交失败 → 页内 role=alert 显示后端原因（不再裸红字）；
 *  3. 联系人表单同样有 label 关联（新增联系人场景）。
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
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import CustomersPage from "../page";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type GetResp = Awaited<ReturnType<typeof apiClient.get>>;
const ok = (data: unknown) => ({ data }) as unknown as GetResp;
const CUSTOMER = {
  id: 1,
  company_name: "联佳丝网",
  abbr: "LJ",
  country: "CN",
  address: null,
  default_port: null,
  credit_level: null,
  stage: "active",
  manual_stage: "active",
  notes: null,
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-10-20T00:00:00Z",
};
const DETAIL = {
  ...CUSTOMER,
  contacts: [
    {
      id: 9,
      name: "王经理",
      position: null,
      phone: null,
      email: null,
      whatsapp: null,
      is_primary: true,
    },
  ],
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

/** 等价 testing-library 的 getByLabelText：label[for] → 控件 */
function byLabelText(text: string): HTMLElement | null {
  const label = Array.from(document.querySelectorAll("label")).find(
    (l) => (l.textContent ?? "").replace("\*", "").trim() === text,
  );
  const id = label?.getAttribute("for");
  return id ? document.getElementById(id) : null;
}

function setInputValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function buttonByText(text: string) {
  return Array.from(document.querySelectorAll("button")).find(
    (b) => (b.textContent ?? "").trim() === text,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  window.localStorage.clear();
  vi.mocked(apiClient.get).mockImplementation(async (url: string) => {
    const path = String(url);
    if (path === "/customers/1") return ok(DETAIL);
    if (path === "/customers/1/records") return ok({});
    if (path.startsWith("/customers")) {
      return ok({ items: [CUSTOMER], total: 1, page: 1, page_size: 20 });
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

describe("客户表单 FormField", () => {
  it("新建客户：字段有 label 关联；提交失败 role=alert", async () => {
    await mount();
    await waitFor(
      () => (document.body.textContent ?? "").includes(CUSTOMER.company_name),
      undefined,
      "客户列表",
    );

    act(() => buttonByText("新建客户")!.click());
    await settle();

    // 关键字段都能通过 label 文本找到控件（getByLabelText 等价）
    expect(byLabelText("公司名称")).toBeInstanceOf(HTMLInputElement);
    expect(byLabelText("联系人")).toBeInstanceOf(HTMLInputElement);
    expect(byLabelText("联系人电话")).toBeInstanceOf(HTMLInputElement);
    expect(byLabelText("联系人邮箱")).toBeInstanceOf(HTMLInputElement);
    expect(byLabelText("国家")).toBeInstanceOf(HTMLInputElement);
    expect(byLabelText("客户缩写")).toBeInstanceOf(HTMLInputElement);
    expect(byLabelText("默认港口")).toBeInstanceOf(HTMLInputElement);
    expect(byLabelText("地址")).toBeInstanceOf(HTMLInputElement);
    expect(byLabelText("信用等级")).toBeInstanceOf(HTMLInputElement);
    expect(byLabelText("备注")).toBeInstanceOf(HTMLInputElement);

    // 提交失败：页内 role=alert 显示后端原因
    vi.mocked(apiClient.post).mockRejectedValueOnce({
      response: {
        status: 409,
        data: { detail: { error: "conflict", code: "DUP", message: "公司名称重复" } },
      },
    });
    setInputValue(byLabelText("公司名称") as HTMLInputElement, "联佳丝网");
    await settle(1);
    act(() => buttonByText("创建客户")!.click());
    await waitFor(
      () => document.querySelector('[role="alert"]') !== null,
      undefined,
      "表单错误",
    );
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "公司名称重复",
    );
  });

  it("联系人表单：字段有 label 关联", async () => {
    await mount();
    await waitFor(
      () => (document.body.textContent ?? "").includes(CUSTOMER.company_name),
      undefined,
      "客户列表",
    );

    const row = document.querySelector('[data-testid="customer-card"]');
    await act(async () => {
      (row as HTMLElement).click();
    });
    await settle();
    await waitFor(
      () => (document.body.textContent ?? "").includes("联系人（1）"),
      undefined,
      "客户详情",
    );

    act(() => buttonByText("添加联系人")!.click());
    await settle();

    expect(byLabelText("姓名")).toBeInstanceOf(HTMLInputElement);
    expect(byLabelText("职位")).toBeInstanceOf(HTMLInputElement);
    expect(byLabelText("电话")).toBeInstanceOf(HTMLInputElement);
    expect(byLabelText("邮箱")).toBeInstanceOf(HTMLInputElement);
    expect(byLabelText("WhatsApp")).toBeInstanceOf(HTMLInputElement);
  });
});
