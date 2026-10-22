/**
 * AI 服务商（/settings/ai-providers）—— P0-B1 危险操作止血回归。
 *
 * 钉住：
 * 1. 已配置密钥时输入框留空，「保存」必须禁用（旧实现留空保存 = 静默清密钥）；
 * 2. 「清除密钥」二次确认，未确认不发 PUT；确认后只发一次（pending 连点不重复）；
 * 3. 「测试连接」提交中连点只发一次；
 * 4. 模型输入改为失焦保存：打字过程中不发请求，失焦后只发一次。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn(),
  post: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/lib/api/client", () => {
  const client = {
    get: mocks.get,
    put: mocks.put,
    post: mocks.post,
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
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));
vi.mock("../components/run-task-dialog", () => ({
  RunTaskDialog: () => null,
}));

import AiProvidersPage from "../page";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const PROVIDERS = [
  {
    provider: "deepseek",
    enabled: true,
    api_key_masked: "sk-…abc",
    has_key: true,
    base_url: null,
  },
  {
    provider: "kimi",
    enabled: false,
    api_key_masked: null,
    has_key: false,
    base_url: null,
  },
  {
    provider: "zhipu",
    enabled: false,
    api_key_masked: null,
    has_key: false,
    base_url: null,
  },
];
const TASKS = [
  {
    task_key: "lead_scoring",
    name: "线索评分",
    recommended_provider: "deepseek",
  },
];
const BINDINGS = [
  {
    task_key: "lead_scoring",
    provider: "deepseek",
    model: "deepseek-chat",
    enabled: true,
  },
];

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let client: QueryClient | null = null;

async function settle(times = 6) {
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
        `等待超时：${label}（当前页面文本：${document.body.textContent?.slice(0, 400) ?? ""}）`,
      );
    }
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
  }
}

function mount() {
  client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <QueryClientProvider client={client!}>
        <AiProvidersPage />
      </QueryClientProvider>,
    );
  });
}

function unmount() {
  if (root) act(() => root!.unmount());
  container?.remove();
  document.body.innerHTML = "";
  root = null;
  container = null;
  client?.clear();
  client = null;
}

function buttonByLabel(label: string): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  );
  if (!button) throw new Error(`没找到按钮 aria-label=${label}`);
  return button;
}

function findButton(text: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll("button")).find((b) =>
    (b.textContent ?? "").includes(text),
  );
  if (!button) throw new Error(`没找到按钮「${text}」`);
  return button;
}

async function click(el: HTMLElement) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await settle(2);
}

async function doubleClick(el: HTMLElement) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await settle(2);
}

function setInputValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function keyInputs(): HTMLInputElement[] {
  return Array.from(
    document.querySelectorAll<HTMLInputElement>(
      'input[placeholder="粘贴服务商密钥…"]',
    ),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockImplementation(async (url: string) => {
    if (url === "/ai/providers") return { data: { items: PROVIDERS } };
    if (url === "/ai/tasks") return { data: { items: TASKS } };
    if (url === "/ai/task-bindings") return { data: { items: BINDINGS } };
    if (url === "/ai/usage") return { data: { items: [], stats: [] } };
    return { data: { items: [] } };
  });
});

afterEach(() => {
  unmount();
  vi.restoreAllMocks();
});

describe("AI 服务商 · 保存密钥", () => {
  it("已配置密钥时输入框留空 ⇒ 保存按钮禁用（不再留空即清密钥）", async () => {
    mount();
    await waitFor(
      () => (document.body.textContent ?? "").includes("已配置"),
      undefined,
      "服务商列表加载",
    );

    const saveBtn = buttonByLabel("保存 DeepSeek密钥");
    expect(saveBtn.disabled).toBe(true);

    setInputValue(keyInputs()[0]!, "sk-live-new");
    await settle(2);
    // 填了密钥才可保存；此时还没发请求
    expect(buttonByLabel("保存 DeepSeek密钥").disabled).toBe(false);
    expect(mocks.put).not.toHaveBeenCalled();
  });
});

describe("AI 服务商 · 清除密钥二次确认", () => {
  it("未确认不发 PUT；确认后只发一次", async () => {
    mocks.put.mockResolvedValue({ data: {} });
    mount();
    await waitFor(
      () => (document.body.textContent ?? "").includes("已配置"),
      undefined,
      "服务商列表加载",
    );

    await click(findButton("清除密钥"));
    expect(document.body.textContent).toContain("清除 DeepSeek 的服务密钥？");
    expect(mocks.put).not.toHaveBeenCalled();

    await click(findButton("确认清除"));
    await waitFor(() => mocks.put.mock.calls.length > 0, undefined, "清除请求");
    expect(mocks.put).toHaveBeenCalledTimes(1);
    expect(mocks.put).toHaveBeenCalledWith("/ai/providers/deepseek", {
      api_key: "",
    });
  });

  it("提交中连点两次只发一次请求（pending 防重）", async () => {
    mocks.put.mockImplementation(() => new Promise(() => {}));
    mount();
    await waitFor(
      () => (document.body.textContent ?? "").includes("已配置"),
      undefined,
      "服务商列表加载",
    );
    await click(findButton("清除密钥"));
    await doubleClick(findButton("确认清除"));
    await settle();

    expect(mocks.put).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain("提交中…");
  });
});

describe("AI 服务商 · 测试连接 pending 防重", () => {
  it("提交中连点两次只发一次请求", async () => {
    mocks.post.mockImplementation(() => new Promise(() => {}));
    mount();
    await waitFor(
      () => (document.body.textContent ?? "").includes("已配置"),
      undefined,
      "服务商列表加载",
    );

    const testBtn = buttonByLabel("测试 DeepSeek连接");
    await doubleClick(testBtn);
    await settle();

    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(mocks.post).toHaveBeenCalledWith("/ai/providers/deepseek/test");
    expect(buttonByLabel("测试 DeepSeek连接").disabled).toBe(true);
  });
});

describe("AI 服务商 · 模型失焦保存（C3）", () => {
  it("打字过程中不发请求，失焦后只 PATCH 一次", async () => {
    mocks.put.mockResolvedValue({ data: {} });
    mount();
    await waitFor(
      () => (document.body.textContent ?? "").includes("线索评分"),
      undefined,
      "任务绑定加载",
    );

    const modelInput = document.querySelector<HTMLInputElement>(
      'input[placeholder="默认模型"]',
    );
    expect(modelInput).not.toBeNull();
    expect(modelInput!.value).toBe("deepseek-chat");

    setInputValue(modelInput!, "deepseek-v3");
    await settle(2);
    // 旧实现 onChange 逐字 PATCH；新实现打字期间不发请求
    expect(mocks.put).not.toHaveBeenCalled();

    await act(async () => {
      modelInput!.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    await settle(2);

    expect(mocks.put).toHaveBeenCalledTimes(1);
    expect(mocks.put).toHaveBeenCalledWith("/ai/task-bindings/lead_scoring", {
      model: "deepseek-v3",
    });
  });
});
