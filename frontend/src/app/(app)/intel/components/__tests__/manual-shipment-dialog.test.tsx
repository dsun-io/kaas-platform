/**
 * 手工新增货运对话框（C36 #16）组件测试：
 * 必填字段拦截 → 合法 POST `/intel/shipments`（payload 已 trim/转 number/ship_date 转 datetime）
 * → 后端 422 字段数组错误显示。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ManualShipmentDialog } from "../manual-shipment-dialog";

const mocks = vi.hoisted(() => ({ post: vi.fn() }));

vi.mock("@/lib/api/client", () => ({
  default: { post: mocks.post },
  apiClient: { post: mocks.post },
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let client: QueryClient | null = null;

async function settle(times = 6) {
  await act(async () => {
    for (let i = 0; i < times; i += 1) await new Promise((r) => setTimeout(r, 0));
  });
}
function mount(element: ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  root = createRoot(container);
  act(() => root!.render(<QueryClientProvider client={client!}>{element}</QueryClientProvider>));
}
function clickButton(text: string) {
  const button = Array.from(document.querySelectorAll("button")).find(
    (b) => (b.textContent ?? "").trim() === text,
  );
  if (!button) throw new Error(`没找到按钮「${text}」`);
  act(() => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}
function setInput(name: string, value: string) {
  const el = document.querySelector<HTMLInputElement>(`[name="${name}"]`);
  if (!el) throw new Error(`没找到输入框 ${name}`);
  const setter = Object.getOwnPropertyDescriptor(
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
    "value",
  )!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  document.body.innerHTML = "";
  root = null;
  container = null;
  client?.clear();
  client = null;
});

describe("ManualShipmentDialog", () => {
  it("三个必填为空时本地拦截（字段级错误可见）", async () => {
    mount(<ManualShipmentDialog open onOpenChange={vi.fn()} />);
    clickButton("保存货运记录");
    await settle();
    expect(mocks.post).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("发货人不能为空");
    expect(document.body.textContent).toContain("收货人不能为空");
    expect(document.body.textContent).toContain("产品描述不能为空");
  });

  it("合法提交 POST /intel/shipments：trim + 数字 + datetime 转换", async () => {
    mocks.post.mockResolvedValue({ data: { id: 101 } });
    const onOpenChange = vi.fn();
    mount(<ManualShipmentDialog open onOpenChange={onOpenChange} />);
    setInput("shipper", "  ANPING KAAS  ");
    setInput("consignee", "HANSA FENCE");
    setInput("product_desc", " chain link fence ");
    setInput("ship_date", "2026-10-12");
    setInput("qty", "120");
    clickButton("保存货运记录");
    await settle();
    expect(mocks.post).toHaveBeenCalledWith(
      "/intel/shipments",
      {
        shipper: "ANPING KAAS",
        consignee: "HANSA FENCE",
        product_desc: "chain link fence",
        ship_date: "2026-10-12T00:00:00",
        qty: 120,
      },
      { silent: true },
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("后端 422 字段数组 → 字段级错误显示", async () => {
    mocks.post.mockRejectedValue({
      response: {
        status: 422,
        data: { detail: [{ loc: ["body", "shipper"], msg: "Field required", type: "missing" }] },
      },
    });
    mount(<ManualShipmentDialog open onOpenChange={vi.fn()} />);
    setInput("shipper", "A");
    setInput("consignee", "B");
    setInput("product_desc", "C");
    clickButton("保存货运记录");
    await settle();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "发货人：Field required",
    );
  });
});
