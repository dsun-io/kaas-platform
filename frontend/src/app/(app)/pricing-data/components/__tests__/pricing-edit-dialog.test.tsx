/**
 * 定价「改价」弹窗（C36 #11）——表单校验与提交体形状。
 *
 * 契约对齐 `PATCH /api/v1/pricing-data/{item_id}`：金额>0、单位白名单、
 * 生效日期/备注可空、状态 active/inactive/deprecated；错误由调用方传入并原样展示。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import {
  PricingEditDialog,
  PRICING_UNITS,
  type PricingCellUpdate,
} from "../PricingEditDialog";
import type { PricingCell } from "@contracts/export-quote";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const CELL = {
  key: "wire:2.0:40",
  values: { wire: "2.0", zinc: "40" },
  labels: ["边丝径 2.0", "普锌 40g/㎡"],
  amount: 5.25,
  unit: "元/kg",
  item_id: 17,
  effective_from: "2026-09-01T00:00:00+00:00",
  source: "manual",
  notes: "旧备注",
  configured: true,
} as unknown as PricingCell;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function mount(ui: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(ui));
}

function clickButton(text: string) {
  const button = Array.from(document.querySelectorAll("button")).find(
    (b) => (b.textContent ?? "").trim() === text,
  );
  if (!button) throw new Error(`没找到按钮「${text}」`);
  act(() => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function setInput(selector: string, value: string, tag = "input") {
  const el = document.querySelector<HTMLInputElement | HTMLSelectElement>(
    selector,
  );
  if (!el) throw new Error(`没找到 ${selector}`);
  const proto =
    tag === "select" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => vi.clearAllMocks());

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  document.body.innerHTML = "";
  root = null;
  container = null;
});

describe("PricingEditDialog", () => {
  it("打开时回填当前值；合法输入按契约形状提交", () => {
    const onSubmit = vi.fn<(values: PricingCellUpdate) => void>();
    mount(
      <PricingEditDialog
        open
        onOpenChange={() => {}}
        cell={CELL}
        onSubmit={onSubmit}
      />,
    );

    const amount = document.querySelector<HTMLInputElement>("#pricing-amount");
    expect(amount?.value).toBe("5.25");
    expect(
      document.querySelector<HTMLInputElement>("#pricing-effective")?.value,
    ).toBe("2026-09-01");

    setInput("#pricing-amount", "6.5");
    setInput("#pricing-notes", "  客户 10 月调价  ");
    clickButton("保存修改");

    expect(onSubmit).toHaveBeenCalledWith({
      amount: 6.5,
      unit: "元/kg",
      effective_from: "2026-09-01",
      notes: "客户 10 月调价",
      status: "active",
    });
  });

  it("金额 <= 0 本地拦截，不发请求也不调用 onSubmit", () => {
    const onSubmit = vi.fn();
    mount(
      <PricingEditDialog
        open
        onOpenChange={() => {}}
        cell={CELL}
        onSubmit={onSubmit}
      />,
    );
    setInput("#pricing-amount", "0");
    clickButton("保存修改");

    expect(onSubmit).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "大于 0",
    );
  });

  it("后端 422/404 原因原样展示（调用方传入的 error）", () => {
    mount(
      <PricingEditDialog
        open
        onOpenChange={() => {}}
        cell={CELL}
        error="unit 取值不合法"
        onSubmit={() => {}}
      />,
    );
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      "unit 取值不合法",
    );
    // 单位白名单与后端逐字一致（防两边漂移）
    expect([...PRICING_UNITS]).toContain("元/kg");
    expect([...PRICING_UNITS]).not.toContain("元/t");
  });

  const UNCONFIGURED = {
    ...CELL,
    key: "wire:3.0",
    values: { wire: "3.0" },
    labels: ["边丝径 3.0"],
    amount: null,
    unit: "kg",
    item_id: null,
    effective_from: null,
    notes: null,
    configured: false,
    source: "product_default",
  } as unknown as PricingCell;

  it("配置模式（未配置行）：只填金额/单位，提交按 POST 契约形状", () => {
    const onSubmit = vi.fn<(values: PricingCellUpdate) => void>();
    mount(
      <PricingEditDialog
        open
        onOpenChange={() => {}}
        cell={UNCONFIGURED}
        onSubmit={onSubmit}
      />,
    );

    expect(document.body.textContent).toContain("配置成本");
    expect(document.body.textContent).toContain("尚未配置，当前用产品兜底");
    // 生效期/备注/状态是 PATCH 才有的事，配置模式不展示（避免"改了没生效"）
    expect(document.querySelector("#pricing-effective")).toBeNull();
    expect(document.querySelector("#pricing-notes")).toBeNull();
    expect(document.querySelector("#pricing-status")).toBeNull();

    setInput("#pricing-amount", "4.8");
    clickButton("保存成本");

    expect(onSubmit).toHaveBeenCalledWith({
      amount: 4.8,
      unit: "kg",
      effective_from: null,
      notes: null,
      status: "active",
    });
  });
});
