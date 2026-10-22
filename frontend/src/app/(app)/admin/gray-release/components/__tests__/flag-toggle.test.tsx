/**
 * 灰度开关（/admin/gray-release）—— P0-B2/G1+G2 失败反馈 + pending 防重。
 *
 * 钉住：
 * 1. 切换失败 → 弹窗内 role="alert" 显示后端原因，弹窗不关、可重试，开关视觉保持原值；
 * 2. pending 期间确认/取消禁用、不能重复提交；
 * 3. 成功 → toast + 关闭弹窗。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  toastSuccess: vi.fn(),
  createEvent: vi.fn(),
}));

vi.mock("@/lib/api/client", () => {
  const client = { post: mocks.post, get: vi.fn(), patch: vi.fn() };
  return { default: client, apiClient: client };
});
vi.mock("sonner", () => ({
  toast: { success: mocks.toastSuccess, error: vi.fn(), info: vi.fn() },
}));
vi.mock("@/lib/events/use-create-event", () => ({
  useCreateEvent: () => ({ mutate: mocks.createEvent }),
}));

import { FlagToggle } from "../flag-toggle";

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

/** 弹窗里的确认按钮（卡片上的「切换」在 pending 时文案同为「切换中…」，需取后者）。 */
function findLastButton(text: string): HTMLButtonElement {
  const list = Array.from(document.querySelectorAll("button")).filter((b) =>
    (b.textContent ?? "").includes(text),
  );
  const button = list[list.length - 1];
  if (!button) throw new Error(`没找到按钮「${text}」`);
  return button;
}

async function click(el: HTMLElement) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await settle(2);
}

function setInput(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function reasonInput(): HTMLInputElement {
  const el = document.querySelector<HTMLInputElement>(
    'input[placeholder="请输入变更原因..."]',
  );
  if (!el) throw new Error("没找到变更原因输入框");
  return el;
}

async function openDialogAndTypeReason() {
  await click(findButton("切换"));
  setInput(reasonInput(), "灰度放量");
  await settle(2);
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  unmount();
  vi.restoreAllMocks();
});

describe("灰度开关 · 失败反馈与防重", () => {
  it("切换失败 → 弹窗内显示原因、弹窗不关、开关视觉不变", async () => {
    mocks.post.mockRejectedValue(
      Object.assign(new Error("Forbidden"), {
        response: {
          status: 403,
          data: {
            detail: {
              error: "forbidden",
              code: "PLATFORM_ADMIN_REQUIRED",
              message: "需要平台管理员权限才能切换灰度开关",
            },
          },
        },
      }),
    );
    mount(
      <FlagToggle
        tenantId="default"
        tenantName="默认空间"
        flagKey="use_v2"
        enabled={false}
      />,
    );
    await openDialogAndTypeReason();
    await click(findButton("确认"));
    await settle();

    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("需要平台管理员权限");
    // 弹窗保留（可重试），开关仍是"已关闭"
    expect(document.body.textContent).toContain("确认切换灰度开关");
    expect(document.body.textContent).toContain("已关闭");
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  it("pending 期间不能重复提交（按钮禁用 + 取消禁用）", async () => {
    mocks.post.mockImplementation(() => new Promise(() => {}));
    mount(
      <FlagToggle
        tenantId="default"
        tenantName="默认空间"
        flagKey="use_v2"
        enabled={false}
      />,
    );
    await openDialogAndTypeReason();
    await click(findButton("确认"));
    await settle();

    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(findLastButton("切换中…").disabled).toBe(true);
    expect(findButton("取消").disabled).toBe(true);

    // pending 期间再点确认（disabled 不应触发）
    await click(findLastButton("切换中…"));
    expect(mocks.post).toHaveBeenCalledTimes(1);
  });

  it("成功 → toast 并关闭弹窗", async () => {
    mocks.post.mockResolvedValue({
      data: {
        tenant_id: "default",
        flag_name: "use_v2",
        old_value: false,
        new_value: true,
      },
    });
    mount(
      <FlagToggle
        tenantId="default"
        tenantName="默认空间"
        flagKey="use_v2"
        enabled={false}
      />,
    );
    await openDialogAndTypeReason();
    await click(findButton("确认"));
    await settle();

    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(mocks.post.mock.calls[0]![0]).toBe("/admin/feature_flag");
    expect(mocks.toastSuccess).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toContain("确认切换灰度开关");
  });
});
