/**
 * 公式试算（S6.3-b）—— /explain + spec_override 的草稿定义自证。
 *
 * 钉死口径（docs/archive/2026-10-20-closeout/PRODUCT_MODULE_MERGE_PLAN.md §5）：
 * 1. 试算走 `POST /export-quote/products/{key}/explain`，body 带
 *    `spec_override`（当前草稿）—— **不新建接口**；
 * 2. 取值来自 numeric_inputs 默认值 + variants 首选项；
 * 3. 结果（steps/公式/结果/单位）与错误都展示；产品 key 为空时禁用按钮。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ProductSpecTryout } from "../product-spec-tryout";

const mocks = vi.hoisted(() => ({
  post: vi.fn(),
}));

vi.mock("@/lib/api/client", () => ({
  default: { post: mocks.post },
  apiClient: { post: mocks.post },
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const SPEC = {
  key: "test_key",
  numeric_inputs: [{ key: "d", label: "丝径", default: 2.5 }],
  variants: [
    { name: "coating", label: "表面处理", options: [{ name: "普锌40g/㎡" }] },
  ],
  derived: [{ name: "weight_kg", expr: "d**2 * 1.28", label: "单件重量" }],
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let client: QueryClient | null = null;

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

async function settle(times = 3) {
  await act(async () => {
    for (let i = 0; i < times; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
  });
}

function clickButton(text: string) {
  const buttons = Array.from(
    document.querySelectorAll("button"),
  ) as HTMLButtonElement[];
  const target = buttons.find((b) => b.textContent?.includes(text));
  if (!target) throw new Error(`没找到按钮「${text}」`);
  act(() => {
    target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  unmount();
});

describe("ProductSpecTryout", () => {
  it("试算按钮点开弹窗，发送 spec_override 并展示步骤", async () => {
    mocks.post.mockResolvedValue({
      data: {
        ok: true,
        steps: [
          {
            name: "weight_kg",
            label: "单件重量",
            expr: "d**2 * 1.28",
            value: 8,
            unit: "kg",
          },
        ],
      },
    });
    mount(<ProductSpecTryout productKey="test_key" spec={SPEC} />);
    await settle();

    clickButton("公式试算");
    await settle();
    expect(document.body.textContent).toContain("公式试算（草稿定义，不落库）");

    clickButton("开始试算");
    await settle();

    expect(mocks.post).toHaveBeenCalledTimes(1);
    const [url, body] = mocks.post.mock.calls[0]!;
    expect(String(url)).toBe("/export-quote/products/test_key/explain");
    // body 带 spec_override（草稿定义）+ spec（取值用默认/首选）
    const payload = body as {
      spec: Record<string, unknown>;
      spec_override: Record<string, unknown>;
    };
    expect(payload.spec_override).toMatchObject({ key: "test_key" });
    expect(payload.spec.d).toBe(2.5); // numeric 默认值
    expect(payload.spec.coating).toBe("普锌40g/㎡"); // variant 首选项

    expect(document.body.textContent).toContain("单件重量");
    expect(document.body.textContent).toContain("d**2 * 1.28");
    expect(document.body.textContent).toContain("8");
  });

  it("产品 key 为空时试算按钮禁用", () => {
    mount(<ProductSpecTryout productKey="" spec={SPEC} />);
    const button = Array.from(document.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("公式试算"),
    ) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("试算失败（公式错）→ 显示错误文案", async () => {
    mocks.post.mockRejectedValue({
      response: { data: { message: "invalid_numeric" } },
    });
    mount(<ProductSpecTryout productKey="test_key" spec={SPEC} />);
    await settle();
    clickButton("公式试算");
    await settle();
    clickButton("开始试算");
    await settle();
    expect(document.body.textContent).toContain("invalid_numeric");
  });
});
