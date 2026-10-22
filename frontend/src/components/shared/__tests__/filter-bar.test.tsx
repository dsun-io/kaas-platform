/**
 * FilterBar（P0-C）——搜索防抖提交、重置按钮、子控件渲染。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

import { FilterBar } from "../filter-bar";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function mount(ui: React.ReactNode) {
  if (!container) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  act(() => root!.render(ui));
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  document.body.innerHTML = "";
  root = null;
  container = null;
  vi.useRealTimers();
});

function ControlledFilterBar({
  onSearchCommit,
}: {
  onSearchCommit: (value: string) => void;
}) {
  const [search, setSearch] = useState("");
  return (
    <FilterBar
      searchValue={search}
      onSearchChange={setSearch}
      onSearchCommit={onSearchCommit}
    />
  );
}

function searchInput(): HTMLInputElement {
  const el = document.querySelector("input");
  if (!el) throw new Error("没找到搜索框");
  return el;
}

function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  if (!setter) throw new Error("无法设置 input value");
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("FilterBar", () => {
  it("搜索输入即时回调 onSearchChange，防抖后才回调 onSearchCommit（挂载不提交）", () => {
    const onSearchCommit = vi.fn();
    mount(<ControlledFilterBar onSearchCommit={onSearchCommit} />);

    // 挂载时不提交（初始值已用于首屏查询）
    expect(onSearchCommit).not.toHaveBeenCalled();

    typeInto(searchInput(), "a");
    expect(searchInput().value).toBe("a");
    typeInto(searchInput(), "ab");
    expect(searchInput().value).toBe("ab");

    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(onSearchCommit).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onSearchCommit).toHaveBeenCalledTimes(1);
    expect(onSearchCommit).toHaveBeenCalledWith("ab");
  });

  it("重置按钮只在传 onReset 时出现，点击触发回调", () => {
    const onReset = vi.fn();
    mount(<FilterBar onReset={onReset} />);
    const reset = Array.from(document.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").trim() === "重置",
    );
    expect(reset).toBeDefined();
    act(() => {
      reset?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it("不传 onReset 时没有重置按钮；子筛选控件原样渲染", () => {
    mount(
      <FilterBar>
        <select aria-label="状态">
          <option value="all">全部</option>
        </select>
      </FilterBar>,
    );
    expect(document.querySelector("select")).not.toBeNull();
    expect(
      Array.from(document.querySelectorAll("button")).some(
        (b) => (b.textContent ?? "").trim() === "重置",
      ),
    ).toBe(false);
  });

  it("容器是可命名的 group（筛选区无障碍），默认名为「筛选」", () => {
    mount(<FilterBar />);
    const group = document.querySelector('[role="group"]');
    expect(group?.getAttribute("aria-label")).toBe("筛选");
  });

  it("防抖时长可配置（debounceMs=0 时下一拍即提交）", () => {
    const onSearchCommit = vi.fn();
    mount(
      <FilterBar
        searchValue="a"
        onSearchChange={() => {}}
        onSearchCommit={onSearchCommit}
        debounceMs={0}
      />,
    );
    mount(
      <FilterBar
        searchValue="ab"
        onSearchChange={() => {}}
        onSearchCommit={onSearchCommit}
        debounceMs={0}
      />,
    );
    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(onSearchCommit).toHaveBeenCalledWith("ab");
  });
});
