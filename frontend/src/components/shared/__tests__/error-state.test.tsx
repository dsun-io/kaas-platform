/**
 * ErrorState（P0-C）——只测"皮"：role=alert、原因透出、重试回调、无回调不渲染按钮。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { ErrorState } from "../error-state";

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

function clickButton(text: string, scope: ParentNode = document) {
  const button = Array.from(scope.querySelectorAll("button")).find(
    (b) => (b.textContent ?? "").trim() === text,
  );
  if (!button) throw new Error(`没找到按钮「${text}」`);
  act(() => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  document.body.innerHTML = "";
  root = null;
  container = null;
});

describe("ErrorState", () => {
  it("以 alert 角色展示默认标题与后端原因（失败不能被渲染成空态）", () => {
    mount(<ErrorState message="不能停用其他团队的税务档案" />);
    const alert = document.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toContain("加载失败");
    expect(alert?.textContent).toContain("不能停用其他团队的税务档案");
  });

  it("可自定义标题/重试文案，点击重试触发 onRetry", () => {
    const onRetry = vi.fn();
    mount(
      <ErrorState
        title="读取失败"
        message="网络错误"
        retryLabel="重新加载"
        onRetry={onRetry}
      />,
    );
    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("读取失败");
    clickButton("重新加载");
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("不传 onRetry 时不渲染重试按钮（不可重试的错误，例如 403）", () => {
    mount(<ErrorState message="无权限查看" />);
    expect(document.querySelectorAll("button").length).toBe(0);
  });
});
