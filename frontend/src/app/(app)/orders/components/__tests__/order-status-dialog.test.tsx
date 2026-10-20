/**
 * 订单状态流转弹窗（C36 下期 #21）——只列合法目标、确认说明副作用、错误透出。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { OrderStatusDialog } from "../order-status-dialog";

const mocks = vi.hoisted(() => ({ post: vi.fn() }));

vi.mock("@/lib/api/client", () => ({
  default: { post: mocks.post },
  apiClient: { post: mocks.post },
}));

const toastSuccess = vi.fn();
vi.mock("sonner", () => ({
  toast: { success: (...a: unknown[]) => toastSuccess(...a), error: vi.fn() },
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

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

function clickButton(text: string) {
  const button = Array.from(document.querySelectorAll("button")).find(
    (b) => (b.textContent ?? "").trim() === text,
  );
  if (!button) throw new Error(`没找到按钮「${text}」`);
  act(() => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
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

describe("OrderStatusDialog", () => {
  it("目标只列合法状态，确认说明后端副作用；提交 POST /orders/{id}/status", async () => {
    mocks.post.mockResolvedValue({ data: { id: 9, status: "confirmed" } });
    mount(
      <OrderStatusDialog
        open
        onOpenChange={() => {}}
        order={{ id: 9, order_no: "SO-202610-0001", status: "pending" }}
      />,
    );
    await settle();

    const text = document.body.textContent ?? "";
    expect(text).toContain("SO-202610-0001");
    expect(text).toContain("待确认");
    expect(text).toContain("确认后后端会锁定当日汇率");
    // 下拉里只有两个合法目标
    const options = Array.from(
      document.querySelectorAll("select option"),
    ).map((o) => o.textContent?.trim());
    expect(options).toEqual(["已确认", "已取消"]);

    clickButton("确认流转");
    await settle();

    expect(mocks.post).toHaveBeenCalledWith(
      "/orders/9/status",
      { status: "confirmed" },
      { silent: true },
    );
    expect(toastSuccess).toHaveBeenCalledWith(
      expect.stringContaining("已确认"),
    );
  });

  it("409 ILLEGAL_TRANSITION：把「允许的目标」展示出来，弹窗不关闭", async () => {
    mocks.post.mockRejectedValue(
      Object.assign(new Error("Conflict"), {
        response: {
          status: 409,
          data: {
            detail: {
              error: "conflict",
              code: "ILLEGAL_TRANSITION",
              from: "pending",
              to: "shipped",
              allowed: ["confirmed", "cancelled"],
            },
          },
        },
      }),
    );
    const onOpenChange = vi.fn();
    mount(
      <OrderStatusDialog
        open
        onOpenChange={onOpenChange}
        order={{ id: 9, order_no: "SO-202610-0001", status: "pending" }}
      />,
    );
    await settle();
    clickButton("确认流转");
    await settle();

    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("允许：已确认 / 已取消");
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("终态没有可流转目标：确认按钮禁用并说明", async () => {
    mount(
      <OrderStatusDialog
        open
        onOpenChange={() => {}}
        order={{ id: 9, order_no: "SO-202610-0001", status: "completed" }}
      />,
    );
    await settle();
    expect(document.body.textContent).toContain("终态");
    const confirm = Array.from(document.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").trim() === "确认流转",
    ) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
  });
});
