/**
 * 设置 · 重载产品配置（P0-B1 / 审计 A2）—— 全局危险操作二次确认 + 失败反馈。
 *
 * 旧行为：点一下直接生效（整站级重载），且 `mutateAsync` 没有 catch ⇒
 * 失败时只有未处理的 rejection，用户零反馈。
 *
 * 钉住：
 * 1. 点按钮只开确认弹窗，**不发 POST**；确认后才 POST /admin/tenants/reload；
 * 2. 提交中连点两次只发一次请求；
 * 3. 失败时页内 role=alert 如实说明原因（apiClient 拦截器已 toast，不重复弹），
 *    弹窗不关（可重试）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  toastError: vi.fn(),
  createEvent: vi.fn(),
}));

vi.mock("@/lib/api/client", () => {
  const client = { post: mocks.post, get: vi.fn() };
  return { default: client, apiClient: client };
});
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: mocks.toastError },
}));
vi.mock("@/lib/events/use-create-event", () => ({
  useCreateEvent: () => ({ mutate: mocks.createEvent }),
}));

import { ReloadButton } from "../reload-button";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const RESULT = {
  reloaded_count: 2,
  active_tenants: [
    {
      tenant_id: "default",
      display_name: "默认空间",
      locale: "zh-CN",
      region: "CN",
      is_active: true,
    },
  ],
};

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

function mount(element: ReactNode) {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
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
  root = null;
  container = null;
  client?.clear();
  client = null;
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

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  unmount();
  vi.restoreAllMocks();
});

describe("ReloadButton", () => {
  it("未确认不发 POST；确认后只发一次并展示重载结果", async () => {
    mocks.post.mockResolvedValue({ data: RESULT });
    mount(<ReloadButton />);

    await click(findButton("重载产品配置"));
    expect(document.body.textContent).toContain("重载产品配置？");
    expect(mocks.post).not.toHaveBeenCalled();

    await click(findButton("确认重载"));
    await settle();

    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(mocks.post).toHaveBeenCalledWith("/admin/tenants/reload");
    expect(document.body.textContent).toContain("已重载 2 个空间");
  });

  it("提交中连点两次只发一次请求（pending 防重）", async () => {
    mocks.post.mockImplementation(() => new Promise(() => {}));
    mount(<ReloadButton />);

    await click(findButton("重载产品配置"));
    await doubleClick(findButton("确认重载"));
    await settle();

    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain("提交中…");
  });

  it("失败时页内 role=alert 如实说明原因，弹窗不关", async () => {
    mocks.post.mockRejectedValue(
      Object.assign(new Error("Forbidden"), {
        response: {
          status: 403,
          data: {
            detail: {
              error: "forbidden",
              code: "ADMIN_REQUIRED",
              message: "仅平台运营可重载产品配置",
            },
          },
        },
      }),
    );
    mount(<ReloadButton />);

    await click(findButton("重载产品配置"));
    await click(findButton("确认重载"));
    await settle();

    const message = document.querySelector('[role="alert"]')?.textContent ?? "";
    expect(message).toContain("重载失败");
    expect(message).toContain("仅平台运营可重载产品配置");
    // 拦截器已统一 toast，页面不再重复弹
    expect(mocks.toastError).not.toHaveBeenCalled();
    // 弹窗仍在，可直接重试
    expect(document.body.textContent).toContain("确认重载");
    expect(document.body.textContent).not.toContain("已重载");
  });
});
