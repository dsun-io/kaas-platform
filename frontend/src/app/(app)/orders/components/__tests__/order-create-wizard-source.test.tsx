/**
 * 建单向导第 1 步的「来源」（设计 §3.2 / §9.2）：
 *   · 选到带询盘的报价 ⇒ 自动「询盘转化」，payload 带 inquiry_id、不带渠道（继承询盘渠道）；
 *   · 直接下单 ⇒ payload 带 source_type=direct + 选择��渠道；
 *   · 「询盘转化」但没选询盘 ⇒ 本地拦下并解释（内核也会 422 INQUIRY_REQUIRED）；
 *   · 内核来源类 422 ⇒ 前端把错误码翻译成可操作的话。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}));

vi.mock("@/lib/api/client", () => ({
  default: { get: mocks.get, post: mocks.post },
  apiClient: { get: mocks.get, post: mocks.post },
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { OrderCreateWizard } from "../order-create-wizard";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const QUOTE_NO_INQUIRY = {
  id: 5,
  quote_no: "QT-5",
  customer_id: 7,
  customer_name: "联佳丝网",
  inquiry_id: null,
  currency: "USD",
  total_amount: 1000,
  incoterm: "FOB",
  items: [
    {
      product_name: "勾花网",
      qty: 10,
      qty_unit: "ROLLS",
      unit_price: 100,
      line_amount: 1000,
    },
  ],
};

const QUOTE_WITH_INQUIRY = {
  ...QUOTE_NO_INQUIRY,
  id: 6,
  quote_no: "QT-6",
  inquiry_id: 4,
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let client: QueryClient | null = null;

async function settle(times = 6) {
  await act(async () => {
    for (let i = 0; i < times; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
}

function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  root = createRoot(container);
  const tree: ReactNode = (
    <QueryClientProvider client={client}>
      <OrderCreateWizard />
    </QueryClientProvider>
  );
  act(() => root!.render(tree));
}

function button(text: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll("button")).find((el) =>
    (el.textContent ?? "").includes(text),
  ) as HTMLButtonElement | undefined;
}

function click(text: string) {
  const el = button(text);
  if (!el) throw new Error(`没找到按钮「${text}」`);
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function setSelect(ariaLabel: string, value: string) {
  const el = document.querySelector<HTMLSelectElement>(
    `select[aria-label="${ariaLabel}"]`,
  );
  if (!el) throw new Error(`没找到选择器「${ariaLabel}」`);
  const setter = Object.getOwnPropertyDescriptor(
    HTMLSelectElement.prototype,
    "value",
  )?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

/** React Query 的异步查询需要真实宏任务（仅 setTimeout(0) 链不够）。 */
async function flushQuery() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  await settle(2);
}

async function toSubmit() {
  for (let i = 0; i < 4; i += 1) {
    click("下一步");
    await settle(2);
  }
  click("创建订单");
  await settle();
}

function orderPosts() {
  return mocks.post.mock.calls.filter(([url]) => String(url) === "/orders");
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockImplementation(async (url: string) => {
    const path = String(url);
    if (path === "/quotes") {
      return {
        data: {
          items: [
            {
              id: 5,
              quote_no: "QT-5",
              customer_name: "联佳丝网",
              status: "sent",
              currency: "USD",
              total_amount: 1000,
              incoterm: "FOB",
            },
            {
              id: 6,
              quote_no: "QT-6",
              customer_name: "联佳丝网",
              status: "sent",
              currency: "USD",
              total_amount: 1000,
              incoterm: "FOB",
            },
          ],
          total: 2,
        },
      };
    }
    if (path === "/quotes/5") return { data: QUOTE_NO_INQUIRY };
    if (path === "/quotes/6") return { data: QUOTE_WITH_INQUIRY };
    if (path === "/inquiries") {
      return {
        data: {
          items: [
            {
              id: 4,
              customer_id: 7,
              inquiry_no: "INQ-4",
              channel: "alibaba",
              product_name_raw: "勾花网",
              stage: "quotation",
            },
          ],
          total: 1,
        },
      };
    }
    if (path === "/customers") {
      return {
        data: { items: [{ id: 7, company_name: "联佳丝网" }], total: 1 },
      };
    }
    throw new Error(`unexpected GET ${path}`);
  });
  mocks.post.mockResolvedValue({
    data: {
      id: 99,
      order_no: "ORD-99",
      customer_name: "联佳丝网",
      status: "pending",
      currency: "USD",
      total_amount: 1000,
    },
  });
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  document.body.innerHTML = "";
  root = null;
  container = null;
  client?.clear();
  client = null;
});

describe("建单来源", () => {
  it("选到带询盘的报价 ⇒ 自动询盘转化，payload 带 inquiry_id 且不覆盖渠道", async () => {
    mount();
    await settle();
    setSelect("关联报价单", "6");
    await settle(6);
    await flushQuery();
    // 自动切到「询盘转化」并回填询盘
    const inquirySelect = document.querySelector<HTMLSelectElement>(
      'select[aria-label="选择询盘"]',
    );
    expect(inquirySelect?.value).toBe("4");
    expect(document.body.textContent).toContain("渠道将继承询盘");

    await toSubmit();
    const posts = orderPosts();
    expect(posts).toHaveLength(1);
    const payload = posts[0]![1] as Record<string, unknown>;
    expect(payload.source_type).toBe("inquiry");
    expect(payload.inquiry_id).toBe(4);
    expect(payload.source_channel).toBeUndefined();
    expect(payload.quote_order_id).toBe(6);
  });

  it("无询盘的报价默认直接下单，渠道随 payload 提交", async () => {
    mount();
    await settle();
    setSelect("关联报价单", "5");
    await settle();
    expect(
      document.querySelector('input[name="order-source"]:checked'),
    ).toHaveProperty("value", "direct");

    setSelect("来源渠道", "phone");
    await settle();
    await toSubmit();
    const posts = orderPosts();
    expect(posts).toHaveLength(1);
    const payload = posts[0]![1] as Record<string, unknown>;
    expect(payload.source_type).toBe("direct");
    expect(payload.source_channel).toBe("phone");
    expect(payload.inquiry_id).toBeUndefined();
  });

  it("询盘转化但没选询盘：本地拦下并解释，不发请求", async () => {
    mount();
    await settle();
    setSelect("关联报价单", "6");
    await settle();
    setSelect("选择询盘", "");
    await settle();
    click("下一步");
    await settle();
    expect(orderPosts()).toHaveLength(0);
    expect(document.body.textContent).toContain("必须选择询盘");
    expect(document.body.textContent).toContain("直接下单");
  });

  it("后端 422 INQUIRY_REQUIRED ⇒ 错误提示翻译成操作指引", async () => {
    mocks.post.mockRejectedValue({
      response: {
        status: 422,
        data: {
          detail: {
            error: "validation",
            code: "INQUIRY_REQUIRED",
            detail: "x",
          },
        },
      },
    });
    mount();
    await settle();
    setSelect("关联报价单", "6");
    await settle();
    await toSubmit();
    expect(document.body.textContent).toContain("必须关联询盘");
    expect(document.body.textContent).toContain("直接下单");
  });
});
