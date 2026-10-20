/**
 * 品名对照面板（C36 #19）—— 无后端组件测试。
 *
 * 覆盖：关键词搜索列表 / 新增（中英两行 POST）/ 重复预检拦截 / 后端冲突透出。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { NameMappingPanel } from "../name-mapping-panel";

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("@/lib/api/client", () => ({
  default: { get: mocks.get, post: mocks.post },
  apiClient: { get: mocks.get, post: mocks.post },
}));
const toastSuccess = vi.fn();
vi.mock("sonner", () => ({
  toast: { success: (...a: unknown[]) => toastSuccess(...a) },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const ROW = {
  id: 1,
  lang: "en",
  local_name: "chain link fence",
  region_code: "DE",
  category_id: 3,
  alt_names: ["malla"],
  hs_code: null,
  is_verified: true,
  confidence: null,
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let client: QueryClient | null = null;

async function settle(times = 4) {
  await act(async () => {
    for (let i = 0; i < times; i++) {
      await new Promise((r) => setTimeout(r, 0));
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

function setInput(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function setSelect(el: HTMLSelectElement, value: string) {
  act(() => {
    el.value = value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function clickButton(text: string) {
  const target = Array.from(document.querySelectorAll("button")).find(
    (b) => b.textContent?.replace("…", "").trim() === text,
  );
  if (!target) throw new Error(`没找到按钮「${text}」`);
  act(() => {
    target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockImplementation((url: string) => {
    if (url === "/market/regions") return Promise.resolve({ data: ["DE", "US"] });
    if (url.startsWith("/market/name-lookup")) {
      return Promise.resolve({ data: [] });
    }
    return Promise.resolve({ data: [] });
  });
});

afterEach(() => {
  unmount();
  document.body.innerHTML = "";
});

describe("NameMappingPanel", () => {
  it("输入关键词 → 调 name-lookup 并渲染已有对照", async () => {
    mocks.get.mockImplementation((url: string) => {
      if (url === "/market/regions") return Promise.resolve({ data: ["DE"] });
      if (url.startsWith("/market/name-lookup"))
        return Promise.resolve({ data: [ROW] });
      return Promise.resolve({ data: [] });
    });
    mount(<NameMappingPanel />);
    await settle();
    setInput(
      document.querySelector<HTMLInputElement>(
        'input[aria-label="搜索品名对照"]',
      )!,
      "chain link",
    );
    await settle();

    const text = document.body.textContent ?? "";
    expect(text).toContain("chain link fence");
    expect(text).toContain("英文 · DE · 类目 #3");
    const urls = mocks.get.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("/market/name-lookup?q=chain"))).toBe(
      true,
    );
  });

  it("新增：中英品名各自 POST 一行，成功后提示", async () => {
    mocks.post.mockImplementation(((_url: string, body: unknown) =>
      Promise.resolve({ data: { id: 9, ...(body as object) } })) as never);
    mount(<NameMappingPanel />);
    await settle();
    clickButton("新增对照");
    await settle();

    setInput(
      document.querySelector<HTMLInputElement>(
        'input[placeholder="例如：勾花网"]',
      )!,
      "勾花网",
    );
    setInput(
      document.querySelector<HTMLInputElement>(
        'input[placeholder="例如：chain link fence"]',
      )!,
      "chain link fence",
    );
    setSelect(
      document.querySelector<HTMLSelectElement>('select[aria-label="地区"]')!,
      "DE",
    );
    clickButton("保存对照");
    await settle();

    expect(mocks.post).toHaveBeenCalledTimes(2);
    const bodies = mocks.post.mock.calls.map(
      (c) => c[1] as Record<string, unknown>,
    );
    expect(bodies[0]).toMatchObject({
      lang: "zh",
      local_name: "勾花网",
      region_code: "DE",
      source: "manual",
    });
    expect(bodies[1]).toMatchObject({
      lang: "en",
      local_name: "chain link fence",
    });
    expect(toastSuccess).toHaveBeenCalledWith("已新增 2 条品名对照");
  });

  it("重复预检：已存在同地区/语言/品名 → 不 POST 并提示", async () => {
    mocks.get.mockImplementation((url: string) => {
      if (url === "/market/regions") return Promise.resolve({ data: ["DE"] });
      return Promise.resolve({
        data: [
          {
            ...ROW,
            lang: "zh",
            local_name: "勾花网",
            region_code: "DE",
            category_id: null,
          },
        ],
      });
    });
    mount(<NameMappingPanel />);
    await settle();
    clickButton("新增对照");
    await settle();
    setInput(
      document.querySelector<HTMLInputElement>(
        'input[placeholder="例如：勾花网"]',
      )!,
      "勾花网",
    );
    setSelect(
      document.querySelector<HTMLSelectElement>('select[aria-label="地区"]')!,
      "DE",
    );
    clickButton("保存对照");
    await settle();

    expect(mocks.post).not.toHaveBeenCalled();
    expect(document.body.textContent ?? "").toContain(
      "已存在：勾花网（中文 / DE），未提交",
    );
  });

  it("后端 409：唯一冲突如实透出（不吞成通用失败）", async () => {
    mocks.post.mockRejectedValue({
      response: {
        status: 409,
        data: {
          detail: {
            error: "conflict",
            code: "NAME_MAPPING_CONFLICT",
            detail: "同一地区 + 语言 + 类目已存在品名对照",
          },
        },
      },
    });
    mount(<NameMappingPanel />);
    await settle();
    clickButton("新增对照");
    await settle();
    setInput(
      document.querySelector<HTMLInputElement>(
        'input[placeholder="例如：勾花网"]',
      )!,
      "勾花网",
    );
    setSelect(
      document.querySelector<HTMLSelectElement>('select[aria-label="地区"]')!,
      "DE",
    );
    clickButton("保存对照");
    await settle();

    expect(document.body.textContent ?? "").toContain(
      "同一地区 + 语言 + 类目已存在品名对照",
    );
  });
});
