/**
 * 出货工位（/shipments）—— P0-B2/S2：三个写操作（建单/保存/推进）的失败反馈 + pending 防重。
 *
 * 旧行为：三个 mutation 全无 onError —— 失败零反馈（用户只看到按钮点了没反应）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
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
  useOrderOptions: () => ({
    data: [
      {
        id: 1,
        order_no: "ORD-1",
        customer_name: "客户A",
        currency: "USD",
        total_amount: 100,
      },
    ],
  }),
}));
vi.mock("sonner", () => ({
  toast: { success: mocks.toastSuccess, error: vi.fn(), info: vi.fn() },
}));

import ShipmentsPage from "../page";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const ROW = {
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

function selectOrder(value: string) {
  const el = document.querySelectorAll<HTMLSelectElement>("select")[0]!;
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
  // 编辑弹窗打开时按 id 查详情（GET /shipments/{id}）；列表仍是分页接口。
  mocks.get.mockImplementation(async (url: string) => {
    if (String(url) === "/shipments/5") return { data: ROW };
    if (String(url) === "/shipments") {
      return { data: { items: [ROW], total: 1 } };
    }
    return { data: { items: [], total: 0 } };
  });
});

afterEach(() => {
  unmount();
  vi.restoreAllMocks();
});

describe("出货工位 · 失败反馈与防重", () => {
  it("建单失败 → 页内显示原因；pending 期间不重复建单", async () => {
    mocks.post.mockRejectedValue(
      Object.assign(new Error("Conflict"), {
        response: {
          status: 409,
          data: {
            detail: {
              error: "conflict",
              code: "ORDER_NOT_SHIPPABLE",
              message: "该订单已有进行中的出货单",
            },
          },
        },
      }),
    );
    mount();
    await waitFor(
      () => (document.body.textContent ?? "").includes(ROW.shipment_no),
      undefined,
      "出货列表加载",
    );
    await act(async () => settle(1));
    selectOrder("1");
    await settle(2);
    await click(findButton("建出货单"));
    await settle();

    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("建单失败");
    expect(alert?.textContent).toContain("该订单已有进行中的出货单");
    expect(mocks.post).toHaveBeenCalledTimes(1);

    // pending 防重
    mocks.post.mockImplementation(() => new Promise(() => {}));
    await click(findButton("建出货单"));
    await settle();
    expect(mocks.post).toHaveBeenCalledTimes(2);
    const pending = findButton("建单中…");
    expect(pending.disabled).toBe(true);
    await click(pending);
    expect(mocks.post).toHaveBeenCalledTimes(2);
  });

  it("状态推进失败 → 页内显示原因", async () => {
    mocks.patch.mockRejectedValue(
      Object.assign(new Error("Unprocessable"), {
        response: {
          status: 422,
          data: {
            detail: {
              error: "validation",
              code: "BL_NO_REQUIRED",
              message: "推进到在途前必须填写提单号",
            },
          },
        },
      }),
    );
    mount();
    await waitFor(
      () => (document.body.textContent ?? "").includes("推进到「在途」"),
      undefined,
      "推进按钮",
    );
    await click(findButton("推进到「在途」"));
    await settle();

    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("状态推进失败");
    expect(alert?.textContent).toContain("推进到在途前必须填写提单号");
  });

  it("编辑保存失败 → 表单内显示原因（表单内容保留）", async () => {
    mocks.patch.mockRejectedValue(
      Object.assign(new Error("Forbidden"), {
        response: {
          status: 403,
          data: {
            detail: {
              error: "forbidden",
              code: "TEAM_ADMIN_REQUIRED",
              message: "仅团队管理员可修改出货信息",
            },
          },
        },
      }),
    );
    mount();
    await waitFor(
      () => (document.body.textContent ?? "").includes(ROW.shipment_no),
      undefined,
      "出货列表加载",
    );
    await click(findButton("编辑"));
    await settle();
    expect(document.body.textContent).toContain("出货信息 · SH-202610-0001");
    // 表单来自详情接口；等它回填后再点保存
    await waitFor(
      () =>
        document.querySelector('input[placeholder="货代给的 B/L No."]') !== null,
      undefined,
      "详情回填",
    );

    await click(findButton("保存"));
    await settle();

    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("保存失败");
    expect(alert?.textContent).toContain("仅团队管理员可修改出货信息");
    // 表单仍在（没有因为失败被清空/关闭）
    expect(document.body.textContent).toContain("出货信息 · SH-202610-0001");
  });
});
