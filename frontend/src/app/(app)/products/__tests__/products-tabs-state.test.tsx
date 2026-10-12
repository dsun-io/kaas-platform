/**
 * P14 产品工位合并 · tab 切换保留状态（task-8）
 *
 * 用纯桩组件观察 tab 容器的「哪个 tab 可见」与「切换 tab 时 state 是否保留」。
 *
 * 为什么要单独一个文件、且不依赖真 tab 组件：`vi.mock` 是 hoisted 全局的，
 * 同一个模块做不到"某些用例用真身、某些用桩"（实测：tab 桩 mock 会把真组件
 * 一起换掉，导致读写用例拿不到真实 DOM）。所以这里只放纯桩用例；
 * 真 tab 组件的读写契约由 `products-redirect-and-definitions.test.tsx` 覆盖。
 *
 * 硬性行为守卫：两个 tab 内容都**始终挂载**（`hidden` 切换而非条件渲染）⇒
 * 切走再切回来，选中产品 / 表单输入 / JSON 文本框内容都还在。若某次改动把
 * `hidden` 换成条件渲染，状态就会在切换时丢失，用户填一半的表单无声蒸发。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import apiClient from "@/lib/api/client";

import ProductsWorkstationPage from "../page";

// ─── tab 内容桩：带本地 state 的输入框，用来观察「切换 tab 时 state 是否保留」 ───
function StubInput({ placeholder }: { placeholder: string }) {
  const [value, setValue] = useState("");
  return (
    <input
      placeholder={placeholder}
      value={value}
      onChange={(e) => setValue(e.target.value)}
    />
  );
}
vi.mock("../tabs/products-media-tab", () => ({
  ProductsMediaTab: () => (
    <div data-testid="stub-media">
      <StubInput placeholder="media-input" />
    </div>
  ),
}));
vi.mock("../tabs/products-definitions-tab", () => ({
  ProductsDefinitionsTab: () => (
    <div data-testid="stub-definitions">
      <StubInput placeholder="definitions-input" />
    </div>
  ),
}));

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

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
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

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function findInputByPlaceholder(placeholder: string): HTMLInputElement {
  const input = Array.from(
    container!.querySelectorAll<HTMLInputElement>(
      `input[placeholder="${placeholder}"]`,
    ),
  )[0];
  if (!input) throw new Error(`没找到 placeholder=「${placeholder}」的输入框`);
  return input;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(apiClient.get).mockResolvedValue(
    ok({ items: [], media_kinds: {} }),
  );
});

afterEach(() => {
  unmount();
});

describe("产品工位 tab 容器 · tab 切换保留状态", () => {
  it("切到「定义」tab 再切回「图片与基础信息」，两个 tab 的输入框内容都保留", async () => {
    mount(<ProductsWorkstationPage />);
    await settle();

    // 在「图片与基础信息」tab 里输入
    const mediaInput = findInputByPlaceholder("media-input");
    setInputValue(mediaInput, "我填的图名");
    await settle();
    expect(mediaInput.value).toBe("我填的图名");

    // 切到「定义」tab
    clickButton("定义");
    await settle();

    // 在「定义」tab 里也输入一个
    const defsInput = findInputByPlaceholder("definitions-input");
    setInputValue(defsInput, "我填的定义");
    await settle();

    // 切回「图片与基础信息」tab
    clickButton("图片与基础信息");
    await settle();

    // 两个 tab 的状态都还在（hidden 切换而非条件渲染 ⇒ state 不丢）
    expect(findInputByPlaceholder("media-input").value).toBe("我填的图名");
    expect(findInputByPlaceholder("definitions-input").value).toBe(
      "我填的定义",
    );
  });

  it("?tab=definitions 深链落到「定义」tab（与旧路由 redirect 的目标一致）", async () => {
    window.history.replaceState(null, "", "/products?tab=definitions");
    mount(<ProductsWorkstationPage />);
    await settle();

    const defsStub = container!.querySelector(
      '[data-testid="stub-definitions"]',
    );
    const mediaStub = container!.querySelector('[data-testid="stub-media"]');
    expect(defsStub).toBeTruthy();
    expect(mediaStub).toBeTruthy();
    const defsWrap = defsStub!.parentElement!;
    const mediaWrap = mediaStub!.parentElement!;
    expect(defsWrap.classList.contains("hidden")).toBe(false);
    expect(mediaWrap.classList.contains("hidden")).toBe(true);
  });

  it("?tab=media 或不带 ?tab= 落到「图片与基础信息」tab（默认）", async () => {
    window.history.replaceState(null, "", "/products");
    mount(<ProductsWorkstationPage />);
    await settle();

    const defsStub = container!.querySelector(
      '[data-testid="stub-definitions"]',
    );
    const mediaStub = container!.querySelector('[data-testid="stub-media"]');
    const defsWrap = defsStub!.parentElement!;
    const mediaWrap = mediaStub!.parentElement!;
    expect(mediaWrap.classList.contains("hidden")).toBe(false);
    expect(defsWrap.classList.contains("hidden")).toBe(true);
  });
});
