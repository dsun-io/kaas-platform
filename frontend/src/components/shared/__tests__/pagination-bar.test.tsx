import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { PaginationBar } from "../pagination-bar";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function mount(ui: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(ui));
}

function text() {
  return container?.textContent ?? "";
}

function button(label: string) {
  return Array.from(container!.querySelectorAll("button")).find((el) =>
    (el.textContent ?? "").includes(label),
  );
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("PaginationBar · 当前范围 + 总数 + 翻页", () => {
  it("显示第 1–20 条 / 共 45 条，且上一页禁用；下一页回传 page=2", () => {
    const onPageChange = vi.fn();
    mount(
      <PaginationBar
        page={1}
        pageSize={20}
        total={45}
        currentCount={20}
        onPageChange={onPageChange}
      />,
    );

    expect(text()).toContain("第 1–20 条 / 共 45 条");
    expect(text()).toContain("第 1 / 3 页");
    expect(button("上一页")?.disabled).toBe(true);
    expect(button("下一页")?.disabled).toBe(false);

    act(() => button("下一页")!.click());
    expect(onPageChange).toHaveBeenCalledWith(2);
  });

  it("末页按真实条数显示范围（不是 page*pageSize 猜出来的）", () => {
    mount(
      <PaginationBar
        page={3}
        pageSize={20}
        total={45}
        currentCount={5}
        onPageChange={() => {}}
      />,
    );
    // 45 条、每页 20 ⇒ 第 3 页只有 41–45 这 5 条
    expect(text()).toContain("第 41–45 条 / 共 45 条");
    expect(text()).toContain("第 3 / 3 页");
    expect(button("下一页")?.disabled).toBe(true);
  });

  it("后端钳位后 page 超界时按总页数显示（不出现第 4 / 3 页）", () => {
    mount(
      <PaginationBar page={9} pageSize={20} total={45} onPageChange={() => {}} />,
    );
    expect(text()).toContain("第 3 / 3 页");
  });

  it("一页装得下 / 空列表时不渲染（不占版面）", () => {
    mount(
      <PaginationBar page={1} pageSize={20} total={20} onPageChange={() => {}} />,
    );
    expect(container!.querySelector("nav")).toBeNull();

    mount(
      <PaginationBar page={1} pageSize={20} total={0} onPageChange={() => {}} />,
    );
    expect(container!.querySelector("nav")).toBeNull();
  });

  it("loading 时两个按钮都禁用（避免连点跳页）", () => {
    mount(
      <PaginationBar
        page={2}
        pageSize={20}
        total={45}
        loading
        onPageChange={() => {}}
      />,
    );
    expect(button("上一页")?.disabled).toBe(true);
    expect(button("下一页")?.disabled).toBe(true);
  });
});
