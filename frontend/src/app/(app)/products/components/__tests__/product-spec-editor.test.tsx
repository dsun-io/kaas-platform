/**
 * 产品规格可视化编辑器（S6.1）—— 数值参数 / 变体档位 / 派生公式 表单 + JSON 双向同步。
 *
 * 钉死口径（docs/archive/2026-10-20-closeout/PRODUCT_MODULE_MERGE_PLAN.md §5）：
 * 1. `specJson` 是**唯一真源** —— 表单改动生成新 JSON 写回（P14 约束保留）；
 * 2. 不按 Axis 设计（数值参数=连续值，变体=枚举档位）；
 * 3. JSON 语法错时表单**锁定**并提示，修正后解锁（不静默丢编辑）。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

import { ProductSpecEditor } from "../product-spec-editor";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let currentJson = "";
let onChangeCalls: string[] = [];

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

function mount(element: ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(element);
  });
}

function unmount() {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
}

function button(text: string): HTMLButtonElement {
  const buttons = Array.from(
    container!.querySelectorAll("button"),
  ) as HTMLButtonElement[];
  const target = buttons.find((b) => b.textContent?.trim() === text);
  if (!target) throw new Error(`没找到按钮「${text}」`);
  return target;
}

function clickButton(text: string) {
  act(() => {
    button(text).dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function tabButton(text: string) {
  clickButton(text);
}

function typeInLabel(labelText: string, value: string) {
  // 在 label 后面的同级 div 里找 input（结构：div > Label + Input）
  const labels = Array.from(container!.querySelectorAll("label"));
  const label = labels.find((l) => l.textContent?.trim() === labelText);
  if (!label) throw new Error(`没找到标签「${labelText}」`);
  const input = label.parentElement?.querySelector("input");
  if (!input) throw new Error(`标签「${labelText}」旁没有输入框`);
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** 宿主：用真 state 驱动（否则 onChange 后 prop 不回流，表单一直显示旧值）。 */
function Host({ initial }: { initial: string }) {
  const [json, setJson] = useState(initial);
  return (
    <ProductSpecEditor
      specJson={json}
      onChange={(next) => {
        setJson(next);
        currentJson = next;
        onChangeCalls.push(next);
      }}
      productKey="test_key"
    />
  );
}

/** 每次现场取 textarea —— React re-render 后旧引用可能已不在树上 */
function typeTextarea(value: string) {
  const textarea = container!.querySelector("textarea")!;
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  )!.set!;
  act(() => {
    setter.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function beforeEachMount(initialSpec: Record<string, unknown> = {}) {
  currentJson = JSON.stringify(initialSpec, null, 2);
  onChangeCalls = [];
  mount(<Host initial={currentJson} />);
}

beforeEach(() => {
  beforeEachMount({ key: "test_key", name: "测试产品" });
});

afterEach(() => {
  unmount();
});

describe("ProductSpecEditor S6.1 · 数值参数", () => {
  it("加参数 → specJson 里出现一项 numeric_inputs", async () => {
    clickButton("加参数");
    await settle();
    const spec = JSON.parse(currentJson) as {
      numeric_inputs: Array<{ key: string }>;
    };
    expect(spec.numeric_inputs).toHaveLength(1);
  });

  it("填字段 → specJson 逐字段同步（key/默认值）", async () => {
    clickButton("加参数");
    await settle();
    typeInLabel("字段名 key", "wire_d_mm");
    typeInLabel("默认值", "2.5");
    await settle();
    const spec = JSON.parse(currentJson) as {
      numeric_inputs: Array<{ key: string; default: number }>;
    };
    expect(spec.numeric_inputs[0]?.key).toBe("wire_d_mm");
    expect(spec.numeric_inputs[0]?.default).toBe(2.5);
  });

  it("删除参数 → specJson 里减少一项", async () => {
    clickButton("加参数");
    await settle();
    clickButton("加参数");
    await settle();
    expect(
      (JSON.parse(currentJson) as { numeric_inputs: unknown[] }).numeric_inputs,
    ).toHaveLength(2);
    // 两个删除按钮，各对应一项 —— 点最后一个
    const deletes = Array.from(
      container!.querySelectorAll("button"),
    ) as HTMLButtonElement[];
    const lastDelete = deletes
      .filter((b) => b.textContent?.includes("删除"))
      .pop()!;
    act(() => {
      lastDelete.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle();
    expect(
      (JSON.parse(currentJson) as { numeric_inputs: unknown[] }).numeric_inputs,
    ).toHaveLength(1);
  });
});

describe("ProductSpecEditor S6.1 · 变体与公式", () => {
  it("变体档位：加变体+加选项 → specJson 同步", async () => {
    clickButton("加变体");
    await settle();
    typeInLabel("字段名 key", "coating");
    typeInLabel("中文名", "表面处理");
    clickButton("加选项");
    await settle();
    const spec = JSON.parse(currentJson) as {
      variants: Array<{ name: string; label: string; options: unknown[] }>;
    };
    expect(spec.variants).toHaveLength(1);
    expect(spec.variants[0]?.name).toBe("coating");
    expect(spec.variants[0]?.label).toBe("表面处理");
    expect(spec.variants[0]?.options).toHaveLength(2); // 默认空选项 + 加的一个
  });

  it("派生公式：加公式 → specJson 同步 name/expr", async () => {
    tabButton("派生公式");
    await settle();
    clickButton("加公式");
    await settle();
    typeInLabel("指标名 key", "weight_kg");
    typeInLabel("公式 expr", "d**2 * 1.28");
    await settle();
    const spec = JSON.parse(currentJson) as {
      derived: Array<{ name: string; expr: string }>;
    };
    expect(spec.derived).toHaveLength(1);
    expect(spec.derived[0]?.name).toBe("weight_kg");
    expect(spec.derived[0]?.expr).toBe("d**2 * 1.28");
  });
});

describe("ProductSpecEditor S6.2 · 列 / 校验 / 扣减", () => {
  it("输出列：加列 + internal 勾选 → specJson 同步", async () => {
    tabButton("列 / 校验 / 扣减");
    await settle();
    clickButton("加列");
    await settle();
    typeInLabel("列 key（= 公式名）", "price.cost_pretax");
    typeInLabel("中文名", "税前成本");
    // internal checkbox
    const checkbox = container!.querySelector(
      'input[type="checkbox"]',
    ) as HTMLInputElement;
    act(() => {
      checkbox.click();
    });
    await settle();
    const spec = JSON.parse(currentJson) as {
      columns: Array<{ key: string; label: string; internal: boolean }>;
    };
    expect(spec.columns).toHaveLength(1);
    expect(spec.columns[0]?.key).toBe("price.cost_pretax");
    expect(spec.columns[0]?.label).toBe("税前成本");
    expect(spec.columns[0]?.internal).toBe(true);
  });

  it("校验规则：加规则 + severity 切换 → specJson 同步", async () => {
    tabButton("列 / 校验 / 扣减");
    await settle();
    clickButton("加规则");
    await settle();
    typeInLabel("规则名", "qty_positive");
    typeInLabel("表达式 expr", "qty > 0");
    const select = container!.querySelector("select") as HTMLSelectElement;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLSelectElement.prototype,
      "value",
    )!.set!;
    act(() => {
      setter.call(select, "warning");
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle();
    const spec = JSON.parse(currentJson) as {
      invariants: Array<{ name: string; expr: string; severity: string }>;
    };
    expect(spec.invariants).toHaveLength(1);
    expect(spec.invariants[0]?.name).toBe("qty_positive");
    expect(spec.invariants[0]?.expr).toBe("qty > 0");
    expect(spec.invariants[0]?.severity).toBe("warning");
  });

  it("空间扣减：改模式/比例 → specJson 同步", async () => {
    tabButton("列 / 校验 / 扣减");
    await settle();
    typeInLabel("扣减比例（0.04 = 4%）", "0.04");
    await settle();
    const spec = JSON.parse(currentJson) as {
      space_deduction: { mode: string; value: number };
    };
    expect(spec.space_deduction.mode).toBe("ratio");
    expect(spec.space_deduction.value).toBe(0.04);
  });
});

describe("ProductSpecEditor S6.3 · 参数 / 说明 / 常量", () => {
  it("参考参数：加行 + 填四个字段 → specJson 同步为 4 元组", async () => {
    tabButton("参数 / 说明 / 常量");
    await settle();
    clickButton("加参数");
    await settle();
    typeInLabel("参数", "原料进货成本");
    typeInLabel("取值", "客户每单填写");
    typeInLabel("单位", "元/㎡");
    typeInLabel("说明", "每天变动，由客户在报价时填");
    await settle();
    const spec = JSON.parse(currentJson) as {
      params: Array<[string, string, string, string]>;
    };
    expect(spec.params).toHaveLength(1);
    expect(spec.params[0]).toEqual([
      "原料进货成本",
      "客户每单填写",
      "元/㎡",
      "每天变动，由客户在报价时填",
    ]);
  });

  it("说明 notes：加行 + 填文本 → specJson 同步", async () => {
    tabButton("参数 / 说明 / 常量");
    await settle();
    clickButton("加一行");
    await settle();
    const input = container!.querySelector(
      'input[placeholder="一行说明"]',
    ) as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!;
    act(() => {
      setter.call(input, "重量公式逐字照搬智能表格");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settle();
    const spec = JSON.parse(currentJson) as { notes: string[] };
    expect(spec.notes).toEqual(["重量公式逐字照搬智能表格"]);
  });

  it("常量 constants：加常量 + 改值 → specJson 同步", async () => {
    tabButton("参数 / 说明 / 常量");
    await settle();
    // AddConstantRow 的 input 没有 label（用 placeholder 定位）
    const nameInput = container!.querySelector(
      'input[placeholder="新常量名（如 wire_factor）"]',
    ) as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!;
    act(() => {
      setter.call(nameInput, "wire_factor");
      nameInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    clickButton("加常量");
    await settle();
    const spec = JSON.parse(currentJson) as {
      constants: Record<string, number | string>;
    };
    expect(spec.constants["wire_factor"]).toBe(0);

    // 改值
    const valueInput = Array.from(
      container!.querySelectorAll("input:not([readonly])"),
    ).find((i) => (i as HTMLInputElement).value === "0") as HTMLInputElement;
    act(() => {
      setter.call(valueInput, "1.28");
      valueInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settle();
    const spec2 = JSON.parse(currentJson) as {
      constants: Record<string, number | string>;
    };
    expect(spec2.constants["wire_factor"]).toBe("1.28");
  });
});

describe("ProductSpecEditor P16 验收：逐字段 round-trip", () => {
  it("表单 → specJson → parse 后，未改动字段逐字段保持一致", async () => {
    // 完整 spec（覆盖 P16 三小步的全部字段）—— 这就是 IMPL_PLAN P16 的
    // 验收信号：表单 → API → DB → 回显 逐字段相等。
    const full = {
      key: "roundtrip",
      name: "回环产品",
      numeric_inputs: [
        {
          key: "d",
          label: "丝径",
          label_en: "Wire",
          unit: "mm",
          default: 2.5,
          min_value: 0.3,
          max_value: 8,
          decimals: 2,
          note: "重量公式里的 d",
        },
      ],
      variants: [
        {
          name: "coating",
          label: "表面处理",
          label_en: "Coating",
          options: [{ name: "普锌40g/㎡" }],
        },
      ],
      derived: [
        {
          name: "weight_kg",
          expr: "d**2 * 1.28",
          decimals: 4,
          integer: false,
          label: "单件重量",
          label_en: "Weight",
          unit: "kg",
          note: "口径说明",
        },
      ],
      columns: [
        {
          key: "weight_kg",
          label: "单件重量",
          label_en: "Weight",
          decimals: 4,
          internal: true,
          width: 14,
        },
      ],
      invariants: [{ name: "qty_pos", expr: "qty > 0", severity: "error" }],
      space_deduction: { mode: "ratio", value: 0.04, note: "装柜系数 0.96" },
      params: [["原料进货成本", "客户每单填写", "元/㎡", "每天变动"]],
      notes: ["重量公式逐字照搬智能表格"],
      constants: { wire_factor: "1.28" },
    };
    beforeEachMount(full);

    // 只改一个字段（数值参数的默认值）—— 其它应逐字段不变
    typeInLabel("默认值", "3.0");
    await settle();
    const result = JSON.parse(currentJson);
    expect(result.key).toBe("roundtrip");
    expect(result.name).toBe("回环产品");
    expect(result.numeric_inputs[0]).toMatchObject({
      key: "d",
      label: "丝径",
      label_en: "Wire",
      unit: "mm",
      min_value: 0.3,
      max_value: 8,
      decimals: 2,
      note: "重量公式里的 d",
    });
    expect(result.numeric_inputs[0].default).toBe(3.0); // 唯一改动的字段
    expect(result.variants).toEqual(full.variants);
    expect(result.derived).toEqual(full.derived);
    expect(result.columns).toEqual(full.columns);
    expect(result.invariants).toEqual(full.invariants);
    expect(result.space_deduction).toEqual(full.space_deduction);
    expect(result.params).toEqual(full.params);
    expect(result.notes).toEqual(full.notes);
    expect(result.constants).toEqual(full.constants);
  });
});

describe("ProductSpecEditor S6.1 · JSON 双向同步", () => {
  it("JSON 手改（实时写）后，specJson 立即更新", async () => {
    tabButton("高级 JSON");
    await settle();
    typeTextarea(JSON.stringify({ key: "k", numeric_inputs: [] }));
    await settle();
    expect(JSON.parse(currentJson).key).toBe("k");
  });

  it("JSON 语法错 → 表单锁定并提示；改对后解锁", async () => {
    tabButton("高级 JSON");
    await settle();
    typeTextarea("{ not valid json");
    await settle();
    expect(container!.textContent).toContain("语法错误");

    // 切回表单 tab，应显示锁定提示（坏 JSON 时不允许表单编辑覆盖）
    tabButton("数值参数 / 变体档位");
    await settle();
    expect(container!.textContent).toContain("表单已锁定");

    // 修好 JSON → 自动解锁
    tabButton("高级 JSON");
    await settle();
    typeTextarea(JSON.stringify({ key: "fixed" }));
    await settle();
    tabButton("数值参数 / 变体档位");
    await settle();
    expect(container!.textContent).not.toContain("表单已锁定");
    expect(JSON.parse(currentJson).key).toBe("fixed");
  });
});
