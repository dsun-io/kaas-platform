/**
 * 情报 CSV 导入对话框（C36 #15）组件测试：
 * 识别表头 → 预览 → 缺必填列时禁用确认 → 合法上传 POST multipart（字段 file）→ 展示导入结果。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { IntelCsvImportDialog } from "../csv-import-dialog";

const mocks = vi.hoisted(() => ({ post: vi.fn() }));

vi.mock("@/lib/api/client", () => ({
  default: { post: mocks.post },
  apiClient: { post: mocks.post },
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let client: QueryClient | null = null;

async function settle(times = 8) {
  await act(async () => {
    for (let i = 0; i < times; i += 1) await new Promise((r) => setTimeout(r, 0));
  });
}
function mount(element: ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  root = createRoot(container);
  act(() => root!.render(<QueryClientProvider client={client!}>{element}</QueryClientProvider>));
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
function chooseCsv(content: string, name = "shipments.csv") {
  const file = new File([content], name, { type: "text/csv" });
  Object.defineProperty(file, "text", { value: async () => content });
  const input = document.querySelector<HTMLInputElement>(
    'input[aria-label="选择情报 CSV 文件"]',
  );
  if (!input) throw new Error("没找到文件选择框");
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  act(() => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
function confirmDisabled(): boolean {
  const button = Array.from(document.querySelectorAll("button")).find(
    (b) => (b.textContent ?? "").trim().startsWith("确认导入"),
  );
  return button instanceof HTMLButtonElement ? button.disabled : true;
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

describe("IntelCsvImportDialog", () => {
  it("识别列映射与预览；缺必填列时确认按钮禁用", async () => {
    mount(<IntelCsvImportDialog open onOpenChange={vi.fn()} />);
    chooseCsv("shipper,foo\nA,1\n");
    await settle();
    expect(document.body.textContent).toContain("列映射");
    expect(document.body.textContent).toContain("shipper");
    expect(document.body.textContent).toContain("foo");
    expect(document.body.textContent).toContain("缺少后端必填列");
    expect(confirmDisabled()).toBe(true);
  });

  it("合法 CSV：确认后 POST multipart 到 /intel/import/csv（字段 file），展示结果", async () => {
    mocks.post.mockResolvedValue({
      data: { status: "success", processed: 2, inserted: 2, errors: 0, error_details: [] },
    });
    mount(<IntelCsvImportDialog open onOpenChange={vi.fn()} />);
    chooseCsv("shipper,consignee,product_desc\nA,B,C\nD,E,F\n");
    await settle();
    expect(confirmDisabled()).toBe(false);
    clickButton("确认导入");
    await settle();

    expect(mocks.post).toHaveBeenCalledTimes(1);
    const [url, body, config] = mocks.post.mock.calls[0]!;
    expect(url).toBe("/intel/import/csv");
    expect(body).toBeInstanceOf(FormData);
    expect((body as FormData).get("file")).toBeInstanceOf(File);
    expect(config).toEqual({
      headers: { "Content-Type": "multipart/form-data" },
      silent: true,
    });
    expect(document.body.textContent).toContain("成功导入");
    expect(document.body.textContent).toContain("2");
  });

  it("上传失败时错误原文显示", async () => {
    mocks.post.mockRejectedValue({
      response: { status: 422, data: { detail: "缺少 file 字段（multipart）" } },
    });
    mount(<IntelCsvImportDialog open onOpenChange={vi.fn()} />);
    chooseCsv("shipper,consignee,product_desc\nA,B,C\n");
    await settle();
    clickButton("确认导入");
    await settle();
    expect(document.querySelector('[role="alert"]')?.textContent ?? "").toContain(
      "缺少 file 字段",
    );
  });
});
