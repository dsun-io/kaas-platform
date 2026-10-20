/**
 * 调研「手工录入」弹窗（C36 #22）—— 无后端组件测试。
 *
 * 覆盖：必填校验（产品名或线索）/ 手工录入 POST body / 从线索挑选（source_ref）/
 * 409 ALREADY_PICKED 专属提示。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

import { ManualResearchDialog } from "../manual-research-dialog";

const mocks = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock("@/lib/api/client", () => ({
  default: { post: mocks.post },
  apiClient: { post: mocks.post },
}));
const toastSuccess = vi.fn();
vi.mock("sonner", () => ({
  toast: { success: (...a: unknown[]) => toastSuccess(...a) },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const LEADS = [
  { id: 9, company_name: "ABC Fence", product_name: "chain link fence", product_name_cn: "勾花网", country: "DE", city: "Berlin" },
  { id: 10, company_name: "XYZ Mesh", product_name: null, product_name_cn: null, country: null, city: null },
];

let root: Root | null = null;
let container: HTMLDivElement | null = null;

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
  root = createRoot(container);
  act(() => root!.render(element));
}

function unmount() {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
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

function renderDialog(
  onCreated = vi.fn(),
  onOpenChange = vi.fn(),
): { onCreated: ReturnType<typeof vi.fn>; onOpenChange: ReturnType<typeof vi.fn> } {
  mount(
    <ManualResearchDialog
      open
      onOpenChange={onOpenChange}
      categories={["gabion", "chain_link_fence"]}
      leads={LEADS}
      onCreated={onCreated}
    />,
  );
  return { onCreated, onOpenChange };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.post.mockResolvedValue({ data: { id: 1 } });
});

afterEach(() => {
  unmount();
  document.body.innerHTML = "";
});

describe("ManualResearchDialog", () => {
  it("产品名与线索都没填 → 本地校验拦住，不发请求", async () => {
    renderDialog();
    await settle();
    clickButton("加入调研集");
    await settle();

    expect(mocks.post).not.toHaveBeenCalled();
    expect(document.body.textContent ?? "").toContain(
      "产品名或「从线索挑选」至少填一个",
    );
  });

  it("手工录入：POST 只带有值字段，成功后 onCreated", async () => {
    const { onCreated, onOpenChange } = renderDialog();
    await settle();
    setInput(
      document.querySelector<HTMLInputElement>(
        'input[placeholder="不选线索时必填，如 chain link fence"]',
      )!,
      "chain link fence",
    );
    setInput(
      document.querySelector<HTMLInputElement>('input[placeholder="如 勾花网"]')!,
      "勾花网",
    );
    setSelect(
      document.querySelector<HTMLSelectElement>('select[aria-label="类目"]')!,
      "chain_link_fence",
    );
    setInput(
      document.querySelector<HTMLInputElement>('input[placeholder="如 DE"]')!,
      "DE",
    );
    clickButton("加入调研集");
    await settle();

    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(mocks.post.mock.calls[0]![0]).toBe("/research/products");
    expect(mocks.post.mock.calls[0]![1]).toEqual({
      product_name: "chain link fence",
      product_name_cn: "勾花网",
      product_category: "chain_link_fence",
      country: "DE",
    });
    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(toastSuccess).toHaveBeenCalledWith("已加入调研集");
  });

  it("从线索挑选：只传 source_ref，产品名由后端回填也不报必填", async () => {
    renderDialog();
    await settle();
    setSelect(
      document.querySelector<HTMLSelectElement>(
        'select[aria-label="从线索挑选"]',
      )!,
      "9",
    );
    clickButton("加入调研集");
    await settle();

    expect(mocks.post).toHaveBeenCalledWith("/research/products", {
      source_ref: 9,
    });
  });

  it("409 ALREADY_PICKED：透出 research_id 专属文案，弹窗不关闭", async () => {
    mocks.post.mockRejectedValue({
      response: {
        status: 409,
        data: {
          detail: { error: "conflict", code: "ALREADY_PICKED", research_id: 12 },
        },
      },
    });
    const { onOpenChange, onCreated } = renderDialog();
    await settle();
    setSelect(
      document.querySelector<HTMLSelectElement>(
        'select[aria-label="从线索挑选"]',
      )!,
      "9",
    );
    clickButton("加入调研集");
    await settle();

    expect(document.body.textContent ?? "").toContain(
      "该线索已在调研集中（调研产品 #12），不能重复挑选",
    );
    expect(onCreated).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
