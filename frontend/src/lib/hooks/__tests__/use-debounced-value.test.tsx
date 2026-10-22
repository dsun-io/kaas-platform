/**
 * useDebouncedValue（P0-C）——默认 300ms、连续击键只落最后一次、delay<=0 即时透传。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { useDebouncedValue } from "../use-debounced-value";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function Probe({ value, delayMs }: { value: string; delayMs?: number }) {
  const debounced = useDebouncedValue(value, delayMs);
  return <span data-testid="value">{debounced}</span>;
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function renderProbe(props: { value: string; delayMs?: number }) {
  if (!container) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  act(() => root!.render(<Probe {...props} />));
}

function shown(): string {
  return document.querySelector('[data-testid="value"]')?.textContent ?? "";
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

describe("useDebouncedValue", () => {
  it("首帧就是当前值，变化后要等满 delayMs 才生效", () => {
    renderProbe({ value: "a" });
    expect(shown()).toBe("a");

    renderProbe({ value: "ab" });
    expect(shown()).toBe("a");

    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(shown()).toBe("a");

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(shown()).toBe("ab");
  });

  it("连续击键只落最后一次（中间值被取消）", () => {
    renderProbe({ value: "" });
    renderProbe({ value: "x" });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    renderProbe({ value: "xy" });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    renderProbe({ value: "xyz" });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(shown()).toBe("xyz");
  });

  it("delayMs<=0 退化为即时透传", () => {
    renderProbe({ value: "a", delayMs: 0 });
    expect(shown()).toBe("a");
    renderProbe({ value: "b", delayMs: 0 });
    expect(shown()).toBe("b");
  });

  it("默认延迟是 300ms", () => {
    renderProbe({ value: "a" });
    renderProbe({ value: "b" });
    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(shown()).toBe("a");
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(shown()).toBe("b");
  });
});
