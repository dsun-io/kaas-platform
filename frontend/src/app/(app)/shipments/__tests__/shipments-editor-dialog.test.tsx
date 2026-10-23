/**
 * 出货编辑弹窗（U-P0B6/X5）。
 *
 * 旧实现在列表下方渲染「出货信息」编辑区，且对象来自 `rows.find(selectedId)` ——
 * 改筛选/推进后该行从 rows 消失，编辑区连同未保存输入一起消失（数据丢失）。
 * 现在：Dialog + 打开时的行快照；筛选变化不影响编辑现场。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  patch: vi.fn(),
  post: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@/lib/api/client", () => {
  const client = {
    get: mocks.get,
    post: mocks.post,
    patch: mocks.patch,
    delete: vi.fn(),
  };
  return { default: client, apiClient: client };
});
vi.mock("@/lib/events/use-page-view", () => ({ usePageView: () => {} }));
vi.mock("@/lib/workstation/use-upstream", () => ({
  useOrderOptions: () => ({ data: [] }),
}));
vi.mock("sonner", () => ({
  toast: { success: mocks.toastSuccess, error: vi.fn(), info: vi.fn() },
}));

import ShipmentsPage from "../page";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const ROW_BOOKING = {
  id: 5,
  shipment_no: "SH-202610-0001",
  order_id: 1,
  customer_name: "客户A",
  consignee: null,
  cargo_desc: null,
  bl_no: null,
  bl_type: null,
  pol_name: null,
  pod_name: null,
  vessel: null,
  voyage: null,
  container_no: null,
  etd: null,
  eta: null,
  status: "booking",
};
const ROW_TRANSIT = {
  ...ROW_BOOKING,
  id: 6,
  shipment_no: "SH-202610-0002",
  status: "in_transit",
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let client: QueryClient | null = null;

async function settle(times = 8) {
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
        `等待超时：${label}（当前文本：${document.body.textContent?.slice(0, 400) ?? ""}）`,
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
        <ShipmentsPage />
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

function findExactButton(text: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll("button")).find(
    (b) => (b.textContent ?? "").trim() === text,
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

/** 出货列表的「全部状态」筛选（页面第 2 个 select）。 */
function setStatusFilter(value: string) {
  const selects = document.querySelectorAll<HTMLSelectElement>("select");
  const el = selects[1]!;
  const setter = Object.getOwnPropertyDescriptor(
    HTMLSelectElement.prototype,
    "value",
  )?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockImplementation(async (url: string, config?: unknown) => {
    // 编辑弹窗按 id 查详情（GET /shipments/{id}）—— 弹窗内容来自它，不是列表行快照
    const detailMatch = /^\/shipments\/(\d+)$/.exec(url);
    if (detailMatch) {
      const row = [ROW_BOOKING, ROW_TRANSIT].find(
        (r) => r.id === Number(detailMatch[1]),
      );
      return { data: row ?? ROW_BOOKING };
    }
    if (url !== "/shipments") return { data: { items: [], total: 0 } };
    const params = (config as { params?: { status?: string } })?.params;
    const rows =
      params?.status === "in_transit"
        ? [ROW_TRANSIT]
        : [ROW_BOOKING, ROW_TRANSIT];
    return { data: { items: rows, total: rows.length } };
  });
});

afterEach(() => {
  unmount();
  vi.restoreAllMocks();
});

describe("出货工位 · 编辑弹窗", () => {
  it("筛选变化后编辑现场仍在，保存用打开时的行 id；成功后关闭", async () => {
    mocks.patch.mockResolvedValue({ data: { ...ROW_BOOKING, bl_no: "BL-1" } });
    mount();
    await waitFor(
      () => (document.body.textContent ?? "").includes(ROW_BOOKING.shipment_no),
      undefined,
      "列表加载",
    );

    const editorButton = Array.from(document.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").trim() === "编辑",
    )!;
    await click(editorButton);
    await waitFor(
      () => document.querySelector('[role="dialog"]') !== null,
      undefined,
      "编辑弹窗打开",
    );
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain(
      "出货信息 · SH-202610-0001",
    );

    // 改筛选：booking 行从列表消失（旧实现会因此丢掉编辑现场）
    setStatusFilter("in_transit");
    await waitFor(
      () =>
        !Array.from(document.querySelectorAll("tbody tr")).some((tr) =>
          (tr.textContent ?? "").includes(ROW_BOOKING.shipment_no),
        ),
      undefined,
      "列表换成 in_transit",
    );
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain(
      "出货信息 · SH-202610-0001",
    );

    // 等详情人回填后再保存（弹窗表单来自详情接口）
    await waitFor(
      () =>
        document.querySelector('input[placeholder="货代给的 B/L No."]') !== null,
      undefined,
      "详情回填",
    );
    await click(findExactButton("保存"));
    await waitFor(() => mocks.patch.mock.calls.length > 0, undefined, "PATCH");
    expect(mocks.patch.mock.calls[0]![0]).toBe("/shipments/5");
    expect(mocks.toastSuccess).toHaveBeenCalledWith("已保存");
    await waitFor(
      () => document.querySelector('[role="dialog"]') === null,
      undefined,
      "成功后关闭",
    );
  });

  it("关闭后焦点回到「编辑」按钮；失败留在弹窗可重试", async () => {
    mocks.patch.mockRejectedValue(
      Object.assign(new Error("Conflict"), {
        response: {
          status: 409,
          data: {
            detail: {
              error: "conflict",
              code: "SHIPMENT_LOCKED",
              message: "该出货单已交付，不能再改提单号",
            },
          },
        },
      }),
    );
    mount();
    await waitFor(
      () => (document.body.textContent ?? "").includes(ROW_BOOKING.shipment_no),
      undefined,
      "列表加载",
    );

    const opener = Array.from(document.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").trim() === "编辑",
    )!;
    await click(opener);
    await waitFor(
      () => document.querySelector('[role="dialog"]') !== null,
      undefined,
      "弹窗打开",
    );

    await waitFor(
      () =>
        document.querySelector('input[placeholder="货代给的 B/L No."]') !== null,
      undefined,
      "详情回填",
    );
    await click(findExactButton("保存"));
    await settle();
    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("保存失败");
    expect(alert?.textContent).toContain("该出货单已交付，不能再改提单号");
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();

    // 再点保存 = 重试（第 2 次 PATCH）
    await click(findExactButton("保存"));
    expect(mocks.patch).toHaveBeenCalledTimes(2);

    // 关闭 → 焦点归还触发按钮
    await click(findExactButton("关闭"));
    await waitFor(
      () => document.querySelector('[role="dialog"]') === null,
      undefined,
      "关闭弹窗",
    );
    expect(document.activeElement).toBe(opener);
  });
});
