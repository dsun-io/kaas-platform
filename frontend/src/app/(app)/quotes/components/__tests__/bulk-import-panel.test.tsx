/**
 * R-D：整单批量导入面板（下载整单模板 → 上传解析预览 → 填入工作台）。
 *
 * 为什么 mock hooks 而不是走真实 MSW：
 *  - 导入接口是 multipart，jsdom 的 FormData/File 与 Node(undici) fetch 品牌不兼容；
 *  - 端点行为本身在 node 环境的 MSW 契约测试里覆盖（longtail-handlers-contract）。
 * 这里专注 UI 状态机：文件预检 / 预览摘要 / 问题清单 / 填入回调。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type {
  OrderImportPreviewResponse,
  OrderImportRow,
} from "@contracts/export-quote";

const mocks = vi.hoisted(() => {
  const TEMPLATE = {
    product_keys: [] as string[],
    headers: ["产品", "件数（卷）", "成本", "竖丝间距(cm)"],
    columns: [
      {
        header: "产品",
        kind: "common" as const,
        products: [],
        unit: "",
        options: [],
        note: "",
      },
      {
        header: "件数（卷）",
        kind: "common" as const,
        products: [],
        unit: "",
        options: [],
        note: "",
      },
      {
        header: "成本",
        kind: "common" as const,
        products: [],
        unit: "",
        options: [],
        note: "",
      },
      {
        header: "竖丝间距(cm)",
        kind: "spec" as const,
        products: ["牛栏网"],
        unit: "cm",
        options: ["10", "15"],
        note: "",
      },
    ],
    max_rows: 2000,
    max_mb: 2,
    data_sheet: "整单表",
    notes: [],
  };
  const state: { preview: OrderImportPreviewResponse | null } = {
    preview: null,
  };
  return {
    TEMPLATE,
    state,
    download: vi.fn(),
    previewMutate: vi.fn(async () => state.preview),
    writeText: vi.fn<(text: string) => Promise<void>>(async () => undefined),
    toastSuccess: vi.fn(),
    toastError: vi.fn(),
  };
});

const ROWS: OrderImportRow[] = [
  {
    row: 1,
    product_key: "field_fence",
    product_name: "牛栏网",
    spec: { mesh_mm: 100 },
    pieces: 10,
    cost: 4.8,
    cost_basis: "pretax",
    packaging_method: null,
    packaging_id: null,
    profit_pct: null,
    row_errors: [],
  },
  {
    row: 2,
    product_key: "chain_link",
    product_name: "勾花网",
    spec: { wire: 2.0 },
    pieces: 4,
    cost: 5.2,
    cost_basis: "incl_tax",
    packaging_method: "编织袋+钢带",
    packaging_id: "pkg-1",
    profit_pct: 8,
    row_errors: [],
  },
];

const PREVIEW_OK: OrderImportPreviewResponse = {
  source_name: "order.xlsx",
  sheet: "整单表",
  total_data_rows: 3,
  usable_rows: 2,
  error_count: 1,
  warning_count: 1,
  products: [
    { product_key: "field_fence", product_name: "牛栏网", rows: 1 },
    { product_key: "chain_link", product_name: "勾花网", rows: 1 },
  ],
  mapping: {},
  ignored_columns: [],
  issues: [
    {
      row: 3,
      column: "件数（卷）",
      value: "-2",
      message: "件数必须为正数",
      severity: "error",
    },
    {
      row: 0,
      column: "",
      value: null,
      message: "第 3 行已跳过",
      severity: "warning",
    },
  ],
  rows: ROWS,
  expected_columns: ["产品", "件数（卷）", "成本"],
};

const PREVIEW_EMPTY: OrderImportPreviewResponse = {
  ...PREVIEW_OK,
  total_data_rows: 1,
  usable_rows: 0,
  error_count: 1,
  warning_count: 0,
  products: [],
  rows: [],
  issues: [
    {
      row: 1,
      column: "产品",
      value: "不存在",
      message: "未找到该产品",
      severity: "error",
    },
  ],
};

vi.mock("../../hooks/use-export-quote-import", () => ({
  useOrderImportTemplateInfo: () => ({ data: mocks.TEMPLATE }),
  useDownloadOrderTemplate: () => ({
    mutate: mocks.download,
    isPending: false,
    isSuccess: false,
    data: undefined,
  }),
  useImportOrderPreview: () => ({
    mutateAsync: mocks.previewMutate,
    isPending: false,
  }),
}));

vi.mock("@/lib/export-quote/import-order-template-xlsx", () => ({
  ORDER_TEMPLATE_NOTES_SHEET: "填写说明",
}));

vi.mock("sonner", () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));

import { BulkImportPanel } from "../bulk-import-panel";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let client: QueryClient | null = null;
let onFillRows: ReturnType<typeof vi.fn>;

function renderPanel() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  act(() => {
    root!.render(
      <QueryClientProvider client={client!}>
        <BulkImportPanel
          onFillRows={onFillRows as (rows: OrderImportRow[]) => void}
        />
      </QueryClientProvider>,
    );
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
  onFillRows = vi.fn();
  mocks.state.preview = PREVIEW_OK;
  mocks.previewMutate.mockClear();
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
  client = null;
  vi.restoreAllMocks();
});

describe("R-D 整单批量导入面板", () => {
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

  it("预览成功：整单摘要 + 产品徽章 + 行表 + 填入工作台回调", async () => {
    renderPanel();
    chooseFile("order.xlsx");
    await click("解析预览");

    expect(mocks.previewMutate).toHaveBeenCalledTimes(1);
    expect(container!.textContent).toContain("共 3 行 / 可用 2 行");
    expect(container!.textContent).toContain("1 处错误");
    expect(container!.textContent).toContain("牛栏网 × 1");
    expect(container!.textContent).toContain("勾花网 × 1");
    // 行表：含税/不含税与包装方式按行展示
    expect(container!.textContent).toContain("不含税");
    expect(container!.textContent).toContain("含税");
    expect(container!.textContent).toContain("编织袋+钢带");
    // 问题清单
    expect(container!.textContent).toContain("第 3 行");
    expect(container!.textContent).toContain("件数必须为正数");

    await click("填入工作台");

    expect(onFillRows).toHaveBeenCalledTimes(1);
    expect(onFillRows.mock.calls[0]?.[0]).toHaveLength(2);
    expect(mocks.toastSuccess).toHaveBeenCalledTimes(1);
  });

  it("可用 0 行：填入按钮禁用", async () => {
    mocks.state.preview = PREVIEW_EMPTY;
    renderPanel();
    chooseFile("order.xlsx");
    await click("解析预览");

    expect(container!.textContent).toContain("没有可用行");
    const fill = buttonByText("填入工作台");
    expect(fill.disabled).toBe(true);
    await click("填入工作台");
    expect(onFillRows).not.toHaveBeenCalled();
  });

  it("问题清单可复制、可下载 CSV", async () => {
    renderPanel();
    chooseFile("order.xlsx");
    await click("解析预览");

    await click("复制");
    expect(mocks.writeText).toHaveBeenCalledTimes(1);
    const copied = mocks.writeText.mock.calls[0]?.[0];
    expect(copied).toContain("[第 3 行]");
    expect(copied).toContain("件数必须为正数");

    await click("下载 CSV");
    expect(URL.createObjectURL).toHaveBeenCalled();
  });
});
