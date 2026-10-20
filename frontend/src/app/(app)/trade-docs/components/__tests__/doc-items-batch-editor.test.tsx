import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import fxSample from "@/lib/trade-doc/sample-data-fx.json";

import { DocItemsBatchEditor } from "../doc-items-batch-editor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 真实样例：3 行 / 汇率 6.7029 / 内陆运费 750（与 A5-W3 同一向量） */
const REAL_ITEMS = [
  { product_name: "Y-Type Fence Post", qty: 400, qty_unit: "pc", unit_price: 25.0, line_amount: 10000 },
  {
    product_name: "Field Fence (Cattle Fence)",
    qty: 20,
    qty_unit: "roll",
    unit_price: 366.3075,
    line_amount: 7326.15,
  },
  {
    product_name: "Electric Fence Support Insulator",
    qty: 400,
    qty_unit: "pc",
    unit_price: 2.18,
    line_amount: 872,
  },
];

const DATA: Record<string, unknown> = {
  ...(fxSample.base as unknown as Record<string, unknown>),
  rounding_adjustment_cny: -2.54,
  rounding_adjustment_usd: -0.37,
  total_goods_value_cny: 18195.66,
  total_goods_value_usd: 2714.6,
  inland_freight_cny: 750,
  items: REAL_ITEMS,
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function text() {
  return container!.textContent ?? "";
}

function button(label: string) {
  return Array.from(container!.querySelectorAll("button")).find((el) =>
    (el.textContent ?? "").includes(label),
  );
}

function rowCheckbox(row: number) {
  return container!.querySelector<HTMLInputElement>(
    `input[aria-label="选择第 ${row} 行"]`,
  );
}

function selectAll() {
  return container!.querySelector<HTMLInputElement>('input[aria-label="全选行项"]')!;
}

async function typeValue(value: string) {
  const input = container!.querySelector<HTMLInputElement>('input[aria-label="批量新值"]')!;
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(el: Element) {
  await act(async () => {
    (el as HTMLElement).click();
  });
}

function mount(
  overrides: Partial<Parameters<typeof DocItemsBatchEditor>[0]> = {},
) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      <DocItemsBatchEditor
        docType="pi"
        status="draft"
        data={DATA}
        initialOverride={[]}
        {...overrides}
      />,
    ),
  );
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("DocItemsBatchEditor · 多选 / 预览 / 一次保存 / 撤销", () => {
  it("初始：渲染 3 行、未选中无批量条；金额列只读；未接入保存通道时如实标注", () => {
    mount();

    expect(text()).toContain("行项批量编辑");
    expect(text()).toContain("Y-Type Fence Post");
    expect(text()).toContain("Field Fence (Cattle Fence)");
    // 未选中不出批量条
    expect(container!.querySelector('input[aria-label="批量新值"]')).toBeNull();
    // 行金额列只有文本"只读"，没有可编辑 input（除勾选框外无 input）
    const inputs = Array.from(container!.querySelectorAll("input"));
    expect(inputs.every((el) => el.type === "checkbox")).toBe(true);
    expect(text()).toContain("未接入保存通道");
  });

  it("勾选 2 行 + 输入新单价 ⇒ 预览受影响行数与金额变化（真实样例数字）", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    mount({ onSave });

    await click(rowCheckbox(1)!);
    await click(rowCheckbox(3)!);
    expect(text()).toContain("已选 2 / 3 行");

    await typeValue("26.5");

    expect(text()).toContain("将影响 2 行");
    // 行合计：18,198.20 → 28,526.20 CNY（+10,328.00），USD 同步
    expect(text()).toContain("18,198.20");
    expect(text()).toContain("28,526.20");
    expect(text()).toContain("+10,328.00");
    expect(button("保存（2 行，一次提交）")).toBeTruthy();
    // 只是预览，还没调用保存
    expect(onSave).not.toHaveBeenCalled();
  });

  it("点保存 ⇒ 一次 onSave 带契约 override；成功后如实显示「已保存」且行金额同步", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    mount({ onSave });

    await click(rowCheckbox(1)!);
    await click(rowCheckbox(3)!);
    await typeValue("26.5");
    await act(async () => {
      button("保存（2 行，一次提交）")!.click();
      await Promise.resolve();
    });

    expect(onSave).toHaveBeenCalledTimes(1);
    // 契约：只含变化行/字段，绝不带金额键
    expect(onSave).toHaveBeenCalledWith([
      { index: 0, unit_price: 26.5 },
      { index: 2, unit_price: 26.5 },
    ]);
    expect(text()).toContain("已保存");
    expect(text()).toContain("未确认");
    // 行金额由 qty×price 重算：行 1 = 400×26.5 = 10,600
    expect(text()).toContain("10600");
  });

  it("撤销 ⇒ 再发一次 onSave（空 override = 回到无覆盖）并恢复表格", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    mount({ onSave });

    await click(rowCheckbox(1)!);
    await typeValue("26.5");
    await act(async () => {
      button("保存（1 行，一次提交）")!.click();
      await Promise.resolve();
    });
    expect(onSave).toHaveBeenLastCalledWith([{ index: 0, unit_price: 26.5 }]);

    await act(async () => {
      button("撤销")!.click();
      await Promise.resolve();
    });
    expect(onSave).toHaveBeenCalledTimes(2);
    expect(onSave).toHaveBeenLastCalledWith([]);
    // 恢复原值
    expect(text()).toContain("25");
  });

  it("保存失败 ⇒ 如实显示后端错误码，不出现「已保存」", async () => {
    const onSave = vi.fn().mockRejectedValue({
      response: {
        status: 422,
        data: {
          detail: {
            error: "validation",
            code: "ITEMS_OVERRIDE_DRAFT_ONLY",
            detail: "行项覆盖仅允许 draft 单提交（已签发/作废单内容冻结）",
          },
        },
      },
    });
    mount({ onSave });

    await click(rowCheckbox(1)!);
    await typeValue("26.5");
    await act(async () => {
      button("保存（1 行，一次提交）")!.click();
      await Promise.resolve();
    });

    expect(text()).toContain("未保存");
    expect(text()).toContain("ITEMS_OVERRIDE_DRAFT_ONLY");
    expect(text()).not.toContain("已保存 2");
  });

  it("非法值拦截：数量 0 / 负单价 / 带千分位 —— 保存按钮禁用并显示原因", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    mount({ onSave });
    await click(rowCheckbox(1)!);

    const select = container!.querySelector<HTMLSelectElement>('select[aria-label="批量字段"]')!;
    async function chooseField(value: string) {
      await act(async () => {
        select.value = value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
    }

    await chooseField("qty");
    await typeValue("0");
    expect(text()).toContain("数量须为正数");
    expect(button("保存")!.hasAttribute("disabled")).toBe(true);

    await chooseField("unit_price");
    await typeValue("-1");
    expect(text()).toContain("单价不能为负");
    expect(button("保存")!.hasAttribute("disabled")).toBe(true);

    await typeValue("1,000");
    expect(text()).toContain("不要带千分位");
    expect(button("保存")!.hasAttribute("disabled")).toBe(true);
  });

  it("无变更：新值 == 当前值 ⇒ 提示没有变化且不能保存", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    mount({ onSave });
    await click(rowCheckbox(1)!);
    await typeValue("25");
    expect(text()).toContain("没有变化");
    expect(button("保存")!.hasAttribute("disabled")).toBe(true);
  });

  it("全选 / 半选（indeterminate）/ 清空", async () => {
    mount({ onSave: vi.fn().mockResolvedValue(undefined) });
    expect(selectAll().checked).toBe(false);

    await click(rowCheckbox(1)!);
    expect(selectAll().indeterminate).toBe(true);
    expect(selectAll().checked).toBe(false);

    await click(selectAll());
    expect(selectAll().checked).toBe(true);
    expect(selectAll().indeterminate).toBe(false);
    expect(text()).toContain("已选 3 / 3 行");

    await click(selectAll());
    expect(text()).toContain("已选 0 / 3 行");
  });

  it("非 draft（已签发/冻结）⇒ 选择与输入全禁用，并提示已冻结", () => {
    mount({ status: "issued" });
    expect(text()).toContain("行项已冻结，不可批量修改");
    expect(rowCheckbox(1)!.disabled).toBe(true);
    expect(selectAll().disabled).toBe(true);
  });
});
