/**
 * 「添加询盘」多产品行表单组件测试（设计稿 §13 方案 A）：
 *  - 默认一行、+ 加行、删除行；
 *  - 提交 POST /customers/:id/inquiries 带 items[]，第一行同步旧标量字段；
 *  - 产品库选中自动带 product_key，手输产品不带；
 *  - 后端报错透出且不关闭表单。
 *
 * 后端 items 支持由 backend-money 并行实现，前端测试一律 mock apiClient（不依赖真实接口）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { InquiryForm } from "../inquiry-form";

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));

vi.mock("@/lib/api/client", () => ({
  default: { get: mocks.get, post: mocks.post },
  apiClient: { get: mocks.get, post: mocks.post },
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let client: QueryClient | null = null;

async function settle(times = 8) {
  await act(async () => {
    for (let i = 0; i < times; i += 1)
      await new Promise((r) => setTimeout(r, 0));
  });
}
function mount(element: ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  root = createRoot(container);
  act(() =>
    root!.render(
      <QueryClientProvider client={client!}>{element}</QueryClientProvider>,
    ),
  );
}
function clickButton(text: string) {
  const button = Array.from(document.querySelectorAll("button")).find(
    (b) => (b.textContent ?? "").trim() === text,
  );
  if (!button) throw new Error("没找到按钮「" + text + "」");
  act(() => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}
function setInput(name: string, value: string) {
  const el = document.querySelector<HTMLInputElement>(`[name="${name}"]`);
  if (!el) throw new Error("没找到输入框 " + name);
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function productRowCount() {
  return document.querySelectorAll('input[name$="-product"]').length;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockResolvedValue({
    data: {
      items: [
        {
          product_key: "chain-link",
          name: "勾花网",
          name_en: "Chain Link Fence",
          name_en_list: ["Chain Link Fence", "Chainlink Mesh"],
          name_en_aliases: ["Chainlink Mesh"],
          media_count: 0,
          profile: {},
        },
        {
          product_key: "cattle-fence",
          name: "牛栏网",
          name_en: "Cattle Fence",
          name_en_list: ["Cattle Fence"],
          name_en_aliases: [],
          media_count: 0,
          profile: {},
        },
      ],
      media_kinds: {},
    },
  });
  mocks.post.mockResolvedValue({ data: { id: 1 } });
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

describe("InquiryForm 多产品行", () => {
  it("默认一行产品；+ 加行、删除行", async () => {
    mount(<InquiryForm customerId={7} onClose={vi.fn()} />);
    await settle();
    expect(productRowCount()).toBe(1);
    expect(document.body.textContent).toContain("产品 1");
    // 只有一行时没有删除按钮
    expect(document.body.textContent).not.toContain("删除");

    clickButton("再加一个产品");
    await settle();
    expect(productRowCount()).toBe(2);
    expect(document.body.textContent).toContain("产品 2");
    expect(document.body.textContent).toContain("删除");

    clickButton("删除");
    await settle();
    expect(productRowCount()).toBe(1);
    expect(document.body.textContent).not.toContain("产品 2");
  });

  it("两行产品提交：带 items[]，产品库选中的行带 product_key，旧字段同步第一行", async () => {
    const onClose = vi.fn();
    mount(<InquiryForm customerId={7} onClose={onClose} />);
    await settle();

    setInput("inquiry-notes", " 客户要样品 ");
    setInput("item-0-product", "勾花网");
    setInput("item-0-spec", "2.5mm 热镀锌");
    setInput("item-0-quantity", "1000");
    setInput("item-0-unit", "㎡");
    setInput("item-0-application", "围栏");

    clickButton("再加一个产品");
    await settle();
    // 手输产品（不在产品库里）⇒ 不带 product_key
    setInput("item-1-product", "牧场围栏网");
    setInput("item-1-quantity", "500");
    setInput("item-1-unit", "m");
    setInput("item-1-application", "牧场");

    clickButton("添加询盘");
    await settle();

    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(mocks.post).toHaveBeenCalledWith("/customers/7/inquiries", {
      customer_id: 7,
      notes: "客户要样品",
      items: [
        {
          product_key: "chain-link",
          product_name_raw: "勾花网",
          spec_text: "2.5mm 热镀锌",
          quantity: 1000,
          quantity_unit: "㎡",
          application: "围栏",
        },
        {
          product_name_raw: "牧场围栏网",
          quantity: 500,
          quantity_unit: "m",
          application: "牧场",
        },
      ],
      product_name_raw: "勾花网",
      quantity: 1000,
      quantity_unit: "㎡",
      application: "围栏",
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("产品库候选含全部英文名；手输英文别名也能反查 product_key", async () => {
    mount(<InquiryForm customerId={7} onClose={vi.fn()} />);
    await settle();

    // 中文名 + 默认英文名 + 其它英文名都进候选（任一写法都能选/输）
    const options = Array.from(
      document.querySelectorAll<HTMLOptionElement>("datalist option"),
    ).map((o) => o.value);
    expect(options).toContain("勾花网");
    expect(options).toContain("Chain Link Fence");
    expect(options).toContain("Chainlink Mesh");
    expect(options).toContain("Cattle Fence");

    // 手输别名（大小写 + 连续空格归一）⇒ 仍能反查到同一个 product_key
    setInput("item-0-product", "  chainlink   mesh ");
    clickButton("添加询盘");
    await settle();
    expect(mocks.post).toHaveBeenCalledWith(
      "/customers/7/inquiries",
      expect.objectContaining({
        items: [
          expect.objectContaining({
            product_key: "chain-link",
            product_name_raw: "chainlink   mesh",
          }),
        ],
      }),
    );
  });

  it("只填渠道/备注也能提交（不发明细，保持旧行为）", async () => {
    mount(<InquiryForm customerId={3} onClose={vi.fn()} />);
    await settle();
    setInput("inquiry-notes", "先电话沟通");
    clickButton("添加询盘");
    await settle();
    expect(mocks.post).toHaveBeenCalledWith("/customers/3/inquiries", {
      customer_id: 3,
      notes: "先电话沟通",
    });
  });

  it("后端报错时透出错误、不关闭表单", async () => {
    const onClose = vi.fn();
    mocks.post.mockRejectedValue({
      response: { status: 422, data: { detail: "产品名称过长" } },
    });
    mount(<InquiryForm customerId={7} onClose={onClose} />);
    await settle();
    setInput("item-0-product", "勾花网");
    clickButton("添加询盘");
    await settle();
    expect(onClose).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("产品名称过长");
  });

  it("产品库接口失败时不阻塞手输提交", async () => {
    mocks.get.mockRejectedValue({ response: { status: 500 } });
    const onClose = vi.fn();
    mount(<InquiryForm customerId={7} onClose={onClose} />);
    await settle();
    setInput("item-0-product", "手输产品");
    clickButton("添加询盘");
    await settle();
    expect(mocks.post).toHaveBeenCalledWith(
      "/customers/7/inquiries",
      expect.objectContaining({
        items: [{ product_name_raw: "手输产品" }],
        product_name_raw: "手输产品",
      }),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
