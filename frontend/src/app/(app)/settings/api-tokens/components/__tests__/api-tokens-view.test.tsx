/**
 * 设置 → API 令牌（W5 M1）组件测试。
 *
 * 覆盖：
 * 1. 列表状态（有效 / 已撤销 / 已过期）与作用域摘要；
 * 2. 空态 CTA 能打开创建对话框；
 * 3. 创建流程：名称 + 作用域 + 有效期 → POST 正确 body → 「仅显示一次」面板，
 *    必须手动关闭，关闭后明文消失；
 * 4. 撤销二次确认 → DELETE，成功后关闭弹窗；
 * 5. 重复撤销 409 TOKEN_ALREADY_REVOKED → 明确文案。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ApiTokensView } from "../api-tokens-view";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("@/lib/api/client", () => ({
  default: { get: mocks.get, post: mocks.post, delete: mocks.delete },
  apiClient: { get: mocks.get, post: mocks.post, delete: mocks.delete },
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
    info: vi.fn(),
  },
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const ACTIVE_TOKEN = {
  id: 1,
  name: "官网询盘同步",
  prefix: "kaas_oat_AbCdEf12",
  scopes: ["customers:read", "inquiries:read", "inquiries:write"],
  created_at: "2026-10-12T08:00:00.000Z",
  last_used_at: "2026-10-20T09:30:00.000Z",
  expires_at: null,
  revoked_at: null,
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let client: QueryClient | null = null;

async function settle(times = 8) {
  await act(async () => {
    for (let i = 0; i < times; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
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
  document.body.innerHTML = "";
  client?.clear();
  root = null;
  container = null;
  client = null;
}

function findButton(label: string): HTMLButtonElement {
  const buttons = Array.from(document.querySelectorAll("button"));
  const target = buttons.find(
    (button) =>
      (button.textContent ?? "").replace("…", "").trim() === label ||
      button.getAttribute("aria-label") === label,
  );
  if (!target) throw new Error(`没找到按钮「${label}」`);
  return target;
}

function clickButton(label: string) {
  const target = findButton(label);
  act(() => {
    target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function setInput(id: string, value: string) {
  const input = document.querySelector<HTMLInputElement>(`#${id}`);
  if (!input) throw new Error(`没找到输入框 #${id}`);
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function toggleCheckbox(value: string) {
  const input = document.querySelector<HTMLInputElement>(
    `input[type="checkbox"][value="${value}"]`,
  );
  if (!input) throw new Error(`没找到作用域复选框 ${value}`);
  act(() => {
    input.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function setSelect(id: string, value: string) {
  const select = document.querySelector<HTMLSelectElement>(`#${id}`);
  if (!select) throw new Error(`没找到下拉框 #${id}`);
  const setter = Object.getOwnPropertyDescriptor(
    HTMLSelectElement.prototype,
    "value",
  )!.set!;
  act(() => {
    setter.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockResolvedValue({ data: { items: [], total: 0 } });
});

afterEach(() => {
  unmount();
});

describe("ApiTokensView", () => {
  it("渲染令牌状态与作用域摘要（列表不出现明文）", async () => {
    mocks.get.mockResolvedValue({
      data: {
        items: [
          ACTIVE_TOKEN,
          {
            ...ACTIVE_TOKEN,
            id: 2,
            name: "旧版报表脚本",
            scopes: ["orders:read", "quotes:read"],
            revoked_at: "2026-10-15T03:00:00.000Z",
          },
          {
            ...ACTIVE_TOKEN,
            id: 3,
            name: "临时测试令牌",
            scopes: ["files:read"],
            expires_at: "2026-09-01T00:00:00.000Z",
          },
        ],
        total: 3,
      },
    });

    mount(<ApiTokensView />);
    await settle();

    const text = document.body.textContent ?? "";
    expect(text).toContain("官网询盘同步");
    expect(text).toContain("kaas_oat_AbCdEf12");
    expect(text).toContain("读取客户、读取询盘、创建 / 编辑询盘");
    expect(text).toContain("有效");
    expect(text).toContain("已撤销");
    expect(text).toContain("已过期");
    expect(text).not.toContain("plaintext");
  });

  it("空态展示引导，CTA 打开创建对话框", async () => {
    mount(<ApiTokensView />);
    await settle();

    expect(document.body.textContent).toContain("还没有系统对接密钥");
    expect(document.body.textContent).toContain("外部系统");
    clickButton("创建第一个密钥");
    await settle();

    expect(document.body.textContent).toContain("创建系统对接密钥");
    expect(document.body.textContent).toContain("权限范围");
    expect(document.body.textContent).toContain("生成密钥");
    // 技术名词不出现在用户可见处
    for (const vocab of ["REST", "MCP", "Bearer", "明文"]) {
      expect(document.body.textContent).not.toContain(vocab);
    }
  });

  it("创建令牌：POST 正确 body，明文只显示一次且必须手动关闭", async () => {
    mocks.post.mockResolvedValue({
      data: {
        ...ACTIVE_TOKEN,
        id: 7,
        name: "CI 只读同步",
        scopes: ["customers:read"],
        plaintext: "kaas_oat_mock0007mmm",
      },
    });

    mount(<ApiTokensView />);
    await settle();
    clickButton("创建密钥");
    await settle();

    setInput("api-token-name", "  CI 只读同步  ");
    toggleCheckbox("customers:read");
    setSelect("api-token-expiry", "30");

    clickButton("生成密钥");
    await settle(12);

    expect(mocks.post).toHaveBeenCalledWith("/api-tokens", {
      name: "CI 只读同步",
      scopes: ["customers:read"],
      expires_in_days: 30,
    });
    expect(document.body.textContent).toContain("仅显示一次");
    expect(document.body.textContent).toContain("kaas_oat_mock0007mmm");
    expect(document.body.textContent).toContain("我已保存，关闭");

    // 不会自动关闭；Esc 也不能关掉（必须手动点关闭按钮）
    await settle();
    expect(document.body.textContent).toContain("仅显示一次");
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    await settle();
    expect(document.body.textContent).toContain("仅显示一次");

    clickButton("我已保存，关闭");
    await settle();
    const after = document.body.textContent ?? "";
    expect(after).not.toContain("仅显示一次");
    expect(after).not.toContain("kaas_oat_mock0007mmm");
  });

  it("撤销前二次确认，确认后 DELETE 并关闭弹窗", async () => {
    mocks.get.mockResolvedValue({
      data: { items: [ACTIVE_TOKEN], total: 1 },
    });
    mocks.delete.mockResolvedValue({
      data: { revoked: true, id: 1, revoked_at: "2026-10-21T04:00:00.000Z" },
    });

    mount(<ApiTokensView />);
    await settle();
    clickButton("撤销密钥 官网询盘同步");
    await settle();

    expect(document.body.textContent).toContain("无法恢复");
    clickButton("确认撤销");
    await settle();

    expect(mocks.delete).toHaveBeenCalledWith("/api-tokens/1");
    expect(toastSuccess).toHaveBeenCalledWith(
      expect.stringContaining("已撤销密钥「官网询盘同步」"),
    );
    expect(document.body.textContent).not.toContain("无法恢复");
  });

  it("重复撤销 409 → 弹窗内展示明确原因", async () => {
    mocks.get.mockResolvedValue({
      data: { items: [ACTIVE_TOKEN], total: 1 },
    });
    mocks.delete.mockRejectedValue({
      response: {
        status: 409,
        data: {
          detail: { error: "conflict", code: "TOKEN_ALREADY_REVOKED" },
        },
      },
    });

    mount(<ApiTokensView />);
    await settle();
    clickButton("撤销密钥 官网询盘同步");
    await settle();
    clickButton("确认撤销");
    await settle();

    expect(document.body.textContent).toContain("该系统对接密钥已经撤销");
    expect(toastError).not.toHaveBeenCalled();
  });
});
