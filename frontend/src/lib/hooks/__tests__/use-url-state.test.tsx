/**
 * useUrlState（P0-C）——URL query 双向绑定：水合读值、写入 replaceState、
 * 前进/后退同步；不依赖 useSearchParams（静态导出无需 Suspense）。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { readUrlParam, useUrlState, writeUrlParams } from "../use-url-state";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function Probe({ name, fallback }: { name: string; fallback?: string }) {
  const [value, setValue] = useUrlState(name, fallback);
  return (
    <div>
      <span data-testid="value">{value}</span>
      <button
        onClick={() => {
          setValue("draft");
        }}
      >
        set
      </button>
      <button
        onClick={() => {
          setValue(null);
        }}
      >
        clear
      </button>
    </div>
  );
}

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

function shown(): string {
  return document.querySelector('[data-testid="value"]')?.textContent ?? "";
}

function clickButton(text: string) {
  const button = Array.from(document.querySelectorAll("button")).find(
    (b) => (b.textContent ?? "").trim() === text,
  );
  if (!button) throw new Error(`没找到按钮「${text}」`);
  act(() => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

beforeEach(() => {
  window.history.replaceState(null, "", "/orders?status=paid&q=x&page=2");
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  document.body.innerHTML = "";
  root = null;
  container = null;
});

describe("useUrlState", () => {
  it("挂载后从 URL 读初值；URL 没有时用默认值", () => {
    mount(<Probe name="status" />);
    expect(shown()).toBe("paid");

    mount(<Probe name="missing" fallback="all" />);
    expect(shown()).toBe("all");
  });

  it("写值用 replaceState：更新目标参数、保留其它参数、不产生历史记录压力", () => {
    const before = window.history.length;
    mount(<Probe name="status" />);
    clickButton("set");
    const params = new URLSearchParams(window.location.search);
    expect(params.get("status")).toBe("draft");
    expect(params.get("q")).toBe("x");
    expect(params.get("page")).toBe("2");
    expect(window.history.length).toBe(before);
    expect(shown()).toBe("draft");
  });

  it("传 null 从 URL 删除该参数", () => {
    mount(<Probe name="status" />);
    clickButton("clear");
    expect(new URLSearchParams(window.location.search).has("status")).toBe(
      false,
    );
    expect(window.location.search).toContain("q=x");
    expect(shown()).toBe("");
  });

  it("浏览器前进/后退（popstate）时同步回组件", () => {
    mount(<Probe name="status" />);
    expect(shown()).toBe("paid");

    act(() => {
      window.history.replaceState(null, "", "/orders?status=sent&q=x");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(shown()).toBe("sent");
  });
});

describe("URL query helpers", () => {
  it("readUrlParam 读单参数，缺失返回 null", () => {
    expect(readUrlParam("q")).toBe("x");
    expect(readUrlParam("nope")).toBeNull();
  });

  it("writeUrlParams 批量写入/删除并保留 hash 无关的其它参数", () => {
    writeUrlParams({ status: "won", page: null, empty: "" });
    const params = new URLSearchParams(window.location.search);
    expect(params.get("status")).toBe("won");
    expect(params.has("page")).toBe(false);
    expect(params.has("empty")).toBe(false);
    expect(params.get("q")).toBe("x");
  });
});
