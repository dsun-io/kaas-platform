/**
 * 「在报价中显示」开关乐观更新（2026-10-24 修复 2s 延迟）。
 *
 * 钉住两件事：
 * 1. 点击后 status 缓存**立刻**变（不等 POST / 重拉），checkbox 不再回弹 2 秒；
 * 2. POST 失败 → 缓存回滚到原值（不能假装成功）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}));

vi.mock("@/lib/api/client", () => {
  const client = {
    get: mocks.get,
    post: mocks.post,
    put: vi.fn(),
    delete: vi.fn(),
  };
  return { default: client, apiClient: client };
});

import {
  tenantProductKeys,
  useProductQuoteStatus,
  useSetProductQuoteEnabled,
  type ProductStatusRow,
} from "../tenant-products";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let client: QueryClient | null = null;

async function settle(times = 4) {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function Probe() {
  useProductQuoteStatus();
  const setEnabled = useSetProductQuoteEnabled();
  return (
    <button
      type="button"
      onClick={() =>
        setEnabled.mutate({ productKey: "deer_net", enabled: false })
      }
    >
      切到不在报价中显示
    </button>
  );
}

function mount() {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryData<ProductStatusRow[]>(tenantProductKeys.status, [
    { product_key: "deer_net", is_enabled: true },
  ]);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <QueryClientProvider client={client!}>
        <Probe />
      </QueryClientProvider>,
    );
  });
}

function readStatus(): ProductStatusRow[] {
  return (client?.getQueryData(tenantProductKeys.status) ??
    []) as ProductStatusRow[];
}

function click() {
  const button = Array.from(document.querySelectorAll("button"))[0];
  if (!button) throw new Error("没找到开关按钮");
  act(() => button.click());
}

beforeEach(() => {
  mocks.get.mockResolvedValue({
    data: { items: [{ product_key: "deer_net", is_enabled: true }] },
  });
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  document.body.innerHTML = "";
  client?.clear();
  root = null;
  container = null;
  client = null;
  vi.clearAllMocks();
});

describe("useSetProductQuoteEnabled 乐观更新", () => {
  it("点击后缓存立刻变（POST 还没返回也生效）", async () => {
    let release!: () => void;
    mocks.post.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ data: { is_enabled: false } });
        }),
    );
    mount();
    await settle();
    expect(
      readStatus().find((r) => r.product_key === "deer_net")?.is_enabled,
    ).toBe(true);

    click();
    await settle(3);
    // POST 未完成，但缓存已是新值
    expect(
      readStatus().find((r) => r.product_key === "deer_net")?.is_enabled,
    ).toBe(false);

    release();
    await settle();
    // onSettled 后会用 GET 重新对齐服务端真值（测试桩返回初始值 true），
    // 这里只断言请求契约；乐观值在上面已钉死。
    expect(mocks.post).toHaveBeenCalledWith(
      "/tenant-product-status",
      { product_key: "deer_net", is_enabled: false },
      { params: { workstation: "quote" } },
    );
  });

  it("POST 失败 → 回滚到原值", async () => {
    let reject!: (error: Error) => void;
    mocks.post.mockImplementation(
      () =>
        new Promise((_resolve, rejectFn) => {
          reject = rejectFn;
        }),
    );
    mount();
    await settle();

    click();
    await settle(3);
    expect(
      readStatus().find((r) => r.product_key === "deer_net")?.is_enabled,
    ).toBe(false);

    reject(new Error("404"));
    await settle();
    expect(
      readStatus().find((r) => r.product_key === "deer_net")?.is_enabled,
    ).toBe(true);
  });
});
