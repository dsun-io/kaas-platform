/**
 * AsyncButton（P0-C）——pending 期间禁用 + aria-busy + 文案切换，其余 props 透传。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { AsyncButton } from "../async-button";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function mount(ui: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(ui));
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  document.body.innerHTML = "";
  root = null;
  container = null;
});

function button(): HTMLButtonElement {
  const el = document.querySelector("button");
  if (!el) throw new Error("没找到按钮");
  return el;
}

describe("AsyncButton", () => {
  it("普通态渲染 children 并透传点击", () => {
    const onClick = vi.fn();
    mount(<AsyncButton onClick={onClick}>保存</AsyncButton>);
    expect(button().textContent).toBe("保存");
    expect(button().disabled).toBe(false);
    act(() => {
      button().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("pending 时禁用、aria-busy、显示 pendingLabel（防重复提交）", () => {
    const onClick = vi.fn();
    mount(
      <AsyncButton pending pendingLabel="保存中…" onClick={onClick}>
        保存
      </AsyncButton>,
    );
    expect(button().textContent).toBe("保存中…");
    expect(button().disabled).toBe(true);
    expect(button().getAttribute("aria-busy")).toBe("true");
    act(() => {
      button().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    // 禁用按钮点击不触发（浏览器语义在 jsdom 下由按钮 disabled 保证）
    expect(onClick).not.toHaveBeenCalled();
  });

  it("外部 disabled 与 pending 都尊重", () => {
    mount(
      <AsyncButton disabled pending>
        删除
      </AsyncButton>,
    );
    expect(button().disabled).toBe(true);
  });
});
