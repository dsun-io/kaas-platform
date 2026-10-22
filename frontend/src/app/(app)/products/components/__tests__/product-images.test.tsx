/**
 * 产品图库（重做后）—— 交互回归守卫。
 *
 * 这组测试存在的意义是**钉住 2026-10-22 的三条用户诉求**，防止以后被"顺手改回去"：
 * 1. 上移/下移按钮必须消失（排序一律拖拽）；
 * 2. 主图不能被拖（后端 `is_primary DESC` 会把它顶回来，可拖 = 假承诺）；
 * 3. 改名不能失焦即写库（必须是 Enter/✓ 显式提交，Esc 撤回）。
 *
 * 拖拽落点本身不在这里测：jsdom 没有布局，dnd-kit 算不出真实位移。
 * 顺序规则在 `../__tests__/media-order.test.ts` 逐条钉死。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("@/lib/api/client", () => ({
  default: { get: mocks.get, patch: mocks.patch, delete: mocks.delete },
  apiClient: { get: mocks.get, patch: mocks.patch, delete: mocks.delete },
}));
vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

import { ProductImagesSection } from "../product-images";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KINDS = {
  production: "生产图片",
  size: "尺寸图片",
  weight: "重量图片",
  finished: "成品图片",
  other: "其它",
};

/** 服务端顺序：主图恒在最前（`is_primary DESC, sort_order, id`） */
const ITEMS = [
  {
    id: 11,
    name: "2m×20m 成品图",
    media_kind: "finished",
    kind: "product_photo",
    storage: "s3",
    object_key: "k/11",
    content_type: "image/png",
    file_size: 2048,
    is_primary: true,
    sort_order: 0,
    version: 1,
    created_at: null,
  },
  {
    id: 12,
    name: "侧面尺寸图",
    media_kind: "size",
    kind: "product_photo",
    storage: "s3",
    object_key: "k/12",
    content_type: "image/png",
    file_size: 1024,
    is_primary: false,
    sort_order: 1,
    version: 1,
    created_at: null,
  },
  {
    id: 13,
    name: "卷装重量图",
    media_kind: "weight",
    kind: "product_photo",
    storage: "s3",
    object_key: "k/13",
    content_type: "image/png",
    file_size: 512,
    is_primary: false,
    sort_order: 2,
    version: 1,
    created_at: null,
  },
];

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

function buttonByLabel(label: string): HTMLButtonElement {
  const el = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!el) throw new Error(`没找到按钮 aria-label="${label}"`);
  return el;
}

function click(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function setInputValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function keyDown(el: Element, key: string) {
  act(() => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // jsdom 没有 objectURL：useFileObjectUrl 会 createObjectURL(blob)
  vi.stubGlobal("URL", Object.assign(URL, {
    createObjectURL: vi.fn(() => "blob:preview"),
    revokeObjectURL: vi.fn(),
  }));

  mocks.get.mockImplementation(async (url: string) => {
    if (String(url) === "/products/chain_link/media") {
      return { data: { items: ITEMS, media_kinds: KINDS } };
    }
    if (/^\/file-objects\/\d+\/content$/.test(String(url))) {
      return { data: new Blob([new Uint8Array(4)], { type: "image/png" }) };
    }
    throw new Error(`unexpected GET ${String(url)}`);
  });
  mocks.patch.mockResolvedValue({ data: {} });
  mocks.delete.mockResolvedValue({ data: {} });
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  document.body.innerHTML = "";
  root = null;
  container = null;
  client?.clear();
  client = null;
  vi.unstubAllGlobals();
});

describe("产品图库 · 排序入口", () => {
  it("不再有上移/下移按钮（排序一律拖拽）", async () => {
    mount(<ProductImagesSection productKey="chain_link" />);
    await settle();

    // 名称在输入框里（不在 textContent 中），所以按 aria-label 找
    expect(
      document.querySelector('input[aria-label="图片名称 2m×20m 成品图"]'),
    ).toBeTruthy();

    const text = document.body.textContent ?? "";
    expect(text).not.toContain("上移");
    expect(text).not.toContain("下移");
    // 拖拽的屏幕阅读器说明必须是中文（dnd-kit 默认英文，纯中文界面里很扎眼）
    expect(text).toContain("按空格键或回车键拾起");
    expect(text).not.toContain("To pick up a draggable item");
  });

  it("每张卡片都有拖动把手；主图的把手禁用（后端会把它顶回第一位，可拖就是假承诺）", async () => {
    mount(<ProductImagesSection productKey="chain_link" />);
    await settle();

    expect(buttonByLabel("主图固定第一位（换主图请点下方星标）").disabled).toBe(true);
    expect(buttonByLabel("拖动排序 侧面尺寸图").disabled).toBe(false);
    expect(buttonByLabel("拖动排序 卷装重量图").disabled).toBe(false);
  });
});

describe("产品图库 · 改名", () => {
  it("输入后按 Enter 才 PATCH；不打字不发请求", async () => {
    mount(<ProductImagesSection productKey="chain_link" />);
    await settle();

    const input = document.querySelector<HTMLInputElement>(
      'input[aria-label="图片名称 侧面尺寸图"]',
    )!;
    expect(mocks.patch).not.toHaveBeenCalled();

    setInputValue(input, "侧面尺寸图（2026 版）");
    // 只输入、不失焦、不回车 ⇒ 不写库（旧实现是 blur 静默写库，这里明确禁止）
    await settle();
    expect(mocks.patch).not.toHaveBeenCalled();

    keyDown(input, "Enter");
    await settle();

    expect(mocks.patch).toHaveBeenCalledTimes(1);
    expect(mocks.patch).toHaveBeenCalledWith("/file-objects/12", {
      name: "侧面尺寸图（2026 版）",
    });
  });

  it("Esc 撤回草稿，不写库", async () => {
    mount(<ProductImagesSection productKey="chain_link" />);
    await settle();

    const input = document.querySelector<HTMLInputElement>(
      'input[aria-label="图片名称 侧面尺寸图"]',
    )!;
    setInputValue(input, "打了一半");
    keyDown(input, "Escape");
    await settle();

    expect(input.value).toBe("侧面尺寸图");
    expect(mocks.patch).not.toHaveBeenCalled();
  });
});

describe("产品图库 · 移除", () => {
  it("先二次确认并说明可恢复；确认后才 DELETE", async () => {
    mount(<ProductImagesSection productKey="chain_link" />);
    await settle();

    click(buttonByLabel("移除 卷装重量图"));
    await settle();

    // 弹窗里必须说清"存档保留、可恢复"，否则用户不敢点
    expect(document.body.textContent).toContain("移除这张图片？");
    expect(document.body.textContent).toContain("存档");
    expect(mocks.delete).not.toHaveBeenCalled();

    const confirm = Array.from(document.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").trim() === "移除",
    );
    expect(confirm).toBeTruthy();
    click(confirm!);
    await settle();

    expect(mocks.delete).toHaveBeenCalledWith("/file-objects/13");
  });
});

describe("产品图库 · 大图查看", () => {
  it("点缩略图打开大图，显示位次，→/← 翻页", async () => {
    mount(<ProductImagesSection productKey="chain_link" />);
    await settle();

    click(buttonByLabel("查看大图 2m×20m 成品图"));
    await settle();
    expect(document.body.textContent).toContain("1 / 3");

    click(buttonByLabel("下一张"));
    await settle();
    expect(document.body.textContent).toContain("2 / 3");

    // ← 从第一张回绕到最后一张（列表很短，回绕比禁用更顺手）
    click(buttonByLabel("上一张"));
    await settle();
    click(buttonByLabel("上一张"));
    await settle();
    expect(document.body.textContent).toContain("3 / 3");
  });

  it("关闭预览后大图消失", async () => {
    mount(<ProductImagesSection productKey="chain_link" />);
    await settle();

    click(buttonByLabel("查看大图 卷装重量图"));
    await settle();
    expect(document.body.textContent).toContain("3 / 3");

    click(buttonByLabel("关闭预览"));
    await settle();
    expect(document.body.textContent).not.toContain("3 / 3");
  });
});
