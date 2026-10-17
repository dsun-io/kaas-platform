/**
 * CustomerPicker 内联新建 —— 「搜不到客户就地新建」流程测试。
 *
 * 硬行为（UNCERTAIN #21 口径）：
 * 1. 下拉底部「新建客户」入口；搜索词自动带入新建表单（用户打的公司名就是要建的名字）；
 * 2. 只填公司名即可保存（POST /customers 最小契约）；
 * 3. 保存成功 ⇒ onChange 回写 {id, name} 选中（开单快照来源），并重置表单。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { CustomerPicker } from "../customer-picker";

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));

vi.mock("@/lib/api/client", () => ({
  default: { get: mocks.get, post: mocks.post },
  apiClient: { get: mocks.get, post: mocks.post },
}));

vi.mock("@/lib/workstation/use-upstream", () => ({
  useCustomerSearch: () => ({
    data: { items: [], total: 0 },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
  useCustomerName: () => ({ data: null }),
  customerOptionName: (o: { company_name?: string; name?: string }) =>
    o.company_name || o.name || "",
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
  },
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let client: QueryClient | null = null;

async function settle(times = 3) {
  await act(async () => {
    for (let i = 0; i < times; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
  });
}

function mount(element: ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  root = createRoot(container);
  act(() => {
    root!.render(
      <QueryClientProvider client={client!}>{element}</QueryClientProvider>,
    );
  });
}

function unmount() {
  if (root) act(() => root!.unmount());
  container?.remove();
  client?.clear();
  root = null;
  container = null;
  client = null;
}

function findButton(text: string): HTMLButtonElement {
  const buttons = Array.from(container!.querySelectorAll("button"));
  const norm = (s: string) => s.replace(/…/g, "").trim();
  const target = buttons.find((b) => norm(b.textContent ?? "") === norm(text));
  if (!target) throw new Error(`没找到按钮「${text}」`);
  return target as HTMLButtonElement;
}

function clickButton(text: string) {
  act(() => {
    findButton(text).dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function typeInput(placeholder: string, value: string) {
  const input = container!.querySelector(
    `input[placeholder='${placeholder}']`,
  ) as HTMLInputElement;
  if (!input) throw new Error(`没找到输入框「${placeholder}」`);
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

let picked: { id: string; name: string } | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  picked = null;
  mount(
    <CustomerPicker
      value={null}
      onChange={(next) => {
        picked = next;
      }}
    />,
  );
});

afterEach(() => {
  unmount();
});

describe("CustomerPicker 内联新建", () => {
  it("下拉里没有匹配客户时，可就地新建并选中", async () => {
    // 打开下拉
    clickButton("搜索并选择客户…");
    await settle();
    expect(container!.textContent).toContain("没有匹配的客户");

    // 进新建表单
    clickButton("新建客户");
    await settle();
    expect(container!.textContent).toContain("新建业务客户");

    typeInput("公司名称（必填）", "安平新兴丝网厂");
    mocks.post.mockResolvedValue({
      data: { id: 42, company_name: "安平新兴丝网厂" },
    });
    clickButton("保存并选用");
    await settle();

    expect(mocks.post).toHaveBeenCalledWith("/customers", {
      company_name: "安平新兴丝网厂",
      country: undefined,
    });
    expect(picked).toEqual({ id: "42", name: "安平新兴丝网厂" });
    expect(toastSuccess).toHaveBeenCalledWith(
      expect.stringContaining("安平新兴丝网厂"),
    );
  });

  it("公司名为空时保存按钮禁用", async () => {
    clickButton("搜索并选择客户…");
    await settle();
    clickButton("新建客户");
    await settle();
    const save = findButton("保存并选用");
    expect(save.disabled).toBe(true);
  });

  it("新建失败给 toast 错误，表单保持打开", async () => {
    clickButton("搜索并选择客户…");
    await settle();
    clickButton("新建客户");
    await settle();
    typeInput("公司名称（必填）", "某工厂");
    mocks.post.mockRejectedValue(new Error("network"));
    clickButton("保存并选用");
    await settle();
    expect(toastError).toHaveBeenCalledWith("新建客户失败，请稍后重试");
    expect(container!.textContent).toContain("新建业务客户");
    expect(picked).toBeNull();
  });
});
