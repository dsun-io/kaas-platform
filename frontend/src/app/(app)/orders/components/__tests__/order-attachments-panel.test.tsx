/**
 * 订单附件面板（§13.3）：列表 / 上传 multipart / 失败可重试 / 列表端点回退。
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

import { OrderAttachmentsPanel } from "../order-attachments-panel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const FILES = [
  {
    id: 1,
    name: "合同 · 正式版.pdf",
    content_type: "application/pdf",
    size: 2048,
    created_at: "2026-10-20T00:00:00Z",
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

function clickButton(text: string) {
  const el = Array.from(document.querySelectorAll("button")).find((button) =>
    (button.textContent ?? "").trim() === text,
  );
  if (!el) throw new Error(`没找到按钮「${text}」`);
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
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

function attachFile(selector: string, file: File) {
  const el = document.querySelector<HTMLInputElement>(selector);
  if (!el) throw new Error(`没找到 ${selector}`);
  Object.defineProperty(el, "files", { value: [file], configurable: true });
  act(() => {
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockImplementation(async (url: string) => {
    if (String(url) === "/orders/9/files") {
      return { data: { items: FILES } };
    }
    throw new Error(`unexpected GET ${String(url)}`);
  });
  mocks.post.mockResolvedValue({ data: { id: 2, name: "PO 扫描件" } });
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

describe("OrderAttachmentsPanel", () => {
  it("列表展示附件名/类型/大小/日期", async () => {
    mount(<OrderAttachmentsPanel orderId={9} />);
    await settle();

    expect(mocks.get).toHaveBeenCalledWith("/orders/9/files");
    const text = document.body.textContent ?? "";
    expect(text).toContain("合同 · 正式版.pdf");
    expect(text).toContain("application/pdf");
    expect(text).toContain("2.0 KB");
    expect(text).toContain("2026-10-20");
  });

  it("上传：POST multipart，name 带类别前缀，不传 kind", async () => {
    mount(<OrderAttachmentsPanel orderId={9} />);
    await settle();

    const kind = document.querySelector<HTMLSelectElement>(
      'select[aria-label="附件类别"]',
    )!;
    const setter = Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      "value",
    )?.set;
    act(() => {
      setter?.call(kind, "po");
      kind.dispatchEvent(new Event("change", { bubbles: true }));
    });
    setInputById("order-attachment-name", "PO 扫描件");
    attachFile(
      "#order-attachment-file",
      new File([new Uint8Array(4)], "po-001.pdf", {
        type: "application/pdf",
      }),
    );
    clickButton("上传附件");
    await settle();

    expect(mocks.post).toHaveBeenCalledTimes(1);
    const [url, form, config] = mocks.post.mock.calls[0]!;
    expect(url).toBe("/orders/9/files");
    expect(form).toBeInstanceOf(FormData);
    expect((form as FormData).get("name")).toBe("PO / 客户订单 · PO 扫描件");
    expect((form as FormData).get("file")).toBeInstanceOf(File);
    expect((form as FormData).get("kind")).toBeNull();
    expect(config).toMatchObject({
      headers: { "Content-Type": "multipart/form-data" },
      silent: true,
    });
  });

  it("非法文件类型本地拦下，不发请求", async () => {
    mount(<OrderAttachmentsPanel orderId={9} />);
    await settle();

    attachFile(
      "#order-attachment-file",
      new File([new Uint8Array(4)], "a.docx", {
        type: "application/msword",
      }),
    );
    clickButton("上传附件");
    await settle();

    expect(mocks.post).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("只支持 PDF / JPG / PNG");
  });

  it("订单专属列表接口未就绪：回退 GET /file-objects?owner_type=order", async () => {
    mocks.get.mockImplementation(async (url: string, config?: unknown) => {
      if (String(url) === "/orders/9/files") throw new Error("404");
      if (String(url) === "/file-objects") {
        expect(config).toMatchObject({
          params: { owner_type: "order", owner_id: 9 },
          silent: true,
        });
        return { data: { items: FILES } };
      }
      throw new Error(`unexpected GET ${String(url)}`);
    });
    mount(<OrderAttachmentsPanel orderId={9} />);
    await settle();

    expect(document.body.textContent).toContain("合同 · 正式版.pdf");
  });

  it("空列表：给出下一步引导（EmptyState）", async () => {
    mocks.get.mockResolvedValue({ data: { items: [] } });
    mount(<OrderAttachmentsPanel orderId={9} />);
    await settle();
    expect(document.body.textContent).toContain("还没有订单附件");
  });
});
