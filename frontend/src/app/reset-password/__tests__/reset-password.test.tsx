import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

import ResetPasswordPage from "../page";

const mockPost = vi.fn();

vi.mock("@/lib/api/client", () => ({
  apiClient: { post: (...args: unknown[]) => mockPost(...args) },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams("token=test-token-123"),
}));

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

afterEach(() => {
  document.body.innerHTML = "";
});

describe("ResetPasswordPage", () => {
  beforeEach(() => {
    mockPost.mockReset();
  });

  it("两次密码不一致时本地校验拦截，不发请求", async () => {
    const { container } = renderPage(<ResetPasswordPage />);
    setValue(container, "#password", "longenough1");
    setValue(container, "#confirm", "different1");
    await act(async () => {
      submit(container);
    });
    expect(container.textContent).toContain("两次输入的密码不一致");
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("密码过短时本地校验拦截", async () => {
    const { container } = renderPage(<ResetPasswordPage />);
    setValue(container, "#password", "short");
    setValue(container, "#confirm", "short");
    await act(async () => {
      submit(container);
    });
    expect(container.textContent).toContain("密码至少 8 位");
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("校验通过则调用 /auth/reset-password 带 token", async () => {
    mockPost.mockResolvedValueOnce({ data: { ok: true } });
    const { container } = renderPage(<ResetPasswordPage />);
    setValue(container, "#password", "newpassword1");
    setValue(container, "#confirm", "newpassword1");
    await act(async () => {
      submit(container);
    });
    expect(mockPost).toHaveBeenCalledWith("/auth/reset-password", {
      token: "test-token-123",
      new_password: "newpassword1",
    });
  });

  it("成功后显示完成提示", async () => {
    mockPost.mockResolvedValueOnce({ data: { ok: true } });
    const { container } = renderPage(<ResetPasswordPage />);
    setValue(container, "#password", "newpassword1");
    setValue(container, "#confirm", "newpassword1");
    await act(async () => {
      submit(container);
    });
    expect(container.textContent).toContain("密码已重置，请用新密码登录");
  });

  it("后端返回 invalid_token 时展示错误信息", async () => {
    mockPost.mockRejectedValueOnce({
      response: {
        data: { detail: { message: "重置链接无效或已过期，请重新申请" } },
      },
    });
    const { container } = renderPage(<ResetPasswordPage />);
    setValue(container, "#password", "newpassword1");
    setValue(container, "#confirm", "newpassword1");
    await act(async () => {
      submit(container);
    });
    expect(container.textContent).toContain("重置链接无效或已过期，请重新申请");
  });
});
