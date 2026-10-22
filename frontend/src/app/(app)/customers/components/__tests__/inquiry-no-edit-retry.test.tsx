/**
 * 客户页「改询盘编号」编辑弹窗（NumberEditDialog）失败后可重试。
 *
 * 场景（真实后端）：已生成报价的询盘改号 ⇒ 409 INQUIRY_NO_LOCKED。
 * 要求：错误如实显示在弹窗里、弹窗**不关闭**，用户改回合法值可以再次提交
 * （不是"一次失败就锁死"）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

import { NumberEditDialog } from "@/components/shared/number-edit-dialog";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function settle() {
  return act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function setInput(value: string) {
  const input = document.querySelector<HTMLInputElement>("#number-edit-input");
  if (!input) throw new Error("没找到编号输入框");
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function clickButton(text: string) {
  const button = Array.from(document.querySelectorAll("button")).find(
    (b) => (b.textContent ?? "").trim() === text,
  );
  if (!button) throw new Error(`没找到按钮「${text}」`);
  act(() => button.click());
}

/** 模拟客户页：失败留在弹窗里显示错误，成功才关闭。 */
function Harness({
  onConfirm,
}: {
  onConfirm: (value: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (value: string) => {
    setPending(true);
    setError(null);
    try {
      await onConfirm(value);
      setOpen(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  };

  return (
    <NumberEditDialog
      open={open}
      onOpenChange={setOpen}
      title="修改询盘编号"
      label="询盘编号"
      currentValue="INQ-OLD-001"
      pending={pending}
      error={error}
      onConfirm={(value) => void submit(value)}
    />
  );
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  document.body.innerHTML = "";
  root = null;
  container = null;
});

describe("改编号弹窗：失败可重试", () => {
  it("409 后弹窗不关闭、错误可见；改值后再次提交成功", async () => {
    const attempts: string[] = [];
    const onConfirm = vi
      .fn<(value: string) => Promise<void>>()
      .mockImplementation(async (value: string) => {
        attempts.push(value);
        if (attempts.length === 1) {
          throw new Error(
            "该询盘已生成报价单，编号已锁定；如需改号请先处理关联报价",
          );
        }
      });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root!.render(<Harness onConfirm={onConfirm} />));
    await settle();

    setInput("INQ-NEW-001");
    clickButton("确认修改");
    await settle();

    // 失败：弹窗仍在 + 错误原文可见（不是 toast 一闪而过）
    expect(document.body.textContent).toContain("修改询盘编号");
    expect(document.body.textContent).toContain("编号已锁定");
    expect(attempts).toEqual(["INQ-NEW-001"]);

    // 重试：同一个弹窗里改值后再提交
    setInput("INQ-NEW-002");
    clickButton("确认修改");
    await settle();

    expect(attempts).toEqual(["INQ-NEW-001", "INQ-NEW-002"]);
    expect(document.body.textContent).not.toContain("修改询盘编号");
  });
});
