/**
 * X8（U-P1D 审计）：定价矩阵「选中行 → 弹窗」编辑流。
 *
 * 钉死的最小闭环：
 *  1. 点选矩阵行 → 出现选中行操作条（配置成本 / 改价 / 取消选择）；
 *  2. 未配置行 → 弹窗「配置成本」→ POST /pricing-data（只提交 amount/unit）；
 *  3. 已配置行 → 弹窗「修改定价」→ PATCH /pricing-data/{item_id}；
 *  4. 失败留在弹窗里显示原因（可重试），不关窗、不静默。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import apiClient from "@/lib/api/client";

vi.mock("@/lib/api/client", () => {
  const client = {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  };
  return { default: client, apiClient: client };
});

import { PricingDataManager } from "../pricing-data-manager";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type GetResp = Awaited<ReturnType<typeof apiClient.get>>;
const ok = (data: unknown) => ({ data }) as unknown as GetResp;

const PRODUCT = { key: "field_fence", name: "牛栏网" };

/** 一行已配置（item_id=1）+ 一行未配置（item_id=null，用产品兜底）。 */
const MATRIX = {
  product_key: "field_fence",
  product_name: "牛栏网",
  cost_unit: "CNY/kg",
  dims: [{ field: "wire", label: "边丝径", unit: "mm" }],
  rows: [
    {
      key: "wire:2.0",
      values: { wire: "2.0" },
      labels: ["边丝径 2.0"],
      amount: 4.5,
      unit: "kg",
      configured: true,
      item_id: 1,
      effective_from: "2026-10-01T00:00:00Z",
      source: "manual",
      notes: null,
    },
    {
      key: "wire:3.0",
      values: { wire: "3.0" },
      labels: ["边丝径 3.0"],
      amount: null,
      unit: "kg",
      configured: false,
      item_id: null,
      effective_from: null,
      source: "product_default",
      notes: null,
    },
  ],
  customers: [],
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let client: QueryClient | null = null;

async function settle(times = 5) {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mount() {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      <QueryClientProvider client={client!}>
        <PricingDataManager />
      </QueryClientProvider>,
    ),
  );
  await settle();
}

function baseGet(path: string): GetResp | null {
  if (path === "/auth/me") return ok({ account_type: "customer" });
  if (path === "/export-quote/products")
    return ok({ products: [PRODUCT], total: 1 });
  if (path === "/pricing-data") return ok(MATRIX);
  return null;
}

async function clickButton(text: string) {
  const button = Array.from(document.querySelectorAll("button")).find(
    (b) => (b.textContent ?? "").trim() === text,
  );
  if (!button) throw new Error("没找到按钮「" + text + "」");
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await settle();
}

async function clickRow(index: number) {
  const row = container!.querySelectorAll("tbody tr")[index];
  if (!row) throw new Error("没找到第 " + String(index) + " 行");
  await act(async () => {
    row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await settle();
}

function setInput(selector: string, value: string) {
  const el = document.querySelector<HTMLInputElement>(selector);
  if (!el) throw new Error("没找到 " + selector);
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(apiClient.get).mockImplementation(async (url: string) => {
    const hit = baseGet(String(url));
    if (hit) return hit;
    return ok({});
  });
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  client?.clear();
  document.body.innerHTML = "";
  root = null;
  container = null;
  client = null;
});

describe("定价矩阵 X8：选中行 + 弹窗改价", () => {
  it("未配置行 → 选中后出现操作条 → 弹窗配置成本 → POST 只提交 amount/unit", async () => {
    vi.mocked(apiClient.post).mockResolvedValue(ok({ id: 9 }) as never);

    await mount();
    // 未配置行显示「未配置」，不再是每格一个输入框
    expect(container!.textContent).toContain("未配置");
    expect(container!.querySelectorAll("tbody input").length).toBe(0);

    await clickRow(1);
    expect(container!.textContent).toContain("已选中");
    expect(container!.textContent).toContain("边丝径 3.0");

    await clickButton("配置成本");
    // 配置模式只收金额/单位
    expect(document.querySelector("#pricing-amount")).not.toBeNull();
    expect(document.querySelector("#pricing-unit")).not.toBeNull();
    expect(document.querySelector("#pricing-effective")).toBeNull();
    expect(document.querySelector("#pricing-status")).toBeNull();

    setInput("#pricing-amount", "6.8");
    await clickButton("保存成本");

    expect(vi.mocked(apiClient.post)).toHaveBeenCalledWith("/pricing-data", {
      product_key: "field_fence",
      values: { wire: "3.0" },
      amount: 6.8,
      unit: "kg",
    });
    // 成功后关窗 + 顶部提示
    expect(document.querySelector("#pricing-amount")).toBeNull();
    expect(container!.textContent).toContain("已配置成本");
  });

  it("已配置行 → 弹窗改价失败留在弹窗内（可重试），成功后关窗", async () => {
    vi.mocked(apiClient.patch)
      .mockRejectedValueOnce({
        response: { status: 422, data: { detail: "unit 取值不合法" } },
      })
      .mockResolvedValueOnce(ok({ id: 1 }) as never);

    await mount();
    await clickRow(0);
    expect(container!.textContent).toContain("当前成本 4.5 kg");

    await clickButton("改价");
    expect(document.querySelector("#pricing-amount")).not.toBeNull();
    setInput("#pricing-amount", "5.5");
    await clickButton("保存修改");

    // 422 原因留在弹窗里（role=alert），弹窗没关，可以改了再存
    expect(document.querySelector("#pricing-amount")).not.toBeNull();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "unit 取值不合法",
    );

    await clickButton("保存修改");
    expect(document.querySelector("#pricing-amount")).toBeNull();
    expect(container!.textContent).toContain("已改价");
    expect(vi.mocked(apiClient.patch)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(apiClient.patch).mock.calls[1]?.[0]).toBe(
      "/pricing-data/1",
    );
  });

  it("点选另一行会切换选中；取消选择后操作条消失", async () => {
    await mount();
    await clickRow(0);
    expect(container!.textContent).toContain("边丝径 2.0");
    await clickRow(1);
    expect(container!.textContent).toContain("边丝径 3.0");
    expect(container!.textContent).toContain("尚未配置（用产品兜底）");
    await clickButton("取消选择");
    expect(container!.textContent).not.toContain("已选中");
  });

  it("恢复兜底需二次确认：取消不调用 DELETE，确认后才停用", async () => {
    vi.mocked(apiClient.delete).mockResolvedValue(ok({}) as never);

    await mount();
    await clickRow(0); // 已配置行
    await clickButton("恢复兜底");

    // 弹窗说明后果：恢复后按产品兜底成本计算、自定义成本停用
    expect(document.body.textContent).toContain("的产品兜底成本？");
    expect(document.body.textContent).toContain("兜底成本计算");

    await clickButton("取消");
    expect(vi.mocked(apiClient.delete)).not.toHaveBeenCalled();

    await clickButton("恢复兜底");
    await clickButton("确认恢复兜底");
    await settle();

    expect(vi.mocked(apiClient.delete)).toHaveBeenCalledWith("/pricing-data/1");
    // 成功后关窗 + 顶部提示
    expect(container!.textContent).toContain("已停用自定义成本");
  });

  it("恢复兜底提交中：按钮进 pending、取消被禁用（不能假装已取消）", async () => {
    vi.mocked(apiClient.delete).mockImplementation(() => new Promise(() => {}));

    await mount();
    await clickRow(0);
    await clickButton("恢复兜底");
    await clickButton("确认恢复兜底");
    await settle(2);

    const pendingBtn = Array.from(document.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").trim() === "提交中…",
    ) as HTMLButtonElement | undefined;
    expect(pendingBtn).toBeTruthy();
    const cancelBtn = Array.from(document.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").trim() === "取消",
    ) as HTMLButtonElement | undefined;
    expect(cancelBtn?.disabled).toBe(true);
    // 仍停在确认弹窗上（不是"关掉弹窗但其实还在删"）
    expect(document.body.textContent).toContain("兜底成本计算");
  });

  it("恢复兜底失败留在弹窗（可重试），成功后关窗", async () => {
    vi.mocked(apiClient.delete)
      .mockRejectedValueOnce({
        response: { status: 409, data: { detail: "该成本记录正在被引用" } },
      })
      .mockResolvedValueOnce(ok({}) as never);

    await mount();
    await clickRow(0);
    await clickButton("恢复兜底");
    await clickButton("确认恢复兜底");
    await settle();

    // 失败：原因留在弹窗里，弹窗没关，可再点
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "该成本记录正在被引用",
    );
    expect(
      Array.from(document.querySelectorAll("button")).some(
        (b) => (b.textContent ?? "").trim() === "确认恢复兜底",
      ),
    ).toBe(true);

    await clickButton("确认恢复兜底");
    await settle();
    expect(vi.mocked(apiClient.delete)).toHaveBeenCalledTimes(2);
    expect(container!.textContent).toContain("已停用自定义成本");
  });
});
