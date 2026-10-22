/**
 * C26 · a11y 深水项（A10 skip-link / main id；A9 单选组 radiogroup）。
 *
 * 钉死的三件事：
 *   1. 应用外壳有「跳到主内容」skip-link，`href="#main"`（默认 sr-only，焦点时浮出）；
 *   2. 主内容容器是 `<main id="main" tabIndex=-1>`（tabIndex 才会真正接管焦点）；
 *   3. 仪表盘时间范围是**单选组**：role=radiogroup + role=radio/aria-checked，
 *      点击后 aria-checked 跟随受控 state 变化（不是互斥 aria-pressed 切换按钮）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

// 外壳依赖 Sidebar/Header（各自带 Provider/路由）；本测试只验证外壳骨架的 a11y 标记。
vi.mock("../sidebar", () => ({
  Sidebar: () => <div data-testid="sidebar" />,
}));
vi.mock("../header", () => ({
  Header: () => <div data-testid="header" />,
}));

import { AppLayout } from "../app-layout";
import { RangeSelector } from "@/app/(app)/dashboard/components/range-selector";

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

afterEach(() => {
  unmount();
});

describe("AppLayout · skip-link 与 main 落点（A10）", () => {
  it("第一个可聚焦元素是跳到主内容的 skip-link，href=#main", () => {
    mount(<AppLayout>内容</AppLayout>);
    const link = container!.querySelector<HTMLAnchorElement>('a[href="#main"]');
    expect(link).not.toBeNull();
    expect(link!.textContent?.trim()).toBe("跳到主内容");
    // 默认视觉隐藏（sr-only），键盘聚焦后才浮出
    expect(link!.className).toContain("sr-only");
    expect(link!.className).toContain("focus:not-sr-only");
  });

  it("主内容容器是 <main id=main>，且 tabIndex=-1 以便 skip-link 接管焦点", () => {
    mount(<AppLayout>内容</AppLayout>);
    const main = container!.querySelector<HTMLElement>("main#main");
    expect(main).not.toBeNull();
    expect(main!.getAttribute("tabindex")).toBe("-1");
    expect(main!.textContent).toContain("内容");
  });
});

describe("RangeSelector · 单选组语义（A9）", () => {
  it("role=radiogroup；点击另一个范围后 aria-checked 跟随受控值变化", () => {
    function Harness() {
      const [value, setValue] = useState("today");
      return <RangeSelector value={value} onChange={setValue} />;
    }
    mount(<Harness />);

    const group = container!.querySelector('[role="radiogroup"]');
    expect(group).not.toBeNull();
    expect(group!.getAttribute("aria-label")).toBe("时间范围");

    const radios = Array.from(
      container!.querySelectorAll<HTMLButtonElement>('[role="radio"]'),
    );
    expect(radios.map((r) => r.textContent?.trim())).toEqual([
      "今日",
      "近 7 天",
      "近 30 天",
      "近 90 天",
    ]);
    expect(radios[0]!.getAttribute("aria-checked")).toBe("true");
    expect(radios[1]!.getAttribute("aria-checked")).toBe("false");

    act(() => {
      radios[1]!.click();
    });

    const after = Array.from(
      container!.querySelectorAll<HTMLButtonElement>('[role="radio"]'),
    );
    expect(after[0]!.getAttribute("aria-checked")).toBe("false");
    expect(after[1]!.getAttribute("aria-checked")).toBe("true");
  });
});
