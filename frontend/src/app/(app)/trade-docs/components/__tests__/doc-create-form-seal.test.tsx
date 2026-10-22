/**
 * 开单表单「盖公司默认公章」（2026-10-22）。
 *
 * 钉住：
 * 1. 勾选框**默认勾选**；
 * 2. 提交时 `with_seal` **始终显式带上**（默认 true；取消勾选后 false）——
 *    否则后端无法区分「用户取消盖章」和「老客户端没这个字段」。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { DocCreateForm } from "../doc-create-form";

const mocks = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock("../../hooks/use-trade-docs", () => ({
  useCreateTradeDoc: () => ({
    mutateAsync: mocks.create,
    isPending: false,
  }),
}));

vi.mock("@/lib/workstation/use-upstream", () => ({
  useOrderOptions: () => ({ data: [] }),
  useQuoteOptions: () => ({ data: [] }),
  toCustomerIdPayload: (id: number) => id,
}));

// CustomerPicker 是重型远程选择器；这里只关心「已选客户」之后表单的行为
vi.mock("@/components/customer-picker", () => ({
  CustomerPicker: ({
    onChange,
  }: {
    onChange: (v: { id: number; name: string }) => void;
  }) => (
    <button
      type="button"
      data-testid="pick-customer"
      onClick={() => onChange({ id: 5, name: "客户A" })}
    >
      选择客户
    </button>
  ),
}));

vi.mock("@/lib/trade-doc/render", () => ({
  getAvailableTemplates: () => [
    {
      doc_type: "ci",
      name_zh: "商业发票",
      name_en: "Commercial Invoice",
      description: "",
    },
  ],
}));

const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: (...a: unknown[]) => toastError(...a) },
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<DocCreateForm />));
}

async function settle(times = 6) {
  await act(async () => {
    for (let i = 0; i < times; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
}

function sealCheckbox(): HTMLInputElement {
  const label = Array.from(document.querySelectorAll("label")).find((l) =>
    (l.textContent ?? "").includes("盖公司默认公章"),
  );
  const input = label?.querySelector<HTMLInputElement>(
    'input[type="checkbox"]',
  );
  if (!input) throw new Error("没找到「盖公司默认公章」勾选框");
  return input;
}

function click(node: Element | null | undefined, label: string) {
  if (!node) throw new Error(`没找到${label}`);
  act(() => {
    node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

/** 父对象默认是「订单」但没有订单数据；切到「不关联（直接挂客户）」再提交。 */
function chooseSourceNone() {
  const select = document.querySelector("select");
  if (!select) throw new Error("没找到父对象选择器");
  const setter = Object.getOwnPropertyDescriptor(
    HTMLSelectElement.prototype,
    "value",
  )?.set;
  act(() => {
    setter?.call(select, "none");
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function submitButton(): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll("button")).find((b) =>
    (b.textContent ?? "").includes("开单（"),
  );
  if (!button) throw new Error("没找到开单按钮");
  return button as HTMLButtonElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.create.mockResolvedValue({ id: 1, doc_no: "CI-20260001" });
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  document.body.innerHTML = "";
  root = null;
  container = null;
});

describe("DocCreateForm · 盖公司默认公章", () => {
  it("默认勾选，提交时 with_seal:true", async () => {
    mount();
    expect(sealCheckbox().checked).toBe(true);

    click(
      document.querySelector('[data-testid="pick-customer"]'),
      "客户选择按钮",
    );
    await settle();
    chooseSourceNone();
    await settle();
    click(submitButton(), "开单按钮");
    await settle();

    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        doc_type: "ci",
        customer_id: 5,
        with_seal: true,
      }),
    );
  });

  it("取消勾选后提交 with_seal:false（显式传，不能省略）", async () => {
    mount();
    click(sealCheckbox(), "盖章勾选框");
    await settle(2);
    expect(sealCheckbox().checked).toBe(false);

    click(
      document.querySelector('[data-testid="pick-customer"]'),
      "客户选择按钮",
    );
    await settle();
    chooseSourceNone();
    await settle();
    click(submitButton(), "开单按钮");
    await settle();

    expect(mocks.create).toHaveBeenCalledTimes(1);
    const arg = mocks.create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg.with_seal).toBe(false);
  });
});
