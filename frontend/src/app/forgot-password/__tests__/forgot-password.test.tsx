import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

import ForgotPasswordPage from "../page";

const mockPost = vi.fn();

vi.mock("@/lib/api/client", () => ({
  apiClient: { post: (...args: unknown[]) => mockPost(...args) },
}));

// React 18 act() 需要这个开关（仓库没有 testing-library）
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function renderPage(node: ReactNode): { root: Root; container: HTMLElement } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  return { root, container };
}

afterEach(() => {
  document.body.innerHTML = "";
});

function setValue(container: HTMLElement, sel: string, value: string) {
  const el = container.querySelector<HTMLInputElement>(sel)!;
  act(() => {
    const set = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;
    set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function submit(container: HTMLElement) {
  const form = container.querySelector("form")!;
  act(() => {
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
  });
}

describe("ForgotPasswordPage", () => {
  beforeEach(() => {
    mockPost.mockReset();
  });

  it("输入邮箱后提交调用 /auth/forgot-password", async () => {
    mockPost.mockResolvedValueOnce({ data: { ok: true } });
    const { container } = renderPage(<ForgotPasswordPage />);
    setValue(container, "#email", "user@example.com");
    await act(async () => {
      submit(container);
    });
    expect(mockPost).toHaveBeenCalledWith("/auth/forgot-password", {
      email: "user@example.com",
    });
  });

  it("提交成功后显示统一提示（不泄露邮箱存在性）", async () => {
    mockPost.mockResolvedValueOnce({ data: { ok: true } });
    const { container } = renderPage(<ForgotPasswordPage />);
    setValue(container, "#email", "user@example.com");
    await act(async () => {
      submit(container);
    });
    expect(container.textContent).toContain("如果该邮箱已注册，重置链接已发送");
  });

  it("发送失败显示错误提示", async () => {
    mockPost.mockRejectedValueOnce(new Error("network"));
    const { container } = renderPage(<ForgotPasswordPage />);
    setValue(container, "#email", "user@example.com");
    await act(async () => {
      submit(container);
    });
    expect(container.textContent).toContain("发送失败，请稍后重试");
  });
});
