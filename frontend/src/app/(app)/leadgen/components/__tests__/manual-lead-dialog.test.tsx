/**
 * 手工新建线索对话框（C36 #18）组件测试：
 * 必填校验本地拦截 → 合法 POST `/leads` → 409 重复提示透出。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ManualLeadDialog } from "../manual-lead-dialog";

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
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
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

describe("ManualLeadDialog", () => {
  it("公司名称为空时本地拦截，不发请求", async () => {
    mount(<ManualLeadDialog open onOpenChange={vi.fn()} />);
    clickButton("保存线索");
    await settle();
    expect(mocks.post).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("公司名称不能为空");
  });

  it("合法提交 POST /leads（只带非空字段），成功后关闭", async () => {
    mocks.post.mockResolvedValue({ data: { company_name: "ACME" } });
    const onOpenChange = vi.fn();
    mount(<ManualLeadDialog open onOpenChange={onOpenChange} />);
    setInput("company_name", "  ACME  ");
    clickButton("保存线索");
    await settle();
    expect(mocks.post).toHaveBeenCalledWith(
      "/leads",
      { company_name: "ACME" },
      { silent: true },
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("后端 409 DUPLICATE_PLACE 时显示重复提示（不静默）", async () => {
    mocks.post.mockRejectedValue({
      response: { status: 409, data: { detail: { error: "conflict", code: "DUPLICATE_PLACE" } } },
    });
    mount(<ManualLeadDialog open onOpenChange={vi.fn()} />);
    setInput("company_name", "ACME");
    clickButton("保存线索");
    await settle();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "同一公司已存在线索",
    );
  });
});
