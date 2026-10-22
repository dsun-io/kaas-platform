/**
 * 报价台账 key 一致性（P0-B2/Q15）。
 *
 * 旧实现：列表 key = `["events","list",filters,"quotations"]`，
 * 新增成功却 invalidate `["quotations"]` —— 永远打不中，录入后列表不刷新。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));

vi.mock("@/lib/api/client", () => {
  const client = { get: mocks.get, post: mocks.post, patch: vi.fn() };
  return { default: client, apiClient: client };
});

import {
  quotationsListKey,
  useCreateQuotation,
  useQuotations,
} from "../use-quotations";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let client: QueryClient | null = null;

async function settle(times = 8) {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function Harness() {
  const { data } = useQuotations({});
  const create = useCreateQuotation();
  return (
    <>
      <span data-testid="total">{data?.total ?? -1}</span>
      <button
        type="button"
        onClick={() =>
          create.mutate({
            customer_id: "cust-1",
            product_category: "牛栏网",
            product_spec: {},
            quantity: 10,
            unit_price: null,
            status: "estimated",
            confidence: "high",
            discount: 0,
            notes: "",
          })
        }
      >
        create
      </button>
    </>
  );
}

function mount() {
  client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <QueryClientProvider client={client!}>
        <Harness />
      </QueryClientProvider>,
    );
  });
}

function unmount() {
  if (root) act(() => root!.unmount());
  container?.remove();
  document.body.innerHTML = "";
  root = null;
  container = null;
  client?.clear();
  client = null;
}

function listCalls() {
  return mocks.get.mock.calls.filter((c) => c[0] === "/quotations").length;
}

afterEach(() => {
  unmount();
  vi.restoreAllMocks();
});

describe("useQuotations / useCreateQuotation", () => {
  it("列表 key 与失效前缀同源（旧 key 打不中）", () => {
    expect(quotationsListKey({})).toEqual(["events", "list", {}, "quotations"]);
    expect(quotationsListKey({ customer_id: "c1" })).toEqual([
      "events",
      "list",
      { customer_id: "c1" },
      "quotations",
    ]);
  });

  it("新增成功后会真正重取列表（key 匹配）", async () => {
    vi.clearAllMocks();
    mocks.get.mockResolvedValue({ data: { items: [], total: 0 } });
    mocks.post.mockResolvedValue({ data: { id: "q-1", spec_hash: "h-1" } });
    mount();
    await settle();
    expect(listCalls()).toBe(1);

    const button = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent === "create",
    )!;
    await act(async () => {
      button.click();
    });
    await settle();

    expect(mocks.post).toHaveBeenCalledTimes(1);
    // invalidate 打中列表 key ⇒ 会重新请求一次
    expect(listCalls()).toBeGreaterThanOrEqual(2);
  });
});
