/**
 * 产品 + 税务档案区（从 product-quote-view 拆出）—— 拆分回归网。
 *
 * 拆分是「只搬 JSX，不动 state 与业务逻辑」：本测试只锁组件的对外行为
 * （props 事件回传 + 两层下拉的展示），防止后续改动把「换产品清结果」
 * 「选客户档案走 applyProfile」这些父组件逻辑的挂钩点弄丢。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

import { ProductTaxSection } from "../product-tax-section";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

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

function selectFirst(): HTMLSelectElement {
  return container!.querySelector("select") as HTMLSelectElement;
}

function setSelect(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLSelectElement.prototype,
    "value",
  )!.set!;
  act(() => {
    setter.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

afterEach(() => {
  unmount();
});

describe("ProductTaxSection", () => {
  it("产品下拉选值 → onProductChange 回传（父组件负责清结果/错误）", () => {
    const onProductChange = vi.fn();
    mount(
      <ProductTaxSection
        products={[
          { key: "field_fence", name: "牛栏网" },
          { key: "chain_link", name: "勾花网" },
        ]}
        productsLoading={false}
        effectiveProduct="field_fence"
        onProductChange={onProductChange}
        rateSets={[{ code: "cn", name: "中国" }]}
        profiles={[]}
        taxPick=""
        onTaxPickChange={vi.fn()}
        profileNotice={null}
        pickedProfile={null}
        savingOpen={false}
        onSavingOpenChange={vi.fn()}
        profileName=""
        onProfileNameChange={vi.fn()}
        onSaveProfile={vi.fn()}
        onDeleteProfile={vi.fn()}
        savePending={false}
        deletePending={false}
        effectiveRateSet="cn"
      />,
    );
    setSelect(selectFirst(), "chain_link");
    expect(onProductChange).toHaveBeenCalledWith("chain_link");
  });

  it("税务档案两层：客户档案 + 法定档案都在下拉里", () => {
    const onTaxPickChange = vi.fn();
    mount(
      <ProductTaxSection
        products={[]}
        productsLoading={false}
        effectiveProduct=""
        onProductChange={vi.fn()}
        rateSets={[{ code: "cn", name: "中国法定" }]}
        profiles={[{ id: 7, profile_name: "老客户那套" } as never]}
        taxPick=""
        onTaxPickChange={onTaxPickChange}
        profileNotice={null}
        pickedProfile={null}
        savingOpen={false}
        onSavingOpenChange={vi.fn()}
        profileName=""
        onProfileNameChange={vi.fn()}
        onSaveProfile={vi.fn()}
        onDeleteProfile={vi.fn()}
        savePending={false}
        deletePending={false}
        effectiveRateSet="cn"
      />,
    );
    // optgroup 的 label 是属性（不进 textContent），用选择器断言
    expect(
      container!.querySelector('optgroup[label="客户税率档案"]'),
    ).not.toBeNull();
    expect(
      container!.querySelector('optgroup[label="法定税务档案"]'),
    ).not.toBeNull();
    const text = container!.textContent ?? "";
    expect(text).toContain("老客户那套");
    expect(text).toContain("中国法定");

    const selects = container!.querySelectorAll("select");
    // 第二个 select 是税务档案
    setSelect(selects[1] as HTMLSelectElement, "profile:7");
    expect(onTaxPickChange).toHaveBeenCalledWith("profile:7");
  });
});
