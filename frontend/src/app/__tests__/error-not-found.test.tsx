/**
 * 根级 error.tsx 与全局 not-found.tsx（U-P0B5）。
 *
 * 钉死：错误/404 也必须有唯一 h1、明确下一步（重试 / 返回首页），
 * 且 404 不再落到框架默认英文页。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// jsdom 没有 App Router 上下文，next/link 直接渲染会抛错 ⇒ 原生 a 替身。
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
  }: {
    href: string | { pathname?: string };
    children: React.ReactNode;
  }) => (
    <a href={typeof href === "string" ? href : (href?.pathname ?? "#")}>
      {children}
    </a>
  ),
}));

import ErrorPage from "../error";
import NotFound from "../not-found";

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

describe("根级 error.tsx", () => {
  it("保留页头 + role=alert + 重试调 reset", () => {
    const reset = vi.fn();
    mount(
      <ErrorPage
        error={Object.assign(new Error("无法连接后端"), { digest: "abc" })}
        reset={reset}
      />,
    );
    const headings = container!.querySelectorAll("h1");
    expect(headings.length).toBe(1);
    expect(headings[0]?.textContent).toBe("页面加载异常");
    expect(container!.querySelector('[role="alert"]')?.textContent).toContain(
      "无法连接后端",
    );

    const retry = Array.from(container!.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").trim() === "重试",
    );
    expect(retry).toBeDefined();
    act(() => {
      retry!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(reset).toHaveBeenCalledTimes(1);
  });
});

describe("全局 not-found.tsx", () => {
  it("唯一 h1 + 404 说明 + 返回首页入口", () => {
    mount(<NotFound />);

    const headings = container!.querySelectorAll("h1");
    expect(headings.length).toBe(1);
    expect(headings[0]?.textContent).toBe("页面不存在");

    expect(container!.textContent).toContain("404");
    expect(container!.textContent).toContain("返回首页");

    const home = container!.querySelector('a[href="/"]');
    expect(home).not.toBeNull();
    expect(home?.textContent).toContain("返回首页");
    // 404 是"没有这个页面"，不是错误分支：不该出现 alert
    expect(container!.querySelector('[role="alert"]')).toBeNull();
  });
});
