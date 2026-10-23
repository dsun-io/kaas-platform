/**
 * 「导入已有数据」弹窗（C29 前端接线）—— 行为钉子。
 *
 * 为什么这些用例值得写（历史教训）：占位骨架时期这个弹窗"看起来能用"但**不发请求**，
 * 点提交只弹一句"即将上线"。真正接线后必须钉住：
 *   1. 客户**必选**（没选客户就点导入 ⇒ 明确告知，且不发请求）；
 *   2. 选客户 + 选 CSV ⇒ 自动调 `POST /imports/orders/preview`（multipart，字段
 *      `file` + `customer_id`），预览表按后端返回的 `columns` 渲染；
 *   3. 有错误行 ⇒ 「确认导入」**禁用**（错误行标红 + 原因逐条可见）；
 *   4. 全绿 ⇒ 提交 `POST /imports/orders`，成功 toast 带 created 数并关闭；
 *   5. 取消 = 直接关；
 *   6. 409 撞单号 ⇒ 后端原因**留可见**，弹窗不关，也不弹成功 toast（不假装成功）。
 *
 * 用真 hook + 假 `apiClient`（而不是假 hook）：这样 multipart 组装、路径字面量、
 * 错误信封解析（嵌套 `{"detail":{...}}`）都一起被覆盖 —— 只假 hook 就测不到它们。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ImportExistingDataDialog } from "@/components/import-existing-data-dialog";

const mocks = vi.hoisted(() => ({ post: vi.fn() }));

vi.mock("@/lib/api/client", () => ({
  default: { post: mocks.post },
  apiClient: { post: mocks.post },
}));

// CustomerPicker 是重型远程选择器（自己会发 GET /customers）；
// 这里只关心"已选客户"之后的行为，所以替换成一个立刻回写选中的按钮。
// id 用字符串（= CustomerPickerValue.id 的真实类型）。
vi.mock("@/components/customer-picker", () => ({
  CustomerPicker: ({
    onChange,
    required,
  }: {
    onChange: (value: { id: string; name: string }) => void;
    required?: boolean;
  }) => (
    <button
      type="button"
      data-testid="pick-customer"
      onClick={() => onChange({ id: "1", name: "联佳丝网" })}
    >
      {required ? "业务客户*" : "业务客户"}
    </button>
  ),
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
    info: vi.fn(),
  },
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const PREVIEW_OK = {
  customer: { id: 1, name: "联佳丝网" },
  columns: [
    "order_no",
    "order_date",
    "status",
    "currency",
    "total_amount",
    "notes",
  ],
  rows: [
    {
      index: 1,
      ok: true,
      data: {
        order_no: "SO-001",
        order_date: "2026-05-01",
        status: "completed",
        currency: "USD",
        total_amount: 1200.5,
        notes: null,
      },
      errors: [],
    },
    {
      index: 2,
      ok: true,
      data: {
        order_no: "SO-002",
        order_date: "2026-05-03",
        status: "pending",
        currency: "USD",
        total_amount: null,
        notes: "老客户返单",
      },
      errors: [],
    },
  ],
  summary: { total: 2, ok: 2, error: 0, existing_order_nos: [] },
};

const PREVIEW_WITH_ERROR = {
  customer: { id: 1, name: "联佳丝网" },
  columns: ["order_no", "order_date"],
  rows: [
    {
      index: 1,
      ok: true,
      data: { order_no: "SO-001", order_date: "2026-05-01" },
      errors: [],
    },
    {
      index: 2,
      ok: false,
      data: null,
      errors: ["order_no 已存在于本租户"],
    },
  ],
  summary: {
    total: 2,
    ok: 1,
    error: 1,
    existing_order_nos: ["SO-009"],
  },
};

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

function findButton(text: string): HTMLButtonElement {
  const buttons = Array.from(document.querySelectorAll("button"));
  const target = buttons.find(
    (button) => (button.textContent ?? "").trim() === text,
  );
  if (!target) throw new Error("没找到按钮「" + text + "」");
  return target as HTMLButtonElement;
}

function clickButton(text: string) {
  act(() => {
    findButton(text).dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function clickCustomer() {
  const button = document.querySelector(
    '[data-testid="pick-customer"]',
  ) as HTMLButtonElement | null;
  if (!button) throw new Error("没找到客户选择器");
  act(() => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

/** 给 file input 塞一个文件并触发 change（jsdom 的 files 是只读 FileList，需 define）。 */
function chooseFile(file: File) {
  const input = document.querySelector(
    'input[type="file"]',
  ) as HTMLInputElement | null;
  if (!input) throw new Error("没找到文件输入框");
  Object.defineProperty(input, "files", {
    value: [file],
    configurable: true,
  });
  act(() => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function csvFile(name = "history-orders.csv"): File {
  return new File(["order_no,order_date\nSO-001,2026-05-01\n"], name, {
    type: "text/csv",
  });
}

function axiosFailure(status: number, detail: Record<string, unknown>) {
  return Object.assign(new Error("Request failed with status code " + status), {
    response: { status, data: { detail } },
  });
}

let onOpenChange: ReturnType<typeof vi.fn<(open: boolean) => void>>;

beforeEach(() => {
  vi.clearAllMocks();
  onOpenChange = vi.fn();
  mount(
    <ImportExistingDataDialog
      open
      onOpenChange={onOpenChange}
      resource="订单"
    />,
  );
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  document.body.innerHTML = "";
  root = null;
  container = null;
  client?.clear();
  client = null;
});

describe("ImportExistingDataDialog（历史订单导入）", () => {
  it("客户未选就点「确认导入」：明确告知，且不发任何请求", async () => {
    await settle();
    clickButton("确认导入");
    await settle();

    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("请选择数据所属的业务客户");
    expect(mocks.post).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("选客户 + 选 CSV ⇒ 自动预览（multipart: file + customer_id），表格按 columns 渲染", async () => {
    mocks.post.mockResolvedValue({ data: PREVIEW_OK });
    await settle();

    clickCustomer();
    chooseFile(csvFile());
    await settle();

    expect(mocks.post).toHaveBeenCalledTimes(1);
    const [url, body] = mocks.post.mock.calls[0] as [string, FormData];
    expect(url).toBe("/imports/orders/preview");
    expect(body).toBeInstanceOf(FormData);
    expect(body.get("customer_id")).toBe("1");
    const uploaded = body.get("file");
    expect(uploaded).toBeInstanceOf(File);
    expect((uploaded as File).name).toBe("history-orders.csv");

    // 列 = 后端返回的 columns（前端不写死列，否则后端加列要改前端）
    const heads = Array.from(document.querySelectorAll("th")).map((th) =>
      (th.textContent ?? "").trim(),
    );
    expect(heads).toEqual(
      expect.arrayContaining([
        "行号",
        "order_no",
        "order_date",
        "status",
        "currency",
        "total_amount",
        "notes",
        "校验结果",
      ]),
    );
    // 行数据与摘要
    const text = document.body.textContent ?? "";
    expect(text).toContain("SO-001");
    expect(text).toContain("1200.5");
    expect(text).toContain("共 2 行");
    expect(text).toContain("可导入 2 行");
    expect(text).toContain("错误 0 行");
    expect(findButton("确认导入").disabled).toBe(false);
  });

  it("有错误行：原因可见 + 「确认导入」禁用", async () => {
    mocks.post.mockResolvedValue({ data: PREVIEW_WITH_ERROR });
    await settle();
    clickCustomer();
    chooseFile(csvFile());
    await settle();

    const text = document.body.textContent ?? "";
    expect(text).toContain("order_no 已存在于本租户");
    expect(text).toContain("SO-009");
    expect(text).toContain("可导入 1 行");
    expect(text).toContain("错误 1 行");
    expect(findButton("确认导入").disabled).toBe(true);
  });

  it("全绿后确认导入：POST /imports/orders，toast 带 created 数并关闭", async () => {
    mocks.post.mockImplementation(async (url: string) => {
      if (url === "/imports/orders/preview") return { data: PREVIEW_OK };
      return {
        data: { created: 2, ids: [7, 8], order_nos: ["SO-001", "SO-002"] },
      };
    });
    await settle();
    clickCustomer();
    chooseFile(csvFile());
    await settle();

    clickButton("确认导入");
    await settle();

    expect(mocks.post).toHaveBeenCalledTimes(2);
    const [commitUrl, commitBody] = mocks.post.mock.calls[1] as [
      string,
      FormData,
    ];
    expect(commitUrl).toBe("/imports/orders");
    expect(commitBody.get("customer_id")).toBe("1");
    expect(commitBody.get("file")).toBeInstanceOf(File);
    expect(toastSuccess).toHaveBeenCalledWith("已导入 2 笔订单");
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(toastError).not.toHaveBeenCalled();
  });

  it("取消：直接关闭，不发请求", async () => {
    await settle();
    clickButton("取消");
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("409 撞单号：后端原因（含重复单号）留在界面，弹窗不关、不弹成功", async () => {
    mocks.post.mockImplementation(async (url: string) => {
      if (url === "/imports/orders/preview") return { data: PREVIEW_OK };
      throw axiosFailure(409, {
        error: "conflict",
        code: "IMPORT_DUPLICATE_ORDER_NO",
        order_nos: ["SO-001", "SO-007"],
      });
    });
    await settle();
    clickCustomer();
    chooseFile(csvFile());
    await settle();

    clickButton("确认导入");
    await settle();

    const alert = document.querySelector('[role="alert"]');
    const alertText = alert?.textContent ?? "";
    expect(alertText).toContain("导入被拒绝");
    expect(alertText).toContain("SO-001");
    expect(alertText).toContain("SO-007");
    expect(alertText).toContain("409");
    expect(alertText).toContain("IMPORT_DUPLICATE_ORDER_NO");
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
