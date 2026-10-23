/**
 * 批量报价流程固定回归（用户口径：选客户 → 选询盘 → 填成本 → 生成报价单）。
 *
 * 用 React 组件 + mock API 跑真实交互：
 *  - 不再依赖手动点浏览器；
 *  - 批次请求必须带 customer_id / inquiry_id / items；
 *  - 成本未填时不得发 batch 请求。
 *
 * ⚠️ 稳定性要点（2026-10-18 排查记录）：
 * 本文件曾整轮**挂起**（node worker 持续占 CPU、无任何用例输出）。根因不是 mock
 * 路径，而是 mock 的 hook **每次渲染都返回新的对象字面量**：
 *     useProductFormulas: () => ({ data: { … } })
 * 组件里 `useEffect(..., [formulas.data])` 会因此每次重渲染都重跑，并 `setNumeric`/
 * `setVariants` 写入**新对象身份**的 state ⇒ 重渲染 ⇒ 新 `formulas.data` ⇒ 再跑
 * effect……无限更新循环。修法：把 mock 数据用 `vi.hoisted` 提升为**模块级稳定引用**
 * （与 `quote-order-records.test.tsx` 的写法一致），保证 `data` 只变一次（setState 收敛）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { BatchQuoteView } from "../batch-quote-view";

const mocks = vi.hoisted(() => {
  // 稳定引用：不要在 hook mock 里内联对象字面量（见文件头说明）。
  const PRODUCTS = {
    products: [{ key: "field_fence", name: "牛栏网", name_en: "Field Fence" }],
    total: 1,
  };
  const FORMULAS = {
    product_key: "field_fence",
    name: "牛栏网",
    numeric_inputs: [],
    space: { variants: [] },
    cost: { field: "raw_price", unit: "CNY/kg", basis: "pretax", note: "" },
    piece_inputs: [],
    columns: [],
  };
  const FX = { rate: 7.1 };
  // 组件启动时会额外拉企业税档与产品税率；缺任一个，生成会被业务校验拦住。
  const TAX_ARCHIVES = [
    {
      id: 1,
      name: "默认",
      code: "TAX-1",
      status: "active",
      tax_values: { output_vat_rate: 0, misc_fee_rate: 0.03 },
    },
  ];
  const PRODUCT_TAX_RATES = [
    {
      id: 1,
      product_key: "field_fence",
      input_vat_rate: 0.1,
      rebate_rate: 0.13,
      status: "active",
    },
  ];
  return {
    get: vi.fn(),
    post: vi.fn(),
    delete: vi.fn(),
    toastSuccess: vi.fn(),
    toastError: vi.fn(),
    PRODUCTS,
    FORMULAS,
    FX,
    TAX_ARCHIVES,
    PRODUCT_TAX_RATES,
  };
});

vi.mock("@/lib/api/client", () => {
  const client = { get: mocks.get, post: mocks.post, delete: mocks.delete };
  return { default: client, apiClient: client };
});

vi.mock("../../hooks/use-export-quote-import", () => ({
  useExportProducts: () => ({ data: mocks.PRODUCTS, isLoading: false }),
}));

vi.mock("../../hooks/use-export-quote-calc", () => ({
  useProductFormulas: () => ({ data: mocks.FORMULAS, isLoading: false }),
}));

vi.mock("@/lib/fx/use-latest-fx", () => ({
  useLatestFxRate: () => ({ data: mocks.FX }),
}));

// 这里不验证引擎表格，只验证流程；真实 buildLineItem 已在其它测试覆盖。
vi.mock("../../lib/line-to-item", () => ({
  buildLineItem: () => ({
    item: {
      product_name: "牛栏网",
      qty: 1,
      qty_unit: "ROLLS",
      unit_price: 10,
      line_amount: 10,
      spec_snapshot: {},
      sort_order: 0,
      cost_override: 9.1,
    },
  }),
}));

// 隔离 sonner（避免真实 toast 的副作用；并便于断言业务校验提示）。
vi.mock("sonner", () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
  Toaster: () => null,
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let qc: QueryClient | null = null;

function mount(element: ReactNode) {
  qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <QueryClientProvider client={qc!}>{element}</QueryClientProvider>,
    );
  });
}

function unmount() {
  if (root) act(() => root!.unmount());
  container?.remove();
  qc?.clear();
  root = null;
  container = null;
  qc = null;
}

async function waitFor(check: () => boolean, timeout = 5000, label = "条件") {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) {
      throw new Error(
        `等待超时：${label}（当前页面文本：${
          document.body.textContent?.slice(0, 500) ?? ""
        }）`,
      );
    }
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
  }
}

/** 勾选某个 label 文案里的复选框（客户/询盘都用它，避免依赖 DOM 顺序）。 */
function clickCheckboxIn(labelText: string) {
  const label = [...document.querySelectorAll("label")].find((l) =>
    l.textContent?.includes(labelText),
  );
  const box = label?.querySelector<HTMLInputElement>('input[type="checkbox"]');
  if (!box) throw new Error(`没找到「${labelText}」对应的复选框`);
  act(() => box.click());
}

function setInput(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function costInput(): HTMLInputElement {
  const el = document.querySelector<HTMLInputElement>(
    'input[placeholder="必填；参考历史报价后手填"]',
  );
  if (!el) throw new Error("没找到成本输入框");
  return el;
}

function generateButton(): HTMLButtonElement {
  const btn = [...document.querySelectorAll("button")].find((b) =>
    b.textContent?.includes("生成报价单"),
  );
  if (!btn) throw new Error("没找到「生成报价单」按钮");
  return btn;
}

/** P0-B1/Q10：点「生成报价单」只开确认弹窗，真正落库要点弹窗里的「确认生成」。 */
function confirmGenerateButton(): HTMLButtonElement {
  const btn = [...document.querySelectorAll("button")].find(
    (b) => (b.textContent ?? "").trim() === "确认生成",
  );
  if (!btn) throw new Error("没找到「确认生成」按钮");
  return btn;
}

/** 走到「已勾选 1 个询盘、成本已填」这一步（不含点击生成）。 */
async function pickCustomerAndInquiry() {
  await waitFor(
    () => document.body.textContent!.includes("测试客户"),
    undefined,
    "客户列表加载",
  );
  clickCheckboxIn("测试客户");

  await waitFor(
    () => document.body.textContent!.includes("INQ-US-TEST-1"),
    undefined,
    "询盘列表加载",
  );
  clickCheckboxIn("INQ-US-TEST-1");

  await waitFor(
    () => document.body.textContent!.includes("已选 1 个询盘"),
    undefined,
    "已选询盘计数",
  );
}

describe("批量报价流程", () => {
  beforeEach(() => {
    mocks.get.mockImplementation(async (url: string) => {
      if (url === "/customers")
        return {
          data: {
            items: [{ id: 1, company_name: "测试客户", country: "US" }],
          },
        };
      if (url === "/customers/1/inquiries")
        return {
          data: {
            items: [
              {
                id: 10,
                inquiry_no: "INQ-US-TEST-1",
                product_name_raw: "牛栏网",
                status: "unquoted",
              },
            ],
          },
        };
      if (url === "/export-quote/products")
        return {
          data: {
            products: [{ key: "field_fence", name: "牛栏网" }],
            total: 1,
          },
        };
      if (url === "/tax-archives")
        return { data: { items: mocks.TAX_ARCHIVES } };
      if (url === "/product-tax-rates")
        return { data: { items: mocks.PRODUCT_TAX_RATES } };
      throw new Error(`unexpected GET ${url}`);
    });
    mocks.post.mockImplementation(async (url: string) => {
      if (url === "/export-quote/calculate")
        return { data: { meta: {}, customer: {}, customer_en: {} } };
      if (url === "/quotes/batch")
        return {
          data: {
            created: [
              {
                inquiry_id: 10,
                customer_id: "1",
                quote_id: 99,
                quote_no: "QUO-US-TEST-1",
              },
            ],
            failed: [],
            total: 1,
          },
        };
      throw new Error(`unexpected POST ${url}`);
    });
    mocks.delete.mockResolvedValue({ data: {} });
  });

  afterEach(() => {
    unmount();
    vi.clearAllMocks();
  });

  it("选客户/询盘 + 填成本后生成一张报价单", async () => {
    mount(<BatchQuoteView />);
    await pickCustomerAndInquiry();

    act(() => setInput(costInput(), "9.1"));

    // 税档是组件启动时的并行查询；点生成前确认它们已进入请求链路。
    await waitFor(
      () =>
        mocks.get.mock.calls.some((c) => c[0] === "/tax-archives") &&
        mocks.get.mock.calls.some((c) => c[0] === "/product-tax-rates"),
      undefined,
      "税档查询已发出",
    );

    act(() => generateButton().click());

    // P0-B1/Q10：未确认前不得落库（也不应发起算价循环）
    expect(mocks.post.mock.calls.some((c) => c[0] === "/quotes/batch")).toBe(
      false,
    );
    expect(document.body.textContent).toContain("批量生成报价单？");

    act(() => confirmGenerateButton().click());

    await waitFor(
      () => mocks.post.mock.calls.some((c) => c[0] === "/quotes/batch"),
      undefined,
      "POST /quotes/batch",
    );

    const batchCall = mocks.post.mock.calls.find(
      (c) => c[0] === "/quotes/batch",
    )!;
    const body = batchCall[1] as {
      groups: {
        customer_id: string;
        inquiry_id: number;
        items: unknown[];
      }[];
    };
    expect(body.groups).toHaveLength(1);
    expect(body.groups[0]!.customer_id).toBe("1");
    expect(body.groups[0]!.inquiry_id).toBe(10);
    expect(body.groups[0]!.items).toHaveLength(1);

    // 税档口径确实被带进 calculate 请求（不是只存在于组件 state 里）。
    const calcCall = mocks.post.mock.calls.find(
      (c) => c[0] === "/export-quote/calculate",
    )!;
    const calcBody = calcCall[1] as {
      policy?: Record<string, number>;
    };
    expect(calcBody.policy).toMatchObject({
      input_vat_rate: 0.1,
      rebate_rate: 0.13,
      output_vat_rate: 0,
      misc_fee_rate: 0.03,
    });

    // 成功后渲染出报价单号。
    await waitFor(
      () => document.body.textContent!.includes("QUO-US-TEST-1"),
      undefined,
      "结果行渲染",
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith("已生成 1 张报价单");
  });

  it("成本未填时不得发 POST /quotes/batch", async () => {
    mount(<BatchQuoteView />);
    await pickCustomerAndInquiry();

    act(() => generateButton().click());
    act(() => confirmGenerateButton().click());

    await waitFor(
      () => mocks.toastError.mock.calls.length > 0,
      undefined,
      "成本校验提示",
    );
    const message = String(mocks.toastError.mock.calls[0]![0] ?? "");
    expect(message).toContain("成本");

    expect(mocks.post.mock.calls.some((c) => c[0] === "/quotes/batch")).toBe(
      false,
    );
    expect(
      mocks.post.mock.calls.some((c) => c[0] === "/export-quote/calculate"),
    ).toBe(false);
  });

  it("确认后只生成一批：pending 连点不重复调用；成功后清空勾选", async () => {
    // /quotes/batch 挂起，用于验证 pending 期间重复点只发一次
    let releaseBatch: (value: unknown) => void = () => {};
    const batchGate = new Promise((resolve) => {
      releaseBatch = resolve;
    });
    mocks.post.mockImplementation(async (url: string) => {
      if (url === "/export-quote/calculate")
        return { data: { meta: {}, customer: {}, customer_en: {} } };
      if (url === "/quotes/batch") return batchGate;
      throw new Error(`unexpected POST ${url}`);
    });

    mount(<BatchQuoteView />);
    await pickCustomerAndInquiry();
    act(() => setInput(costInput(), "9.1"));

    await waitFor(
      () =>
        mocks.get.mock.calls.some((c) => c[0] === "/tax-archives") &&
        mocks.get.mock.calls.some((c) => c[0] === "/product-tax-rates"),
      undefined,
      "税档查询已发出",
    );

    act(() => generateButton().click());
    await waitFor(
      () => (document.body.textContent ?? "").includes("确认生成"),
      undefined,
      "确认弹窗",
    );

    // 同一个 act 内连点两次：第二次必须被 ref 挡住（不重复建单）
    act(() => {
      confirmGenerateButton().click();
      confirmGenerateButton().click();
    });

    await waitFor(
      () => mocks.post.mock.calls.some((c) => c[0] === "/quotes/batch"),
      undefined,
      "POST /quotes/batch",
    );
    expect(
      mocks.post.mock.calls.filter((c) => c[0] === "/quotes/batch"),
    ).toHaveLength(1);
    expect(
      mocks.post.mock.calls.filter((c) => c[0] === "/export-quote/calculate"),
    ).toHaveLength(1);
    // pending：弹窗按钮变成「提交中…」
    expect(document.body.textContent).toContain("提交中…");

    await act(async () => {
      releaseBatch({
        data: {
          created: [
            {
              inquiry_id: 10,
              customer_id: "1",
              quote_id: 99,
              quote_no: "QUO-US-TEST-1",
            },
          ],
          failed: [],
          total: 1,
        },
      });
      await Promise.resolve();
    });

    await waitFor(
      () => document.body.textContent!.includes("QUO-US-TEST-1"),
      undefined,
      "结果行渲染",
    );
    // 成功后勾选被清空，避免"再点一次生成一批重复报价单"
    expect(document.body.textContent).toContain("已选 0 个询盘");
  });
});
