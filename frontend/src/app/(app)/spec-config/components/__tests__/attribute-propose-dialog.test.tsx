/**
 * 属性提议弹窗（P0-B2/SC5）—— 失败反馈 + 成功 toast + pending 防重。
 *
 * 旧行为：提交直接 `await mutateAsync`，失败即未处理 rejection（弹窗无说明），
 * 成功也没有任何提示。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mocks = vi.hoisted(() => ({ post: vi.fn(), toastSuccess: vi.fn() }));

vi.mock("@/lib/api/client", () => {
  const client = { post: mocks.post, get: vi.fn(), patch: vi.fn() };
  return { default: client, apiClient: client };
});
vi.mock("sonner", () => ({
  toast: {
    success: mocks.toastSuccess,
    error: vi.fn(),
    info: vi.fn(),
  },
}));

import { AttributeProposeDialog } from "../AttributeProposeDialog";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

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

function mount(onClose: () => void) {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <QueryClientProvider client={client!}>
        <AttributeProposeDialog
          open
          onClose={onClose}
          categoryId={1}
          groupCode="spec"
        />
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

function setName(value: string) {
  const el = document.querySelector<HTMLInputElement>(
    'input[placeholder="例如: 镀锌层厚度"]',
  );
  if (!el) throw new Error("没找到属性名称输入框");
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  unmount();
  vi.restoreAllMocks();
});

describe("AttributeProposeDialog", () => {
  it("失败 → 弹窗内显示原因且不关闭；成功 → toast 并关闭", async () => {
    const onClose = vi.fn();
    mocks.post.mockRejectedValue(
      Object.assign(new Error("Conflict"), {
        response: {
          status: 409,
          data: {
            detail: {
              error: "conflict",
              code: "ATTRIBUTE_ALREADY_EXISTS",
              message: "该属性已存在，无需重复提议",
            },
          },
        },
      }),
    );
    mount(onClose);
    setName("镀锌层厚度");
    await settle(2);
    await click(findButton("提交"));
    await settle();

    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("该属性已存在");
    expect(onClose).not.toHaveBeenCalled();
    expect(mocks.toastSuccess).not.toHaveBeenCalled();

    // 修正后重试：成功则关闭并 toast
    mocks.post.mockResolvedValue({ data: { id: 9, status: "pending" } });
    await click(findButton("提交"));
    await settle();
    expect(mocks.post).toHaveBeenCalledTimes(2);
    expect(mocks.toastSuccess).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("pending 期间不重复提交（按钮禁用）", async () => {
    const onClose = vi.fn();
    mocks.post.mockImplementation(() => new Promise(() => {}));
    mount(onClose);
    setName("涂层厚度");
    await settle(2);
    await click(findButton("提交"));
    await settle();

    expect(mocks.post).toHaveBeenCalledTimes(1);
    const pending = findButton("提交中...");
    expect(pending.disabled).toBe(true);
    await click(pending);
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(mocks.post.mock.calls[0]![0]).toBe("/spec/wizard/propose-attribute");
  });
});
