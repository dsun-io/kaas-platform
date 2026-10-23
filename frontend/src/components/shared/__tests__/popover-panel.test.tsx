/**
 * PopoverPanel（O5 共享浮层）——把"外点关闭 / Esc 关闭 / 焦点归还"收成一处。
 *
 * 钉死四条（orders 列配置原生的三条 + 受控约定）：
 *  1. trigger 的 aria-expanded 随开合变化，面板 role="dialog" 且可命名；
 *  2. Esc 收起并把焦点还给 trigger（否则焦点落在已隐藏的控件上）；
 *  3. 点面板里面**不**收起（阳性对照，防"一律关闭"的假修复）；
 *  4. 点外面收起。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { PopoverPanel } from "../popover-panel";

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

function trigger(): HTMLButtonElement {
  const el = container!.querySelector(
    '[data-slot="popover-panel-trigger"]',
  );
  if (!el) throw new Error("没找到 popover trigger");
  return el as HTMLButtonElement;
}

function panel(): HTMLElement | null {
  return container!.querySelector('[data-slot="popover-panel"]');
}

function openPanel() {
  act(() => {
    trigger().click();
  });
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  document.body.innerHTML = "";
  root = null;
  container = null;
});

function Demo({ open, onOpenChange }: { open?: boolean; onOpenChange?: (o: boolean) => void }) {
  return (
    <PopoverPanel
      trigger="列配置"
      ariaLabel="列配置"
      open={open}
      onOpenChange={onOpenChange}
    >
      <label>
        <input type="checkbox" /> 订单号
      </label>
    </PopoverPanel>
  );
}

describe("PopoverPanel", () => {
  it("默认收起；点击 trigger 展开 aria-expanded 与 role=dialog", () => {
    mount(<Demo />);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(panel()).toBeNull();

    openPanel();
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(trigger().getAttribute("aria-haspopup")).toBe("dialog");
    expect(panel()?.getAttribute("role")).toBe("dialog");
    expect(panel()?.getAttribute("aria-label")).toBe("列配置");
    expect(panel()?.textContent).toContain("订单号");
  });

  it("Esc 收起并把焦点还给 trigger", () => {
    mount(<Demo />);
    openPanel();

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });

    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("点面板里面不收起（阳性对照）", () => {
    mount(<Demo />);
    openPanel();

    const checkbox = panel()!.querySelector("input")!;
    act(() => {
      checkbox.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(panel()).not.toBeNull();
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
  });

  it("点浮层外面收起", () => {
    mount(<Demo />);
    openPanel();

    act(() => {
      document.body.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true }),
      );
    });
    expect(panel()).toBeNull();
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("受控模式：自己不关，只回调 onOpenChange", () => {
    const onOpenChange = vi.fn();
    mount(<Demo open onOpenChange={onOpenChange} />);
    expect(trigger().getAttribute("aria-expanded")).toBe("true");

    act(() => {
      trigger().click();
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    // 受控：open 仍为 true，由父组件决定
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
  });
});
