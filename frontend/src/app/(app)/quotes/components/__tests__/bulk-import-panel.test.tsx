/**
 * C19：批量导入面板主链路（上传 → 预览/校验 → 确认导入/计算 → 结果汇总）。
 *
 * 为什么 mock hooks 而不是走真实 MSW：
 *  - 导入接口是 multipart。jsdom 的 `FormData`/`File` 与 Node(undici) 的
 *    fetch 品牌不兼容，真实 multipart 在 jsdom 测试里会挂起/断言失败
 *    （C18 的 `p1-handlers-contract.test.ts` 因此用 vitest 的 environment 指令切到 node）。
 *  - 端点行为本身已在 **node 环境**的 MSW 契约测试里覆盖：
 *    `src/mocks/__tests__/longtail-handlers-contract.test.ts`（preview/calculate +
 *    空文件/.xls/超限 400）。
 * 所以这里专注 UI 状态机与纯函数复用，文件/网络层各由对应测试兜。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type {
  ImportCalculateResponse,
  ImportPreviewResponse,
} from "@contracts/export-quote";

const mocks = vi.hoisted(() => {
  const PRODUCTS = {
    products: [{ key: "field_fence", name: "牛栏网", combo_count: 48 }],
    total: 1,
  };
  const TEMPLATE = {
    product_key: "field_fence",
    product_name: "牛栏网",
    columns: [
      {
        header: "竖丝间距(cm)",
        kind: "scalar",
        target: "spec.mesh_mm",
        required: true,
        unit: "cm",
        options: ["10"],
        note: "单位 cm",
      },
    ],
    headers: ["竖丝间距(cm)"],
    required_headers: ["竖丝间距(cm)"],
    max_rows: 2000,
    max_mb: 2,
    sheets: ["规格表"],
    data_sheet: "规格表",
    download: {},
    notes: [],
  };
  const state: {
    preview: ImportPreviewResponse | null;
    calculate: ImportCalculateResponse | null;
  } = { preview: null, calculate: null };
  return {
    PRODUCTS,
    TEMPLATE,
    state,
    download: vi.fn(),
    previewMutate: vi.fn(async () => state.preview),
    calculateMutate: vi.fn(async () => state.calculate),
    writeText: vi.fn<(text: string) => Promise<void>>(async () => undefined),
    toastSuccess: vi.fn(),
    toastError: vi.fn(),
  };
});

const PREVIEW_OK = {
  product_key: "field_fence",
  product_name: "牛栏网",
  source_name: "specs.xlsx",
  total_data_rows: 3,
  usable_rows: 2,
  error_count: 1,
  warning_count: 1,
  mapping: { "竖丝间距(cm)": "spec.mesh_mm" },
  ignored_columns: [],
  issues: [
    {
      row: 2,
      column: "竖丝间距(cm)",
      value: "abc",
      message: "不是数字",
      severity: "error" as const,
    },
    {
      row: 0,
      column: "",
      value: null,
      message: "重复行已跳过",
      severity: "warning" as const,
    },
  ],
  rows: [],
  expected_columns: ["竖丝间距(cm)"],
} satisfies ImportPreviewResponse;

const PREVIEW_EMPTY = {
  ...PREVIEW_OK,
  total_data_rows: 2,
  usable_rows: 0,
  error_count: 2,
  warning_count: 0,
  issues: [
    {
      row: 1,
      column: "竖丝间距(cm)",
      value: "x",
      message: "取值不在可选值内",
      severity: "error" as const,
    },
    {
      row: 2,
      column: "",
      value: null,
      message: "整表只有表头，没有数据行",
      severity: "error" as const,
    },
  ],
} satisfies ImportPreviewResponse;

const CALC_RESULT = {
  meta: {
    product_key: "field_fence",
    product_name: "牛栏网",
    currency: "CNY",
    quote_currency: "USD",
    quote_date: "2026-10-20",
    validity_days: 30,
    valid_until: "2026-11-19",
    diagnostics: ["示例诊断"],
    totals: { total_weight_kg: 85, total_price: 1234.5, total_price_fx: 171.9 },
    orders: [{ total_weight_kg: 85 }],
  },
  view: "customer",
  customer: {
    header: ["规格", "总净重(kg)"],
    rows: [["全丝2.0", 42.5]],
  },
  internal: {
    header: ["规格", "总净重(kg)"],
    rows: [["全丝2.0", 42.5]],
  },
  import: {
    source_name: "specs.xlsx",
    total_data_rows: 3,
    usable_rows: 2,
    skipped_rows: 1,
    mapping: {},
    ignored_columns: [],
    issues: [],
  },
  spec_rows: { submitted: 3, computed: 2, skipped: 1 },
} as unknown as ImportCalculateResponse;

vi.mock("../../hooks/use-export-quote-import", () => ({
  useExportProducts: () => ({ data: mocks.PRODUCTS, isLoading: false }),
  useImportTemplateInfo: () => ({ data: mocks.TEMPLATE }),
  useDownloadTemplate: () => ({
    mutate: mocks.download,
    isPending: false,
    isSuccess: false,
  }),
  useImportPreview: () => ({
    mutateAsync: mocks.previewMutate,
    isPending: false,
  }),
  useImportCalculate: () => ({
    mutateAsync: mocks.calculateMutate,
    isPending: false,
  }),
}));

vi.mock("@/lib/fx/use-latest-fx", () => ({
  useLatestFxRate: () => ({
    data: { rate: 7.18, is_stale: false, rate_date: "2026-10-20" },
    isPending: false,
  }),
}));

vi.mock("@/lib/auth/auth-context", () => ({
  useAuth: () => ({ user: { account_type: "customer" } }),
}));

vi.mock("@/lib/export-quote/import-template-xlsx", () => ({
  IMPORT_TEMPLATE_NOTES_SHEET: "填写说明",
}));

vi.mock("sonner", () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));

import { BulkImportPanel } from "../bulk-import-panel";
import { BulkImportEntry } from "../bulk-import-dialog";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let onImported: ReturnType<typeof vi.fn>;

function renderPanel() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<BulkImportPanel onImported={onImported as () => void} />);
  });
  return container;
}

function buttonByText(text: string): HTMLButtonElement {
  const buttons = [...container!.querySelectorAll("button")];
  const exact = buttons.find((b) => (b.textContent ?? "").trim() === text);
  const found =
    exact ?? buttons.find((b) => (b.textContent ?? "").includes(text));
  if (!found) throw new Error(`找不到按钮：${text}`);
  return found as HTMLButtonElement;
}

function chooseFile(name: string, size = 1024) {
  const input = container!.querySelector(
    'input[type="file"]',
  ) as HTMLInputElement;
  const file = new File([new Uint8Array(size)], name, {
    type: "application/octet-stream",
  });
  Object.defineProperty(input, "files", {
    value: [file],
    configurable: true,
  });
  act(() => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  return file;
}

async function click(text: string) {
  await act(async () => {
    buttonByText(text).dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    await Promise.resolve();
  });
}

beforeEach(() => {
  onImported = vi.fn();
  mocks.state.preview = PREVIEW_OK;
  mocks.state.calculate = CALC_RESULT;
  mocks.previewMutate.mockClear();
  mocks.calculateMutate.mockClear();
  mocks.writeText.mockClear();
  mocks.toastSuccess.mockClear();
  mocks.toastError.mockClear();
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: mocks.writeText },
    configurable: true,
  });
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
    () => undefined,
  );
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.restoreAllMocks();
});

describe("C19 批量导入面板", () => {
  it("不支持的格式：本地拦下并明确提示，不发预览请求", () => {
    renderPanel();
    chooseFile("old.xls");

    expect(container!.textContent).toContain("不支持老的 .xls");
    expect(mocks.previewMutate).not.toHaveBeenCalled();
  });

  it("空文件：明确提示「文件是空的」，不发预览请求", () => {
    renderPanel();
    chooseFile("empty.xlsx", 0);

    expect(container!.textContent).toContain("文件是空的");
    expect(mocks.previewMutate).not.toHaveBeenCalled();
  });

  it("预览校验失败（可用 0 行）：逐行展示问题，且不能确认导入", async () => {
    mocks.state.preview = PREVIEW_EMPTY;
    renderPanel();
    chooseFile("bad.xlsx");
    await click("先预览解析结果");

    expect(container!.textContent).toContain("没有可用行");
    expect(container!.textContent).toContain("第 1 行");
    expect(container!.textContent).toContain("取值不在可选值内");
    expect(container!.textContent).toContain("整表只有表头");
    // 可用 0 行 ⇒ 确认按钮禁用（不让用户对着坏表发起计算）
    expect(buttonByText("确认导入").disabled).toBe(true);
    expect(mocks.calculateMutate).not.toHaveBeenCalled();
  });

  it("预览 → 确认导入成功：汇总/结果表出现，刷新回调触发", async () => {
    renderPanel();
    chooseFile("specs.xlsx");
    await click("先预览解析结果");

    expect(container!.textContent).toContain("解析到 2 行可用规格");
    expect(container!.textContent).toContain("第 2 行");
    expect(container!.textContent).toContain("不是数字");

    await click("确认导入（批量计算）");

    expect(mocks.calculateMutate).toHaveBeenCalledTimes(1);
    expect(container!.textContent).toContain("已计算 2 行");
    expect(container!.textContent).toContain("规格行数");
    expect(container!.textContent).toContain("总售价（USD）");
    expect(container!.textContent).toContain("规格");
    expect(container!.textContent).toContain("客户视图（不含成本列）");
    expect(onImported).toHaveBeenCalledTimes(1);
  });

  it("问题清单可复制、可下载 CSV", async () => {
    renderPanel();
    chooseFile("specs.xlsx");
    await click("先预览解析结果");

    await click("复制");
    expect(mocks.writeText).toHaveBeenCalledTimes(1);
    const copied = mocks.writeText.mock.calls[0]?.[0];
    expect(copied).toContain("[第 2 行]");
    expect(copied).toContain("不是数字");

    await click("下载 CSV");
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledTimes(1);
  });

  it("入口按钮打开导入弹窗（C19 顶部入口接线）", () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <BulkImportEntry />
        </QueryClientProvider>,
      );
    });

    expect(container.textContent).toContain("批量导入表格");
    act(() => {
      buttonByText("批量导入表格").dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    expect(document.body.textContent).toContain("批量导入报价表");
  });
});
