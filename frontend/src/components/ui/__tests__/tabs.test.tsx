/**
 * ui/tabs 组件行为测试。
 *
 * 钉死的硬语义（P14 约束上提到组件层）：
 * 1. 默认 keepMounted —— 切走再切回，panel 内组件状态（如输入框内容）不丢；
 * 2. 受控模式：onValueChange 回传新值，由调用方决定切换（深链 ?tab= 场景）；
 * 3. 未选中的 panel 只是 hidden，不是卸载。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "../tabs";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function mount(element: React.ReactNode) {
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

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

function tabButton(text: string): HTMLButtonElement {
  const buttons = Array.from(
    container!.querySelectorAll("[data-slot='tabs-trigger']"),
  );
  const target = buttons.find((b) => b.textContent?.trim() === text);
  if (!target) throw new Error(`没找到 tab「${text}」`);
  return target as HTMLButtonElement;
}

function clickTab(text: string) {
  act(() => {
    tabButton(text).dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function panel(value: string): HTMLElement | null {
  return container!.querySelector(
    `[data-slot='tabs-content'][data-value='${value}']`,
  );
}

/** 受控用法（深链 ?tab= 场景同构）：value 由外部 state 管 */
function ControlledTabs() {
  const [tab, setTab] = useState("a");
  return (
    <Tabs value={tab} onValueChange={setTab}>
      <TabsList>
        <TabsTrigger value="a">甲</TabsTrigger>
        <TabsTrigger value="b">乙</TabsTrigger>
      </TabsList>
      <TabsContent value="a">
        <input placeholder="a-input" />
      </TabsContent>
      <TabsContent value="b">内容B</TabsContent>
    </Tabs>
  );
}

beforeEach(() => {
  mount(<ControlledTabs />);
});

afterEach(() => {
  unmount();
});

describe("ui/tabs", () => {
  it("默认切换生效（受控值更新，选中态落到对应 panel）", async () => {
    expect(tabButton("甲").getAttribute("aria-selected")).toBe("true");
    clickTab("乙");
    await settle();
    expect(tabButton("乙").getAttribute("aria-selected")).toBe("true");
    expect(panel("b")?.hasAttribute("hidden")).toBe(false);
  });

  it("keepMounted：切走再切回，panel 内输入状态保留", async () => {
    const input = container!.querySelector(
      "input[placeholder='a-input']",
    ) as HTMLInputElement;
    // 通过原生 setter 触发 React 受控更新
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!;
    act(() => {
      setter.call(input, "草稿一半");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    clickTab("乙");
    await settle();
    // a panel 仍在 DOM 里（只是 hidden）—— 这是「状态不丢」的前提
    expect(panel("a")).not.toBeNull();
    expect(panel("a")!.hasAttribute("hidden")).toBe(true);

    clickTab("甲");
    await settle();
    expect(
      (
        container!.querySelector(
          "input[placeholder='a-input']",
        ) as HTMLInputElement
      ).value,
    ).toBe("草稿一半");
  });

  it("keepMounted={false} 才条件卸载 panel", async () => {
    unmount();
    mount(
      <Tabs defaultValue="a">
        <TabsList>
          <TabsTrigger value="a">甲</TabsTrigger>
          <TabsTrigger value="b">乙</TabsTrigger>
        </TabsList>
        <TabsContent value="a" keepMounted={false}>
          内容A
        </TabsContent>
        <TabsContent value="b" keepMounted={false}>
          内容B
        </TabsContent>
      </Tabs>,
    );
    expect(panel("b")).toBeNull();
    clickTab("乙");
    await settle();
    expect(panel("a")).toBeNull();
  });

  it("pills 变体渲染胶囊容器", () => {
    unmount();
    mount(
      <Tabs defaultValue="a">
        <TabsList variant="pills">
          <TabsTrigger variant="pills" value="a">
            甲
          </TabsTrigger>
        </TabsList>
        <TabsContent value="a">内容A</TabsContent>
      </Tabs>,
    );
    const list = container!.querySelector("[data-slot='tabs-list']");
    expect(list?.className).toContain("border");
  });
});
