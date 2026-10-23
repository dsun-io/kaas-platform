/**
 * 出货编辑弹窗 · 真·detail 查询（GET /shipments/{id}）。
 *
 * 旧实现只用「打开那一刻的列表行快照」：别人改了提单号/船期，弹窗还显示旧值，
 * 保存会覆盖别人的修改；列表刷新后编辑现场与数据也可能不一致。
 * 现在：弹窗打开即按 id 查详情并作为表单初值；详情失败在弹窗内可重试（或显式
 * 退回列表快照）；保存成功后列表与详情一起失效。筛选变化不丢编辑现场。
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

/** 详情接口独有的值：列表行里 bl_no/vessel 都是 null。 */
const DETAIL_ROW = {
  ...ROW_BOOKING,
  bl_no: "BL-DETAIL-9",
  vessel: "COSCO UNIVERSE",
  voyage: "088E",
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let client: QueryClient | null = null;
/** 下一次详情请求注入失败（模拟网关抖动/后端 5xx）。 */
let failNextDetail = false;
const detailHits: string[] = [];

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

function setStatusFilter(value: string) {
  const select = document.querySelector(
    'select[aria-label="状态筛选"]',
  ) as HTMLSelectElement;
  const setter = Object.getOwnPropertyDescriptor(
    HTMLSelectElement.prototype,
    "value",
  )?.set;
  act(() => {
    setter?.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function blInput(): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>(
    'input[placeholder="货代给的 B/L No."]',
  );
}

function setBlNo(value: string) {
  const input = blInput();
  if (!input) throw new Error("没找到提单号输入框");
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function openEditor() {
  const button = Array.from(document.querySelectorAll("button")).find(
    (b) => (b.textContent ?? "").trim() === "编辑",
  )!;
  await click(button);
  await waitFor(
    () => document.querySelector('[role="dialog"]') !== null,
    undefined,
    "编辑弹窗打开",
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  failNextDetail = false;
  detailHits.length = 0;
  mocks.get.mockImplementation(async (url: string, config?: unknown) => {
    const path = String(url);
    const detailMatch = /^\/shipments\/(\d+)$/.exec(path);
    if (detailMatch) {
      detailHits.push(detailMatch[1]!);
      if (failNextDetail) {
        failNextDetail = false;
        throw Object.assign(new Error("Internal Server Error"), {
          response: {
            status: 500,
            data: { detail: { error: "internal", message: "详情服务异常" } },
          },
        });
      }
      return { data: DETAIL_ROW };
    }
    if (path === "/shipments") {
      const params = (config as { params?: { status?: string } })?.params;
      const rows =
        params?.status === "in_transit"
          ? [ROW_TRANSIT]
          : [ROW_BOOKING, ROW_TRANSIT];
      return { data: { items: rows, total: rows.length } };
    }
    if (path === "/orders") return { data: { items: [], total: 0 } };
    return { data: { items: [], total: 0 } };
  });
  mocks.patch.mockResolvedValue({
    data: { ...DETAIL_ROW, bl_no: "BL-SAVED" },
  });
});

afterEach(() => {
  unmount();
  vi.restoreAllMocks();
});

describe("出货编辑弹窗 · 详情查询", () => {
  it("打开即查 GET /shipments/{id}，表单初值来自详情（不是列表快照）", async () => {
    mount();
    await waitFor(
      () => (document.body.textContent ?? "").includes(ROW_BOOKING.shipment_no),
      undefined,
      "列表加载",
    );
    await openEditor();
    await waitFor(() => blInput() !== null, undefined, "详情回填");

    expect(detailHits).toEqual(["5"]);
    expect(blInput()!.value).toBe("BL-DETAIL-9");
    const text = document.querySelector('[role="dialog"]')!.textContent ?? "";
    expect(text).toContain("出货信息 · SH-202610-0001");
    expect(text).toContain("最新详情");
  });

  it("筛选变化（行消失 / 行仍在）都不丢编辑现场，输入不受列表刷新影响", async () => {
    mount();
    await waitFor(
      () => (document.body.textContent ?? "").includes(ROW_BOOKING.shipment_no),
      undefined,
      "列表加载",
    );
    await openEditor();
    await waitFor(() => blInput() !== null, undefined, "详情回填");
    setBlNo("BL-USER-EDIT");

    // 行消失：booking → in_transit（当前编辑的 booking 单从列表消失）
    setStatusFilter("in_transit");
    await waitFor(
      () =>
        !Array.from(document.querySelectorAll("tbody tr")).some((tr) =>
          (tr.textContent ?? "").includes(ROW_BOOKING.shipment_no),
        ),
      undefined,
      "列表切到 in_transit",
    );
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(blInput()!.value).toBe("BL-USER-EDIT");
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain(
      "出货信息 · SH-202610-0001",
    );

    // 行仍在：切回全部（booking 单重新出现在列表），弹窗仍保留未保存输入
    setStatusFilter("");
    await waitFor(
      () =>
        Array.from(document.querySelectorAll("tbody tr")).some((tr) =>
          (tr.textContent ?? "").includes(ROW_BOOKING.shipment_no),
        ),
      undefined,
      "列表切回全部",
    );
    expect(blInput()!.value).toBe("BL-USER-EDIT");
    // 详情已缓存，不会因为列表刷新重新初始化表单
    expect(detailHits).toEqual(["5"]);
  });

  it("详情失败：弹窗内显示原因并可重试；重试成功后回填", async () => {
    failNextDetail = true;
    mount();
    await waitFor(
      () => (document.body.textContent ?? "").includes(ROW_BOOKING.shipment_no),
      undefined,
      "列表加载",
    );
    await openEditor();
    await waitFor(
      () => document.querySelector('[role="dialog"] [role="alert"]') !== null,
      undefined,
      "详情失败提示",
    );
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("详情读取失败");
    expect(dialog.textContent).toContain("详情服务异常");
    expect(blInput()).toBeNull();
    expect(findExactButton("重试")).toBeTruthy();

    await click(findExactButton("重试"));
    await waitFor(() => blInput() !== null, undefined, "重试后回填");
    expect(blInput()!.value).toBe("BL-DETAIL-9");
    expect(detailHits).toEqual(["5", "5"]);
  });

  it("详情失败可显式退回列表快照继续编辑（不让接口抖动锁死业务）", async () => {
    failNextDetail = true;
    mount();
    await waitFor(
      () => (document.body.textContent ?? "").includes(ROW_BOOKING.shipment_no),
      undefined,
      "列表加载",
    );
    await openEditor();
    await waitFor(
      () => document.querySelector('[role="dialog"] [role="alert"]') !== null,
      undefined,
      "详情失败提示",
    );
    await click(findExactButton("用列表快照继续编辑"));
    await waitFor(() => blInput() !== null, undefined, "快照表单");
    // 列表行的 bl_no 是 null ⇒ 快照表单为空
    expect(blInput()!.value).toBe("");
  });

  it("保存成功：PATCH 该 id、关闭弹窗、并重新拉列表（详情/列表一起失效）", async () => {
    mount();
    await waitFor(
      () => (document.body.textContent ?? "").includes(ROW_BOOKING.shipment_no),
      undefined,
      "列表加载",
    );
    await openEditor();
    await waitFor(() => blInput() !== null, undefined, "详情回填");
    setBlNo("BL-SAVED");
    await settle();

    const listCallsBefore = mocks.get.mock.calls.filter(
      ([url]) => String(url) === "/shipments",
    ).length;

    await click(findExactButton("保存"));
    await waitFor(() => mocks.patch.mock.calls.length > 0, undefined, "PATCH");
    expect(mocks.patch.mock.calls[0]![0]).toBe("/shipments/5");
    expect(
      (mocks.patch.mock.calls[0]![1] as Record<string, unknown>).bl_no,
    ).toBe("BL-SAVED");
    expect(mocks.toastSuccess).toHaveBeenCalledWith("已保存");
    await waitFor(
      () => document.querySelector('[role="dialog"]') === null,
      undefined,
      "成功后关闭",
    );
    expect(
      mocks.get.mock.calls.filter(([url]) => String(url) === "/shipments")
        .length,
    ).toBeGreaterThan(listCallsBefore);
  });
});
