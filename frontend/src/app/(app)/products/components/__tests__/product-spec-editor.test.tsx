/**
 * 产品规格可视化编辑器（S6.1）—— 数值参数 / 变体档位 / 派生公式 表单 + JSON 双向同步。
 *
 * 钉死口径（PRODUCT_MODULE_MERGE_PLAN §5）：
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
