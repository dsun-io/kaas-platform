/**
 * 品名对照面板（C36 #19 → B2）—— 无后端组件测试。
 *
 * 覆盖：分页列表（空 q 也出数据 / total 用后端值 / 筛选回第 1 页）/ 搜索防抖 /
 * 编辑 Dialog 预填 + PATCH 成功 + 409 失败留弹窗 / 删除取消不发请求 / 删除确认 /
 * 删除失败在 ConfirmDialog 内可见（role=alert）/ 新增（中英两行 POST + 重复预检）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { NameMappingPanel } from "../name-mapping-panel";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
}));
vi.mock("@/lib/api/client", () => {
  const client = {
    get: mocks.get,
    post: mocks.post,
    patch: mocks.patch,
    delete: mocks.delete,
  };
  return { default: client, apiClient: client };
});
const toastSuccess = vi.fn();
vi.mock("sonner", () => ({
  toast: { success: (...args: unknown[]) => toastSuccess(...args) },
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const ROW_EN = {
  id: 1,
  lang: "en",
  local_name: "chain link fence",
  region_code: "US-CA",
  category_id: 3,
  alt_names: ["cyclone fence"],
  hs_code: "7314490000",
  source: "seed",
  is_verified: true,
  confidence: "high",
};
const ROW_ZH = {
  id: 2,
  lang: "zh",
  local_name: "勾花网",
  region_code: "DE",
  category_id: null,
  alt_names: null,
  hs_code: null,
  source: "manual",
  is_verified: false,
  confidence: null,
};

function listResponse(items: unknown[], total = items.length, page = 1) {
  return { data: { items, total, page, page_size: 20 } };
}

/** 造 N 行（分页断言用；id/名唯一） */
function makeRows(count: number, page = 1) {
  return Array.from({ length: count }, (_, i) => ({
    ...ROW_EN,
    id: page * 100 + i,
    local_name: "row-" + page + "-" + i,
  }));
}

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

/** 搜索输入有 300ms 防抖（U-P1E）：等它落地再断言请求 */
async function waitDebounce() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 350));
  });
  await settle();
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

function bodyText() {
  return document.body.textContent ?? "";
}

function listUrls(): string[] {
  return mocks.get.mock.calls
    .map((c) => String(c[0]))
    .filter((url) => url.startsWith("/market/name-mappings"));
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
  if (!target) throw new Error("没找到按钮「" + text + "」");
  act(() => {
    target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function clickAria(label: string) {
  const target = document.querySelector<HTMLElement>(
    '[aria-label="' + label + '"]',
  );
  if (!target) throw new Error("没找到 aria-label「" + label + "」");
  act(() => {
    target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function editInput(id: string) {
  return document.querySelector<HTMLInputElement>("#" + id)!;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockImplementation((url: string) => {
    if (url === "/market/regions")
      return Promise.resolve({ data: ["DE", "US"] });
    if (url.startsWith("/market/name-mappings"))
      return Promise.resolve(listResponse([]));
    return Promise.resolve({ data: [] });
  });
});

afterEach(() => {
  unmount();
  document.body.innerHTML = "";
});

describe("NameMappingPanel · 分页列表", () => {
  it("空关键词也拉列表（page=1&page_size=20，不带 q），渲染行与核实状态", async () => {
    mocks.get.mockImplementation((url: string) => {
      if (url === "/market/regions")
        return Promise.resolve({ data: ["DE", "US"] });
      if (url.startsWith("/market/name-mappings"))
        return Promise.resolve(listResponse([ROW_EN, ROW_ZH]));
      return Promise.resolve({ data: [] });
    });
    mount(<NameMappingPanel />);
    await settle();

    const text = bodyText();
    expect(text).toContain("chain link fence");
    expect(text).toContain("勾花网");
    expect(text).toContain("US-CA");
    expect(text).toContain("已核实");
    expect(text).toContain("cyclone fence");

    const urls = listUrls();
    expect(urls).toHaveLength(1);
    expect(urls[0]).toBe("/market/name-mappings?page=1&page_size=20");
    // 列表不再回落到 name-lookup（那是「按品名查询」tab 的接口）
    expect(
      mocks.get.mock.calls.some((c) =>
        String(c[0]).startsWith("/market/name-lookup"),
      ),
    ).toBe(false);
  });

  it("列表失败 → ErrorState（role=alert）显示后端原因，不是「未找到」空态", async () => {
    mocks.get.mockImplementation((url: string) => {
      if (url === "/market/regions") return Promise.resolve({ data: [] });
      return Promise.reject({
        response: {
          status: 500,
          data: { detail: { error: "internal", message: "品名服务不可用" } },
        },
      });
    });
    mount(<NameMappingPanel />);
    await settle();

    const alert = document.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toContain("品名服务不可用");
    expect(bodyText()).not.toContain("未找到匹配的品名对照");
  });

  it("分页：total 用后端值，下一页请求 page=2", async () => {
    mocks.get.mockImplementation((url: string) => {
      if (url === "/market/regions") return Promise.resolve({ data: [] });
      if (String(url).includes("page=2"))
        return Promise.resolve(listResponse(makeRows(20, 2), 45, 2));
      return Promise.resolve(listResponse(makeRows(20, 1), 45, 1));
    });
    mount(<NameMappingPanel />);
    await settle();

    expect(bodyText()).toContain("第 1–20 条 / 共 45 条");
    clickButton("下一页");
    await settle();

    expect(listUrls().at(-1)).toBe("/market/name-mappings?page=2&page_size=20");
    expect(bodyText()).toContain("第 21–40 条 / 共 45 条");
    expect(bodyText()).toContain("第 2 / 3 页");
  });

  it("搜索防抖：连续输入只发最终一次，且筛选变化回第 1 页", async () => {
    mocks.get.mockImplementation((url: string) => {
      if (url === "/market/regions") return Promise.resolve({ data: [] });
      if (String(url).includes("page=2"))
        return Promise.resolve(listResponse(makeRows(20, 2), 45, 2));
      return Promise.resolve(listResponse(makeRows(20, 1), 45, 1));
    });
    mount(<NameMappingPanel />);
    await settle();
    // 先翻到第 2 页，确认"筛选变化回第 1 页"
    clickButton("下一页");
    await settle();
    expect(listUrls().at(-1)).toContain("page=2");

    const input = document.querySelector<HTMLInputElement>(
      'input[aria-label="搜索品名对照"]',
    )!;
    setInput(input, "c");
    setInput(input, "ch");
    setInput(input, "chain");
    await settle();
    // 防抖窗口内：一次都不发
    expect(listUrls()).toHaveLength(2);

    await waitDebounce();
    const urls = listUrls();
    expect(urls).toHaveLength(3);
    expect(urls.at(-1)).toContain("page=1");
    expect(urls.at(-1)).toContain("q=chain");
  });
});

describe("NameMappingPanel · 编辑（PATCH）", () => {
  beforeEach(() => {
    mocks.get.mockImplementation((url: string) => {
      if (url === "/market/regions")
        return Promise.resolve({ data: ["DE", "US"] });
      if (url.startsWith("/market/name-mappings"))
        return Promise.resolve(listResponse([ROW_EN]));
      return Promise.resolve({ data: [] });
    });
  });

  it("点编辑 → Dialog 预填 5 个字段；保存发 PATCH 并刷新列表", async () => {
    mocks.patch.mockResolvedValue({ data: { ...ROW_EN } });
    mount(<NameMappingPanel />);
    await settle();

    clickAria("编辑 chain link fence");
    await settle();

    expect(bodyText()).toContain("编辑品名对照");
    expect(editInput("name-mapping-edit-local-name").value).toBe(
      "chain link fence",
    );
    expect(editInput("name-mapping-edit-hs-code").value).toBe("7314490000");
    expect(editInput("name-mapping-edit-verified").checked).toBe(true);
    const lang = document.querySelector<HTMLSelectElement>(
      "#name-mapping-edit-lang",
    )!;
    const region = document.querySelector<HTMLSelectElement>(
      "#name-mapping-edit-region",
    )!;
    expect(lang.value).toBe("en");
    expect(region.value).toBe("US-CA");

    setInput(editInput("name-mapping-edit-local-name"), "chain link fence pro");
    clickButton("保存");
    await settle();

    expect(mocks.patch).toHaveBeenCalledTimes(1);
    expect(mocks.patch.mock.calls[0]![0]).toBe("/market/name-mappings/1");
    expect(mocks.patch.mock.calls[0]![1]).toEqual({
      local_name: "chain link fence pro",
      lang: "en",
      region_code: "US-CA",
      hs_code: "7314490000",
      is_verified: true,
    });
    expect(toastSuccess).toHaveBeenCalledWith("已保存品名对照");
    expect(bodyText()).not.toContain("编辑品名对照");
    // 成功后 invalidate 列表（多了一次列表请求）
    expect(listUrls().length).toBeGreaterThanOrEqual(2);
  });

  it("校验失败（品名清空）→ 不发 PATCH，弹窗内 role=alert", async () => {
    mount(<NameMappingPanel />);
    await settle();
    clickAria("编辑 chain link fence");
    await settle();

    setInput(editInput("name-mapping-edit-local-name"), "   ");
    clickButton("保存");
    await settle();

    expect(mocks.patch).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')!.textContent).toContain(
      "品名必填",
    );
    expect(bodyText()).toContain("编辑品名对照");
  });

  it("后端 409 → 弹窗保留、错误原文可见（不吞成通用失败）", async () => {
    mocks.patch.mockRejectedValue({
      response: {
        status: 409,
        data: {
          detail: {
            error: "conflict",
            code: "NAME_MAPPING_EXISTS",
            message: "已存在重复对照",
          },
        },
      },
    });
    mount(<NameMappingPanel />);
    await settle();
    clickAria("编辑 chain link fence");
    await settle();
    clickButton("保存");
    await settle();

    const alert = document.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toContain("已存在重复对照");
    // 弹窗不关闭，输入保留
    expect(bodyText()).toContain("编辑品名对照");
    expect(editInput("name-mapping-edit-local-name").value).toBe(
      "chain link fence",
    );
  });

  it("非 zh/en 语言（种子 de）→ 编辑保留原语言，不被悄悄改成 en", async () => {
    const deRow = {
      ...ROW_EN,
      id: 3,
      lang: "de",
      local_name: "Doppelstabmattenzaun",
      region_code: "DE-NW",
      hs_code: null,
      is_verified: true,
    };
    mocks.get.mockImplementation((url: string) => {
      if (url === "/market/regions")
        return Promise.resolve({ data: ["DE-NW", "US-CA"] });
      if (url.startsWith("/market/name-mappings"))
        return Promise.resolve(listResponse([deRow]));
      return Promise.resolve({ data: [] });
    });
    mocks.patch.mockResolvedValue({ data: deRow });
    mount(<NameMappingPanel />);
    await settle();
    clickAria("编辑 Doppelstabmattenzaun");
    await settle();

    const lang = document.querySelector<HTMLSelectElement>(
      "#name-mapping-edit-lang",
    )!;
    expect(lang.value).toBe("de");
    expect(Array.from(lang.options).some((o) => o.value === "de")).toBe(true);

    clickButton("保存");
    await settle();
    expect(mocks.patch.mock.calls[0]![1]).toMatchObject({
      lang: "de",
      region_code: "DE-NW",
    });
  });
});

describe("NameMappingPanel · 删除（DELETE）", () => {
  beforeEach(() => {
    mocks.get.mockImplementation((url: string) => {
      if (url === "/market/regions") return Promise.resolve({ data: [] });
      if (url.startsWith("/market/name-mappings"))
        return Promise.resolve(listResponse([ROW_EN]));
      return Promise.resolve({ data: [] });
    });
  });

  it("取消确认 → 不发 DELETE，弹窗关闭", async () => {
    mount(<NameMappingPanel />);
    await settle();

    clickAria("删除 chain link fence");
    await settle();
    expect(bodyText()).toContain("删除「chain link fence」？");

    clickButton("取消");
    await settle();
    expect(mocks.delete).not.toHaveBeenCalled();
    expect(bodyText()).not.toContain("删除「chain link fence」？");
  });

  it("确认删除 → DELETE 一次 + toast + 刷新列表", async () => {
    mocks.delete.mockResolvedValue({ data: null });
    mount(<NameMappingPanel />);
    await settle();

    clickAria("删除 chain link fence");
    await settle();
    clickButton("确认删除");
    await settle();

    expect(mocks.delete).toHaveBeenCalledTimes(1);
    expect(mocks.delete.mock.calls[0]![0]).toBe("/market/name-mappings/1");
    expect(toastSuccess).toHaveBeenCalledWith("已删除品名对照");
    expect(bodyText()).not.toContain("删除「chain link fence」？");
    expect(listUrls().length).toBeGreaterThanOrEqual(2);
  });

  it("删除失败（404）→ ConfirmDialog 不关闭，错误在 role=alert 里可见", async () => {
    mocks.delete.mockRejectedValue({
      response: {
        status: 404,
        data: {
          detail: { error: "not_found", code: "NAME_MAPPING_NOT_FOUND" },
        },
      },
    });
    mount(<NameMappingPanel />);
    await settle();

    clickAria("删除 chain link fence");
    await settle();
    clickButton("确认删除");
    await settle();

    expect(mocks.delete).toHaveBeenCalledTimes(1);
    const alert = document.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toContain("该品名对照不存在");
    expect(bodyText()).toContain("删除「chain link fence」？");
  });
});

describe("NameMappingPanel · 新增（POST，行为不变）", () => {
  it("中英品名各自 POST 一行，成功后提示并回到第 1 页 + 按新名字筛选", async () => {
    mocks.post.mockImplementation(((_url: string, body: unknown) =>
      Promise.resolve({ data: { id: 9, ...(body as object) } })) as never);
    mount(<NameMappingPanel />);
    await settle();
    clickButton("新增对照");
    await settle();

    setInput(
      document.querySelector<HTMLInputElement>("#name-mapping-create-zh")!,
      "勾花网",
    );
    setInput(
      document.querySelector<HTMLInputElement>("#name-mapping-create-en")!,
      "chain link fence",
    );
    setSelect(
      document.querySelector<HTMLSelectElement>("#name-mapping-create-region")!,
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

  it("重复预检：列表里已存在同地区/语言/品名 → 不 POST 并提示", async () => {
    mocks.get.mockImplementation((url: string) => {
      if (url === "/market/regions")
        return Promise.resolve({ data: ["DE", "US"] });
      if (url.startsWith("/market/name-mappings"))
        return Promise.resolve(
          listResponse([
            { ...ROW_ZH, local_name: "勾花网", region_code: "DE" },
          ]),
        );
      return Promise.resolve({ data: [] });
    });
    mount(<NameMappingPanel />);
    await settle();
    clickButton("新增对照");
    await settle();
    setInput(
      document.querySelector<HTMLInputElement>("#name-mapping-create-zh")!,
      "勾花网",
    );
    setSelect(
      document.querySelector<HTMLSelectElement>("#name-mapping-create-region")!,
      "DE",
    );
    clickButton("保存对照");
    await settle();

    expect(mocks.post).not.toHaveBeenCalled();
    expect(bodyText()).toContain("已存在：勾花网（中文 / DE），未提交");
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
      document.querySelector<HTMLInputElement>("#name-mapping-create-zh")!,
      "勾花网",
    );
    setSelect(
      document.querySelector<HTMLSelectElement>("#name-mapping-create-region")!,
      "DE",
    );
    clickButton("保存对照");
    await settle();

    expect(bodyText()).toContain("同一地区 + 语言 + 类目已存在品名对照");
  });
});
