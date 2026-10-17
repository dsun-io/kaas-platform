/**
 * P14 产品工位合并 · 旧路由 redirect 与定义 tab 读写契约（task-8）
 *
 * 覆盖两件搬家后最可能悄悄坏掉的行为：
 *   1. **旧路由 redirect 落到正确 tab** —— `/settings/tenant-products` 必须落到
 *      `/products?tab=definitions`（不是 `/products` 默认 media tab），否则老书签
 *      用户会看到完全不同的界面，以为产品定义没了。
 *   2. **定义 tab 的读写契约与搬家前逐项一致** —— 读 `GET /tenant-products`、
 *      写 `PUT/POST/DELETE /tenant-products[/id]`，请求路径与请求体形状逐项不变；
 *      新建时初始 JSON `{"key":"","name":"","axes":[],"variants":[]}` 与 `is_system`
 *      行的"只读不给编辑/删除"行为也都原样保留。
 *
 * ⚠️ 范围说明：产品列表/基础信息那侧（`/products`、`PUT /products/{key}/profile`、
 * 上传/排序/主图/下线）的读写契约已由 `frontend/src/lib/products/__tests__/use-products.test.ts`
 * （13 tests）钉住 —— 搬家未改 `lib/products/use-products.ts` 一行 ⇒ 该文件的断言
 * 继续成立，本文件不重复。
 *
 * 为什么用 createRoot + act 而不是 testing-library：仓库没装 @testing-library，
 * vitest 环境是 jsdom 但无 setupFiles（见 vitest.config.ts）。
 *
 * 为什么本文件不做「tab 切换保留状态」用例：`vi.mock` 是 hoisted 全局的，
 * 同一个模块做不到"某些用例用真身、某些用桩"（实测：tab 桩 mock 会把真组件一起换掉，
 * 导致读写用例拿不到真实 DOM）。tab 切换保留状态由单独文件
 * `products-tabs-state.test.tsx` 用纯桩组件覆盖（它不依赖真 tab 组件）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import apiClient, { apiClient as namedApiClient } from "@/lib/api/client";

import { ProductsDefinitionsTab } from "../tabs/products-definitions-tab";
import TenantProductsRedirectPage from "../../settings/tenant-products/page";

// ⚠️ 双导出镜像：`lib/products/use-products.ts` 用 default 导入、
// `products-definitions-tab.tsx` 用 named `apiClient` 导入 ⇒ 断言时必须两条都查，
// 否则会漏掉一半请求（实测漏掉 named 侧 ⇒ "expected [] to include '/tenant-products'"）。
function getUrls(): string[] {
  return [
    ...vi.mocked(apiClient.get).mock.calls.map(([u]) => String(u)),
    ...vi.mocked(namedApiClient.get).mock.calls.map(([u]) => String(u)),
  ];
}

function putCalls() {
  return [
    ...vi.mocked(apiClient.put).mock.calls,
    ...vi.mocked(namedApiClient.put).mock.calls,
  ];
}

function postCalls() {
  return [
    ...vi.mocked(apiClient.post).mock.calls,
    ...vi.mocked(namedApiClient.post).mock.calls,
  ];
}

function deleteCalls() {
  return [
    ...vi.mocked(apiClient.delete).mock.calls,
    ...vi.mocked(namedApiClient.delete).mock.calls,
  ];
}

vi.mock("@/lib/api/client", () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  apiClient: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// 旧路由 redirect 用 useRouter().replace；mock 成 spy 以便断言目标
const replaceSpy = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceSpy, push: vi.fn() }),
}));

// React 18 act() 需要这个开关
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type GetResp = Awaited<ReturnType<typeof apiClient.get>>;
const ok = (data: unknown): GetResp => ({ data }) as unknown as GetResp;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let client: QueryClient | null = null;

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
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

function clickButton(text: string) {
  const buttons = Array.from(container!.querySelectorAll("button"));
  const target = buttons.find((b) => b.textContent?.trim() === text);
  if (!target) throw new Error(`没找到按钮「${text}」`);
  act(() => {
    target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  replaceSpy.mockClear();
  // ⚠️ default 与 named 两个 mock 都要灌值：`useQuery` 的 queryFn 用的是
  // `apiClient`（named）⇒ 只灌 default 的话数据永远是 undefined，表格渲染不出来
  // （实测表现为「没找到按钮『编辑』/『删除』」）。
  const empty = ok({ items: [], media_kinds: {} });
  vi.mocked(apiClient.get).mockResolvedValue(empty);
  vi.mocked(namedApiClient.get).mockResolvedValue(empty);
  const okResp = ok({});
  vi.mocked(apiClient.put).mockResolvedValue(okResp);
  vi.mocked(namedApiClient.put).mockResolvedValue(okResp);
  vi.mocked(apiClient.post).mockResolvedValue(okResp);
  vi.mocked(namedApiClient.post).mockResolvedValue(okResp);
  vi.mocked(apiClient.delete).mockResolvedValue(okResp);
  vi.mocked(namedApiClient.delete).mockResolvedValue(okResp);
});

afterEach(() => {
  unmount();
});

describe("旧路由 redirect · /settings/tenant-products → /products?tab=definitions", () => {
  it("挂载后调用 router.replace 到正确目标（带 tab=definitions，不是默认 media）", async () => {
    mount(<TenantProductsRedirectPage />);
    await settle();

    expect(replaceSpy).toHaveBeenCalledTimes(1);
    const target = replaceSpy.mock.calls[0]![0];
    const asString =
      typeof target === "string"
        ? target
        : `${(target as { pathname?: string }).pathname}?${new URLSearchParams(
            (target as { query?: Record<string, string> }).query ?? {},
          ).toString()}`;
    expect(asString).toBe("/products?tab=definitions");
    expect(asString).not.toBe("/products");
    expect(asString).not.toContain("tab=media");
  });
});

describe("读写行为与搬家前逐项一致（定义 tab 的读写契约）", () => {
  it("「定义」读 GET /tenant-products", async () => {
    // /tenant-products 返回数组（不是 {items: []}）；媒体 tab 的空响应不能共用
    const emptyRows = ok([]);
    vi.mocked(apiClient.get).mockResolvedValue(emptyRows);
    vi.mocked(namedApiClient.get).mockResolvedValue(emptyRows);

    mount(<ProductsDefinitionsTab />);
    await settle();

    const urls = getUrls();
    expect(urls).toContain("/tenant-products");
    // 定义 tab 不读 /products（那是另一个 tab 的契约）
    expect(urls).not.toContain("/products");
  });

  it("「定义」表单保存 → PUT /tenant-products/{id}，body 带 spec（JSON.parse 后）", async () => {
    const rows = ok([
      {
        id: 7,
        product_key: "chain_link",
        product_name: "勾花网",
        cost_field: "raw_price",
        cost_basis: "pretax",
        profit_mode: "margin_on_price",
        profit_value: 0.06,
        misc_fee_rate: 0.03,
        is_system: false,
        is_active: true,
      },
    ]);
    vi.mocked(apiClient.get).mockResolvedValue(rows);
    vi.mocked(namedApiClient.get).mockResolvedValue(rows);

    mount(<ProductsDefinitionsTab />);
    await settle();

    // 点「编辑」（非 is_system 行才有）
    clickButton("编辑");
    await settle();

    // 改 JSON（P16-S6.1：textarea 移到「高级 JSON」tab —— P14 原文"留给 P16"，
    // 换 tab 不变写入路径：specJson 仍是唯一真源）
    clickButton("高级 JSON");
    await settle();
    const textarea = container!.querySelector(
      "textarea",
    ) as HTMLTextAreaElement;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )!.set!;
      setter.call(
        textarea,
        '{"key":"chain_link","name":"勾花网","custom":"X"}',
      );
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settle();

    // 点「保存」
    clickButton("保存");
    await settle();

    const calls = putCalls();
    expect(calls).toHaveLength(1);
    const [url, body] = calls[0]!;
    expect(String(url)).toBe("/tenant-products/7");
    const payload = body as Record<string, unknown>;
    expect(payload).toMatchObject({
      id: 7,
      product_key: "chain_link",
      product_name: "勾花网",
    });
    // spec 是 JSON.parse 后的对象，不是字符串（搬家前后行为一致）
    expect(payload["spec"]).toEqual({
      key: "chain_link",
      name: "勾花网",
      custom: "X",
    });
  });

  it("「定义」新增产品 → POST /tenant-products（不带 id），body 带 spec", async () => {
    const empty = ok([]);
    vi.mocked(apiClient.get).mockResolvedValue(empty);
    vi.mocked(namedApiClient.get).mockResolvedValue(empty);

    mount(<ProductsDefinitionsTab />);
    await settle();

    clickButton("新增产品");
    await settle();

    // JSON 初始值：axes: [] 保留（P14 搬家前真实行为），
    // numeric_inputs/variants/derived 三段空初始值是 S6.1 编辑器的要求。
    clickButton("高级 JSON");
    await settle();
    const textarea = container!.querySelector(
      "textarea",
    ) as HTMLTextAreaElement;
    expect(textarea.value).toContain('"axes": []');

    clickButton("保存");
    await settle();

    const calls = postCalls();
    expect(calls).toHaveLength(1);
    const [url, body] = calls[0]!;
    expect(String(url)).toBe("/tenant-products");
    const payload = body as Record<string, unknown>;
    // 不带 id（POST 新建，不是 PUT 更新）
    expect(payload).not.toHaveProperty("id");
    expect(payload["spec"]).toEqual({
      key: "",
      name: "",
      axes: [],
      numeric_inputs: [],
      variants: [],
      derived: [],
    });
  });

  it("「定义」删除 → DELETE /tenant-products/{id}（非 is_system 行）", async () => {
    const rows = ok([
      {
        id: 3,
        product_key: "field_fence",
        product_name: "牛栏网",
        cost_field: "raw_price",
        cost_basis: "pretax",
        profit_mode: "margin_on_price",
        profit_value: 0.06,
        misc_fee_rate: 0.03,
        is_system: false,
        is_active: true,
      },
    ]);
    vi.mocked(apiClient.get).mockResolvedValue(rows);
    vi.mocked(namedApiClient.get).mockResolvedValue(rows);

    mount(<ProductsDefinitionsTab />);
    await settle();

    clickButton("删除");
    await settle();

    const calls = deleteCalls();
    expect(calls).toHaveLength(1);
    expect(String(calls[0]![0])).toBe("/tenant-products/3");
  });

  it("「定义」is_system 行不渲染「编辑/删除」按钮（与搬家前一致）", async () => {
    const rows = ok([
      {
        id: 9,
        product_key: "system_product",
        product_name: "系统级产品",
        cost_field: "raw_price",
        cost_basis: "pretax",
        profit_mode: "margin_on_price",
        profit_value: 0.06,
        misc_fee_rate: 0.03,
        is_system: true,
        is_active: true,
      },
    ]);
    vi.mocked(apiClient.get).mockResolvedValue(rows);
    vi.mocked(namedApiClient.get).mockResolvedValue(rows);

    mount(<ProductsDefinitionsTab />);
    await settle();

    const buttons = Array.from(container!.querySelectorAll("button")).map((b) =>
      b.textContent?.trim(),
    );
    expect(buttons).not.toContain("编辑");
    expect(buttons).not.toContain("删除");
    // 但「新增产品」按钮必须还在（全局动作，与 is_system 行无关）
    expect(buttons).toContain("新增产品");
  });
});
