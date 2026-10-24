/**
 * 开单表单「完整成品预览」（2026-10-24，用户需求 1）。
 *
 * 钉住（这是用户明确要的行为，不能用样板占位糊弄）：
 * 1. 表单必填没填全时入口**禁用**，并如实列出缺哪几项；
 * 2. 打开对话框才发请求，调的是内核只读端点
 *    `POST /trade-docs/preview-render-data`（入参与开单同形状），
 *    iframe 里渲染的是**接口返回的真实货物/买方**，不是本地样板；
 * 3. 多选类型时对话框内可切换，每类单独请求（doc_type 逐个变化）；
 * 4. 接口失败显示明确错误，**不**退回样板占位冒充完整预览；
 * 5. 预览**不落库、不生成单据**：提交前绝不调用 `POST /trade-docs`。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  post: vi.fn(),
  get: vi.fn(),
}));

vi.mock("../../hooks/use-trade-docs", () => ({
  // 预览只调只读端点，绝不该走创建 mutation
  useCreateTradeDoc: () => ({ mutateAsync: mocks.create, isPending: false }),
}));

vi.mock("@/lib/api/client", () => ({
  default: {
    get: mocks.get,
    post: mocks.post,
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  apiClient: {
    get: mocks.get,
    post: mocks.post,
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

const ORDER = {
  id: 1,
  order_no: "SO-202610-0001",
  customer_name: "客户A",
  status: "confirmed",
  currency: "USD",
  total_amount: 12300,
  order_date: "2026-10-20",
  delivery_date: "2026-11-20",
  incoterm: "FOB Shanghai",
  payment_terms: "T/T 30% deposit, 70% before shipment",
  port_of_loading: "Shanghai",
  port_of_destination: "Hamburg",
  shipping_marks: "KAAS/ORDER1",
  country_of_origin: "China",
};

vi.mock("@/lib/workstation/use-upstream", () => ({
  useOrderOptions: () => ({ data: [ORDER] }),
  useQuoteOptions: () => ({ data: [] }),
  toCustomerIdPayload: (id: number | string) => id,
}));

// CustomerPicker 是重型远程选择器；这里只关心「已选客户」之后表单的行为
vi.mock("@/components/customer-picker", () => ({
  CustomerPicker: ({
    onChange,
  }: {
    onChange: (v: { id: string; name: string }) => void;
  }) => (
    <button
      type="button"
      data-testid="pick-customer"
      onClick={() => onChange({ id: "5", name: "客户A" })}
    >
      选择客户
    </button>
  ),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { DocCreateForm } from "../doc-create-form";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let client: QueryClient | null = null;

function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  root = createRoot(container);
  act(() =>
    root!.render(
      <QueryClientProvider client={client!}>
        <DocCreateForm />
      </QueryClientProvider>,
    ),
  );
}

async function settle(times = 8) {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function waitFor(check: () => boolean, label: string, timeout = 5000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) {
      throw new Error(
        `等待超时：${label}（当前文本：${document.body.textContent?.slice(0, 400) ?? ""}）`,
      );
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

function buttonByText(
  text: string,
  scope: ParentNode = document,
): HTMLButtonElement {
  const button = Array.from(scope.querySelectorAll("button")).find((b) =>
    (b.textContent ?? "").includes(text),
  );
  if (!button) throw new Error(`没找到按钮：${text}`);
  return button as HTMLButtonElement;
}

function click(node: Element | null | undefined, label: string) {
  if (!node) throw new Error(`没找到${label}`);
  act(() => {
    node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function setSelectValue(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLSelectElement.prototype,
    "value",
  )?.set;
  act(() => {
    setter?.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function setInputByLabel(labelText: string, value: string) {
  const label = Array.from(document.querySelectorAll("label")).find((l) =>
    (l.textContent ?? "").includes(labelText),
  );
  const input = label?.querySelector<HTMLInputElement>("input");
  if (!input) throw new Error(`没找到输入框「${labelText}」`);
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** 父对象选择器（三个 select 里唯一带「不关联（直接挂客户）」选项的那个） */
function sourceKindSelect(): HTMLSelectElement {
  const select = Array.from(document.querySelectorAll("select")).find((s) =>
    Array.from(s.options).some((o) => o.textContent?.includes("不关联")),
  );
  if (!select) throw new Error("没找到父对象选择器");
  return select as HTMLSelectElement;
}

function orderSelect(): HTMLSelectElement {
  const select = Array.from(document.querySelectorAll("select")).find((s) =>
    Array.from(s.options).some((o) => o.value === "1"),
  );
  if (!select) throw new Error("没找到订单选择器");
  return select as HTMLSelectElement;
}

/** 单证类型多选框（label 里带类型中文名 + checkbox） */
function toggleDocType(labelText: string) {
  const label = Array.from(document.querySelectorAll("label")).find((l) =>
    (l.textContent ?? "").includes(labelText),
  );
  const input = label?.querySelector<HTMLInputElement>(
    'input[type="checkbox"]',
  );
  if (!input) throw new Error(`没找到类型复选框「${labelText}」`);
  click(input, `类型复选框「${labelText}」`);
}

function dialog(): HTMLElement {
  const node = document.querySelector<HTMLElement>('[role="dialog"]');
  if (!node) throw new Error("对话框没出现");
  return node;
}

function previewFrame(): HTMLIFrameElement {
  const frame = dialog().querySelector<HTMLIFrameElement>("iframe");
  if (!frame) throw new Error("对话框里没有预览 iframe");
  return frame;
}

/** 接口返回的 data：用可辨认的「真实」行项/买方，便于断言不是本地样板。 */
function previewData(docType: string) {
  const itemName =
    docType === "pi" ? "牛栏网 · PI 真实行项" : "热镀锌勾花网 · CI 真实行项";
  return {
    seller: { company: "河北慷逊丝网有限公司", address: "Anping, Hebei" },
    buyer: { company: "联佳丝网", address: "Hamburg" },
    invoice_no: "CI-202610-0001",
    invoice_date: "2026-10-24",
    pi_no: "PI-202610-0001",
    pi_date: "2026-10-24",
    currency: "EUR",
    total_amount: 2850,
    payment_terms: "T/T 30% deposit",
    incoterm: "FOB Shanghai",
    port_of_loading: "Shanghai",
    port_of_destination: "Hamburg",
    items: [
      {
        product_name: itemName,
        specification: "1.5m x 30m",
        qty: 100,
        qty_unit: "Rolls",
        unit_price: 28.5,
        line_amount: 2850,
        hs_code: "7314410000",
      },
    ],
  };
}

function respondWithPreview(docType: string) {
  return {
    doc: {
      id: null,
      // 内核口径：新单预览的 doc_no = 按当前时刻算出的下一个编号（只读计算、不占用）
      doc_no: `${docType.toUpperCase()}-PREVIEW-20261024132237`,
      doc_type: docType,
      status: "draft",
      currency: "EUR",
      total_amount: 2850,
      created_at: "2026-10-24T05:22:37+00:00",
      issued_at: null,
    },
    data: previewData(docType),
    company_profile_configured: true,
  };
}

/** 打开「不关联（直接挂客户）」并选定客户 —— 最小可预览状态 */
async function readyMinimalForm() {
  click(
    document.querySelector('[data-testid="pick-customer"]'),
    "客户选择按钮",
  );
  await settle();
  setSelectValue(sourceKindSelect(), "none");
  await settle();
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.create.mockResolvedValue({ id: 1, doc_no: "CI-202610-0001" });
  mocks.post.mockImplementation(
    async (url: string, body: { doc_type?: string }) => {
      if (url !== "/trade-docs/preview-render-data") {
        throw new Error(`意外的 POST：${url}`);
      }
      return { data: respondWithPreview(String(body?.doc_type ?? "ci")) };
    },
  );
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  document.body.innerHTML = "";
  client?.clear();
  root = null;
  container = null;
  client = null;
});

describe("DocCreateForm · 开单前完整成品预览", () => {
  it("必填没填全时禁用入口，并列出缺项（业务客户 / 来源订单）", async () => {
    mount();
    await settle();

    const previewButton = buttonByText("完整预览");
    expect(previewButton.disabled).toBe(true);
    const text = document.body.textContent ?? "";
    expect(text).toContain("完整预览不可用");
    expect(text).toContain("业务客户");
    expect(text).toContain("来源订单");
    // 禁用状态下点不开、更不会发请求
    click(previewButton, "完整预览按钮");
    await settle();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("打开对话框才调 preview-render-data，iframe 渲染接口返回的真实行项；提交前不 POST /trade-docs", async () => {
    mount();
    await settle();
    await readyMinimalForm();
    setInputByLabel("币种", "EUR");
    await settle();

    // 没打开对话框之前一个预览请求都不发（不随表单渲染白跑）
    expect(mocks.post).not.toHaveBeenCalled();

    click(buttonByText("完整预览"), "完整预览按钮");
    await waitFor(
      () => document.querySelector('[role="dialog"] iframe') !== null,
      "完整预览对话框出现并完成取数",
    );

    expect(mocks.post).toHaveBeenCalledTimes(1);
    const [url, body] = mocks.post.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(url).toBe("/trade-docs/preview-render-data");
    expect(body).toMatchObject({
      doc_type: "ci",
      customer_id: "5",
      currency: "EUR",
      with_seal: true,
    });
    // 不关联上游时不该夹带来源 id
    expect(body.order_id).toBeUndefined();
    expect(body.quote_order_id).toBeUndefined();

    const html = previewFrame().getAttribute("srcdoc") ?? "";
    // 真实行项 / 真实买方来自接口返回，而不是本地样板数据
    expect(html).toContain("热镀锌勾花网 · CI 真实行项");
    expect(html).toContain("联佳丝网");
    // 反面断言：不再是 sample-data.json 的样板占位
    expect(html).not.toContain("[PRODUCT NAME 1]");

    // 预览绝不写库：没有创建 mutation、没有 POST /trade-docs
    expect(mocks.create).not.toHaveBeenCalled();
    const paths = mocks.post.mock.calls.map((call) => call[0]);
    expect(paths).not.toContain("/trade-docs");
  });

  it("多选类型时对话框内可切换，每类单独请求并各自渲染", async () => {
    mount();
    await settle();
    await readyMinimalForm();
    // 再勾一个类型：形式发票
    toggleDocType("形式发票");
    await settle();

    click(buttonByText("完整预览"), "完整预览按钮");
    await waitFor(
      () => document.querySelector('[role="dialog"] iframe') !== null,
      "完整预览对话框出现",
    );
    expect(previewFrame().getAttribute("srcdoc") ?? "").toContain(
      "热镀锌勾花网 · CI 真实行项",
    );

    // 对话框内切换到形式发票：发第二个请求（doc_type=pi），iframe 重新渲染
    const piButton = Array.from(dialog().querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").trim() === "形式发票",
    );
    click(piButton, "形式发票类型按钮");
    await waitFor(
      () =>
        (
          document
            .querySelector('[role="dialog"] iframe')
            ?.getAttribute("srcdoc") ?? ""
        ).includes("牛栏网 · PI 真实行项"),
      "切换到形式发票后 iframe 渲染 PI 数据",
    );

    const types = mocks.post.mock.calls.map(
      (call) => (call[1] as Record<string, unknown>).doc_type,
    );
    expect(types).toEqual(["ci", "pi"]);
    // 每类都是只读端点，绝不落库
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.post.mock.calls.map((call) => call[0])).not.toContain(
      "/trade-docs",
    );
  });

  it("取数期间显示 pending，可关闭（不发写请求）", async () => {
    const deferred: { resolve: (value: unknown) => void } = {
      resolve: () => {},
    };
    mocks.post.mockImplementation(
      () =>
        new Promise((resolve) => {
          deferred.resolve = resolve;
        }),
    );

    mount();
    await settle();
    await readyMinimalForm();
    click(buttonByText("完整预览"), "完整预览按钮");

    await waitFor(
      () =>
        (document.body.textContent ?? "").includes("正在按真实客户与上游装配"),
      "取数中提示出现",
    );
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(mocks.post).toHaveBeenCalledWith(
      "/trade-docs/preview-render-data",
      expect.objectContaining({ doc_type: "ci" }),
      expect.anything(),
    );

    // 关闭对话框（pending 中也可关）
    click(buttonByText("关闭", dialog()), "关闭按钮");
    await settle();
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    // 收尾：让被挂起的请求结束，避免泄漏到下一个用例
    deferred.resolve({ data: respondWithPreview("ci") });
    await settle();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("接口失败显示明确错误，不退回样板占位冒充完整预览", async () => {
    mocks.post.mockRejectedValue({
      isAxiosError: true,
      message: "Request failed with status code 500",
      response: {
        status: 500,
        data: {
          detail: {
            error: "internal_error",
            message: "装配失败：上游订单不存在",
          },
        },
      },
    });

    mount();
    await settle();
    await readyMinimalForm();
    click(buttonByText("完整预览"), "完整预览按钮");

    await waitFor(
      () => (document.body.textContent ?? "").includes("完整预览生成失败"),
      "错误提示出现",
    );
    const text = dialog().textContent ?? "";
    expect(text).toContain("装配失败：上游订单不存在");
    expect(text).toContain("预览只是读取，不会生成单据");
    // 失败时不能拿样板数据渲染 iframe 冒充"完整预览"
    expect(dialog().querySelector("iframe")).toBeNull();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("文档化错误码（404 CUSTOMER_NOT_FOUND）显示中文原因，不暴露英文 axios 文案", async () => {
    mocks.post.mockRejectedValue({
      isAxiosError: true,
      message: "Request failed with status code 404",
      response: {
        status: 404,
        data: { detail: { error: "not_found", code: "CUSTOMER_NOT_FOUND" } },
      },
    });

    mount();
    await settle();
    await readyMinimalForm();
    click(buttonByText("完整预览"), "完整预览按钮");

    await waitFor(
      () => (document.body.textContent ?? "").includes("完整预览生成失败"),
      "错误提示出现",
    );
    const text = dialog().textContent ?? "";
    expect(text).toContain("业务客户不存在，或当前账号无权访问");
    expect(text).not.toContain("Request failed with status code");
    expect(dialog().querySelector("iframe")).toBeNull();
  });

  it('422 {"error":"bad_doc_type"}（无 code/message）也显示中文，不退成英文 axios 文案', async () => {
    mocks.post.mockRejectedValue({
      isAxiosError: true,
      message: "Request failed with status code 422",
      response: { status: 422, data: { detail: { error: "bad_doc_type" } } },
    });

    mount();
    await settle();
    await readyMinimalForm();
    click(buttonByText("完整预览"), "完整预览按钮");

    await waitFor(
      () => (document.body.textContent ?? "").includes("完整预览生成失败"),
      "错误提示出现",
    );
    const text = dialog().textContent ?? "";
    expect(text).toContain("单证类型无效，请重新选择要预览的类型");
    expect(text).not.toContain("Request failed with status code");
  });

  it("错误体带 detail.detail（更具体的中文原因）时优先展示它", async () => {
    mocks.post.mockRejectedValue({
      isAxiosError: true,
      message: "Request failed with status code 422",
      response: {
        status: 422,
        data: {
          detail: {
            error: "validation",
            code: "INVALID_ORDER_ID",
            field: "order_id",
            value: 9,
            detail: "订单 9 不存在或不属于当前团队",
          },
        },
      },
    });

    mount();
    await settle();
    await readyMinimalForm();
    click(buttonByText("完整预览"), "完整预览按钮");

    await waitFor(
      () => (document.body.textContent ?? "").includes("完整预览生成失败"),
      "错误提示出现",
    );
    const text = dialog().textContent ?? "";
    expect(text).toContain("订单 9 不存在或不属于当前团队");
    expect(text).not.toContain("Request failed with status code");
  });

  it("doc.id 非空（quotation 已有 1:1 报价单）时提示预览的就是已存在那张单", async () => {
    mocks.post.mockImplementation(
      async (url: string, body: { doc_type?: string }) => {
        if (url !== "/trade-docs/preview-render-data") {
          throw new Error(`意外的 POST：${url}`);
        }
        const docType = String(body?.doc_type ?? "ci");
        const base = respondWithPreview(docType);
        if (docType === "pi") {
          return {
            data: {
              ...base,
              doc: { ...base.doc, id: 77, doc_no: "PI-US-ACME-20261023120000" },
            },
          };
        }
        return { data: base };
      },
    );

    mount();
    await settle();
    await readyMinimalForm();
    toggleDocType("形式发票");
    await settle();

    click(buttonByText("完整预览"), "完整预览按钮");
    await waitFor(
      () => document.querySelector('[role="dialog"] iframe') !== null,
      "完整预览对话框出现",
    );
    // 新单：只读计算、未占用
    expect(dialog().textContent ?? "").toContain(
      "预览编号（只读计算、未占用）：CI-PREVIEW-20261024132237",
    );

    const piButton = Array.from(dialog().querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").trim() === "形式发票",
    );
    click(piButton, "形式发票类型按钮");
    await waitFor(
      () => (dialog().textContent ?? "").includes("该上游已有这张单"),
      "已有单据提示出现",
    );
    expect(dialog().textContent ?? "").toContain(
      "该上游已有这张单：PI-US-ACME-20261023120000（预览的就是它）",
    );
  });

  it("选了来源订单后：预览请求带上 order_id（与开单同一份来源数据）", async () => {
    mount();
    await settle();
    click(
      document.querySelector('[data-testid="pick-customer"]'),
      "客户选择按钮",
    );
    await settle();
    // 默认来源就是「订单」，选中那条订单
    setSelectValue(orderSelect(), "1");
    await settle();

    click(buttonByText("完整预览"), "完整预览按钮");
    await waitFor(() => mocks.post.mock.calls.length > 0, "预览请求发出");
    expect(mocks.post).toHaveBeenCalledWith(
      "/trade-docs/preview-render-data",
      expect.objectContaining({ doc_type: "ci", order_id: 1 }),
      expect.anything(),
    );
    // 真实行项来自接口，不是表单本地拼的
    await waitFor(
      () => document.querySelector('[role="dialog"] iframe') !== null,
      "完整预览对话框出现",
    );
    expect(previewFrame().getAttribute("srcdoc") ?? "").toContain(
      "热镀锌勾花网 · CI 真实行项",
    );
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
