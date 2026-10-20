/**
 * 通用二次确认弹窗（C36）——只测"皮"：标题/描述、错误透出、确认与取消回调。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { ConfirmDialog } from "../confirm-dialog";

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

describe("ConfirmDialog", () => {
  it("展示标题/描述，确认与取消各自触发回调", () => {
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    mount(
      <ConfirmDialog
        open
        onOpenChange={onOpenChange}
        title="停用税档「默认税档」？"
        description="软删，可审计"
        confirmLabel="确认停用"
        onConfirm={onConfirm}
      />,
    );
    const text = document.body.textContent ?? "";
    expect(text).toContain("停用税档「默认税档」？");
    expect(text).toContain("软删，可审计");

    clickButton("确认停用");
    expect(onConfirm).toHaveBeenCalledTimes(1);

    clickButton("取消");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("错误原文在弹窗内以 alert 角色展示（403/409/422 原因不能吞）", () => {
    mount(
      <ConfirmDialog
        open
        onOpenChange={() => {}}
        title="删除"
        error="不能停用其他团队的税务档案"
        onConfirm={() => {}}
      />,
    );
    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("不能停用其他团队的税务档案");
  });

  it("pending 时按钮禁用并显示提交中", () => {
    mount(
      <ConfirmDialog
        open
        onOpenChange={() => {}}
        title="删除"
        pending
        onConfirm={() => {}}
      />,
    );
    const actionButtons = Array.from(
      document.querySelectorAll("button"),
    ).filter((b) => ["取消", "提交中…"].includes((b.textContent ?? "").trim()));
    expect(actionButtons.length).toBe(2);
    expect(actionButtons.every((b) => b.disabled)).toBe(true);
  });
});
