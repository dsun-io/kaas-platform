/**
 * Leadgen CSV 导入面板（C36 #17）——上传契约与错误透出。
 *
 * 钉住：非 csv 本地拦截（不发请求）；合法文件 POST multipart `/leadgen/runs/from-csv`
 * 且字段名为 `csv_file`；成功后回调刷新运行历史；失败原因原样显示。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { LeadgenCsvImport } from "../csv-import-panel";

const mocks = vi.hoisted(() => ({ post: vi.fn() }));

vi.mock("@/lib/api/client", () => ({
  default: { post: mocks.post },
  apiClient: { post: mocks.post },
}));

const toastSuccess = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

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

function chooseFile(file: File) {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error("没找到文件选择框");
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  act(() => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
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

describe("LeadgenCsvImport", () => {
  it("非 .csv 本地拦截，不发请求", async () => {
    mount(<LeadgenCsvImport />);
    chooseFile(new File(["a,b\n1,2"], "leads.xlsx"));
    clickButton("导入 CSV 线索");
    await settle();
    expect(mocks.post).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      ".csv",
    );
  });

  it("合法 csv：POST multipart 到 /leadgen/runs/from-csv，字段名 csv_file", async () => {
    mocks.post.mockResolvedValue({
      data: {
        id: 9001,
        status: "succeeded",
        leads_found: 2,
        leads_kept: 2,
        deduplicated: false,
      },
    });
    const onImported = vi.fn();
    mount(<LeadgenCsvImport onImported={onImported} />);
    chooseFile(new File(["company_name\nA\nB\n"], "leads.csv"));
    clickButton("导入 CSV 线索");
    await settle();

    expect(mocks.post).toHaveBeenCalledTimes(1);
    const [url, body, config] = mocks.post.mock.calls[0]!;
    expect(url).toBe("/leadgen/runs/from-csv");
    expect(body).toBeInstanceOf(FormData);
    expect((body as FormData).get("csv_file")).toBeInstanceOf(File);
    expect(config).toEqual({
      headers: { "Content-Type": "multipart/form-data" },
      silent: true,
    });
    expect(toastSuccess).toHaveBeenCalledWith(
      expect.stringContaining("保留 2 条线索"),
    );
    expect(onImported).toHaveBeenCalledWith(
      expect.objectContaining({ id: 9001 }),
    );
  });

  it("失败原因（422 CSV_REQUIRED）原样显示在面板里", async () => {
    mocks.post.mockRejectedValue(
      Object.assign(new Error("bad"), {
        response: {
          status: 422,
          data: {
            detail: {
              error: "validation",
              code: "CSV_REQUIRED",
              detail: "source=csv 需上传 CSV 文件",
            },
          },
        },
      }),
    );
    mount(<LeadgenCsvImport />);
    chooseFile(new File(["company_name\nA\n"], "leads.csv"));
    clickButton("导入 CSV 线索");
    await settle();
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      "source=csv 需上传 CSV 文件",
    );
  });
});
