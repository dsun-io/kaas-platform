/**
 * 「已导入单证」面板（追加需求）：列表 / 下载 / 补导入 / 空态。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}));

vi.mock("@/lib/api/client", () => ({
  default: { get: mocks.get, post: mocks.post },
  apiClient: { get: mocks.get, post: mocks.post },
}));
vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

import { OrderExternalDocsPanel } from "../order-external-docs-panel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const DOCS = [
  {
    id: 1,
    doc_type: "contract",
    file_name: "contract-signed.pdf",
    content_type: "application/pdf",
    file_size: 2048,
    order_id: 9,
    status: "draft",
    notes: "客户签章扫描件",
    created_at: "2026-10-20T00:00:00Z",
  },
  {
    id: 2,
    doc_type: "po",
    file_name: "po-001.pdf",
    content_type: "application/pdf",
    file_size: 1024,
    order_id: 9,
    status: "draft",
    notes: null,
    created_at: "2026-10-21T00:00:00Z",
  },
];

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let client: QueryClient | null = null;

async function settle(times = 5) {
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

function clickButton(text: string, index = 0) {
  const el = Array.from(document.querySelectorAll("button")).filter(
    (button) => (button.textContent ?? "").trim() === text,
  )[index];
  if (!el) throw new Error(`没找到按钮「${text}」#${index}`);
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function attachFile(selector: string, file: File) {
  const el = document.querySelector<HTMLInputElement>(selector);
  if (!el) throw new Error(`没找到 ${selector}`);
  Object.defineProperty(el, "files", { value: [file], configurable: true });
  act(() => {
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function setInputById(id: string, value: string) {
  const el = document.getElementById(id) as HTMLInputElement | null;
  if (!el) throw new Error(`没找到 #${id}`);
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockImplementation(async (url: string) => {
    if (String(url) === "/external-docs") return { data: DOCS };
    if (String(url) === "/external-docs/1/download") {
      return { data: new Blob(["pdf-bytes"], { type: "application/pdf" }) };
    }
    throw new Error(`unexpected GET ${String(url)}`);
  });
  mocks.post.mockResolvedValue({ data: { id: 3, file_name: "new.pdf" } });
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  document.body.innerHTML = "";
  root = null;
  container = null;
  client?.clear();
  client = null;
  vi.restoreAllMocks();
});

describe("OrderExternalDocsPanel", () => {
  it("列表：按 order_id 拉取并展示类型/文件名/大小/时间/备注", async () => {
    mount(<OrderExternalDocsPanel orderId={9} />);
    await settle();

    expect(mocks.get).toHaveBeenCalledWith("/external-docs", {
      params: { order_id: 9 },
      silent: true,
    });
    const text = document.body.textContent ?? "";
    expect(text).toContain("合同");
    expect(text).toContain("采购订单 PO");
    expect(text).toContain("contract-signed.pdf");
    expect(text).toContain("2.0 KB");
    expect(text).toContain("2026-10-20");
    expect(text).toContain("客户签章扫描件");
  });

  it("下载：GET /external-docs/{id}/download 取 blob 并触发本地下载", async () => {
    const createObjectURL = vi.fn(() => "blob:external-doc");
    const revokeObjectURL = vi.fn();
    (URL as unknown as { createObjectURL: typeof createObjectURL }).createObjectURL =
      createObjectURL;
    (URL as unknown as { revokeObjectURL: typeof revokeObjectURL }).revokeObjectURL =
      revokeObjectURL;
    const anchorClick = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});

    mount(<OrderExternalDocsPanel orderId={9} />);
    await settle();

    clickButton("下载");
    await settle();

    expect(mocks.get).toHaveBeenCalledWith("/external-docs/1/download", {
      responseType: "blob",
      silent: true,
    });
    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    expect(anchorClick).toHaveBeenCalled();
  });

  it("补导入：POST /external-docs multipart（file/doc_type/order_id/notes）", async () => {
    mount(<OrderExternalDocsPanel orderId={9} />);
    await settle();

    const select = document.querySelector<HTMLSelectElement>(
      'select[aria-label="单证类型"]',
    )!;
    const setter = Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      "value",
    )?.set;
    act(() => {
      setter?.call(select, "ci");
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    setInputById("external-doc-notes", "补导入发票");
    attachFile(
      "#external-doc-file",
      new File([new Uint8Array(4)], "invoice.pdf", {
        type: "application/pdf",
      }),
    );
    clickButton("导入单证");
    await settle();

    expect(mocks.post).toHaveBeenCalledTimes(1);
    const [url, form, config] = mocks.post.mock.calls[0]!;
    expect(url).toBe("/external-docs");
    expect(form).toBeInstanceOf(FormData);
    const body = form as FormData;
    expect(body.get("file")).toBeInstanceOf(File);
    expect(body.get("doc_type")).toBe("ci");
    expect(body.get("order_id")).toBe("9");
    expect(body.get("notes")).toBe("补导入发票");
    expect(config).toMatchObject({
      headers: { "Content-Type": "multipart/form-data" },
      silent: true,
    });
  });

  it("非法文件本地拦下，不发请求", async () => {
    mount(<OrderExternalDocsPanel orderId={9} />);
    await settle();

    attachFile(
      "#external-doc-file",
      new File([new Uint8Array(4)], "virus.exe", {
        type: "application/octet-stream",
      }),
    );
    clickButton("导入单证");
    await settle();

    expect(mocks.post).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("支持 PDF");
  });

  it("空列表：EmptyState 引导", async () => {
    mocks.get.mockResolvedValue({ data: [] });
    mount(<OrderExternalDocsPanel orderId={9} />);
    await settle();
    expect(document.body.textContent).toContain("还没有导入已有单证");
  });
});
