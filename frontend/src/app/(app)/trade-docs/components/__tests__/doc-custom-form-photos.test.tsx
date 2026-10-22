/**
 * 单证内容表单 · 已引用产品图的排序与移除。
 *
 * 为什么单独一组用例：`product_photos` 在表单里是一个 **JSON 文本框**，
 * 用户过去只能手改 JSON 调顺序（既容易写坏格式，也看不出改完长什么样）。
 * 现在列表可拖拽、可移除，写回时必须满足两条：
 * 1. **保留用户手写的额外字段**（例如 `caption` 之外的 `image`/`note`）——
 *    重排只换位置，不能把对象"重新拼一遍"；
 * 2. 遇到无法识别的条目**宁可不改**，也不要静默丢掉。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { DocCustomForm } from "../doc-custom-form";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("@/lib/api/client", () => ({
  default: {
    get: mocks.get,
    post: mocks.post,
    patch: mocks.patch,
    delete: mocks.delete,
  },
  apiClient: {
    get: mocks.get,
    post: mocks.post,
    patch: mocks.patch,
    delete: mocks.delete,
  },
}));

const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    info: vi.fn(),
    error: (...a: unknown[]) => toastError(...a),
  },
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/** 三张已引用的图；第二条故意带了手写额外字段，用来验证"重排不吃字段" */
const PHOTOS = [
  { file_id: 31, caption: "成品外观" },
  { file_id: 32, caption: "侧面尺寸", image: "/legacy.png", note: "手写备注" },
  { file_id: 33, caption: "卷装重量" },
];

type Resp = { data: unknown };
const ok = (data: unknown): Resp => ({ data }) as unknown as Resp;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let client: QueryClient | null = null;

async function settle(times = 5) {
  await act(async () => {
    for (let i = 0; i < times; i++) {
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

function unmount() {
  if (root) act(() => root!.unmount());
  container?.remove();
  client?.clear();
  root = null;
  container = null;
  client = null;
}

/** `product_photos` 的 JSON 文本框（label 上有 data-field） */
function photosTextarea(): HTMLTextAreaElement {
  const label = document.querySelector('label[data-field="product_photos"]');
  const el = label?.querySelector<HTMLTextAreaElement>("textarea");
  if (!el) throw new Error("没找到 product_photos 文本框");
  return el;
}

function parsedPhotos(): unknown[] {
  return JSON.parse(photosTextarea().value) as unknown[];
}

function clickByLabel(label: string) {
  const el = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!el) throw new Error(`没找到按钮 aria-label="${label}"`);
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockImplementation((url: string) => {
    if (url === "/clause-templates") return Promise.resolve(ok({ items: [] }));
    if (url === "/products") return Promise.resolve(ok({ items: [], media_kinds: {} }));
    if (url === "/products/chain_link/media")
      return Promise.resolve(ok({ items: [], media_kinds: {} }));
    return Promise.resolve(ok({}));
  });
  // jsdom 没有 objectURL（缩略图取 blob 后会 createObjectURL）
  vi.stubGlobal(
    "URL",
    Object.assign(URL, {
      createObjectURL: vi.fn(() => "blob:thumb"),
      revokeObjectURL: vi.fn(),
    }),
  );
});

afterEach(() => {
  unmount();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

function renderForm(photos: unknown[]) {
  return (
    <DocCustomForm
      docId={1}
      docType="pi"
      status="draft"
      payload={{ custom: { product_photos: photos } }}
      data={{}}
    />
  );
}

describe("DocCustomForm · 已引用产品图", () => {
  it("按出图顺序列出已引用的图，并给出拖动把手", async () => {
    mount(renderForm(PHOTOS));
    await settle();

    const text = document.body.textContent ?? "";
    expect(text).toContain("已引用 3 张");
    expect(text).toContain("成品外观");
    expect(text).toContain("卷装重量");
    expect(text).toContain("拖动把手可调整");

    expect(document.querySelector('button[aria-label="拖动排序 成品外观"]')).not.toBeNull();
    expect(
      document.querySelector('button[aria-label="拖动排序 卷装重量"]'),
    ).not.toBeNull();
  });

  it("移除一张：只删它，顺序和额外字段都不动", async () => {
    mount(renderForm(PHOTOS));
    await settle();

    clickByLabel("移除引用 成品外观");
    await settle();

    expect(parsedPhotos()).toEqual([PHOTOS[1], PHOTOS[2]]);
  });

  it("全部移除后清空字段（不留空数组，否则渲染器会当成「有图但都无效」）", async () => {
    mount(renderForm([{ file_id: 31, caption: "成品外观" }]));
    await settle();

    clickByLabel("移除引用 成品外观");
    await settle();

    expect(photosTextarea().value).toBe("");
  });

  it("有无法识别的条目时不重排、也不静默丢内容", async () => {
    // 混入一条没有 file_id 的手写对象：重排必须拒绝而不是把它吃掉
    const mixed = [...PHOTOS, { image: "/x.png", caption: "手写条目" }];
    mount(renderForm(mixed));
    await settle();

    // 列表只显示能识别的 3 条（第 4 条无法拖拽）
    expect(document.body.textContent).toContain("已引用 3 张");
    // 但原 JSON 里的第 4 条仍在（只是没被列表接管）
    expect(parsedPhotos()).toHaveLength(4);
  });
});
