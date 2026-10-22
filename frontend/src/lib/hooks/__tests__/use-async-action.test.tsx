/**
 * useAsyncAction（P0-C）——pending / error / 不抛 / 统一错误出口 / toast 开关。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

import {
  useAsyncAction,
  type UseAsyncActionOptions,
} from "../use-async-action";

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));

vi.mock("sonner", () => ({ toast: { error: toastError } }));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function Probe({
  action,
  options,
}: {
  action: () => Promise<string>;
  options?: UseAsyncActionOptions<[], string>;
}) {
  const { run, pending, error, reset } = useAsyncAction(action, options);
  const [result, setResult] = useState("(none)");
  return (
    <div>
      <span data-testid="pending">{pending ? "pending" : "idle"}</span>
      <span data-testid="error">{error ?? ""}</span>
      <span data-testid="result">{result}</span>
      <button
        onClick={() => {
          void run().then((value) => {
            setResult(value === undefined ? "undefined" : value);
          });
        }}
      >
        run
      </button>
      <button onClick={reset}>reset</button>
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

function shown(name: "pending" | "error" | "result"): string {
  return document.querySelector(`[data-testid="${name}"]`)?.textContent ?? "";
}

function clickRun() {
  const button = Array.from(document.querySelectorAll("button")).find(
    (b) => (b.textContent ?? "").trim() === "run",
  );
  if (!button) throw new Error("没找到 run 按钮");
  button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  document.body.innerHTML = "";
  root = null;
  container = null;
  toastError.mockClear();
});

describe("useAsyncAction", () => {
  it("成功后 pending 回落、返回结果并触发 onSuccess", async () => {
    const onSuccess = vi.fn();
    const action = vi.fn(async () => "ok");
    mount(<Probe action={action} options={{ onSuccess }} />);

    await act(async () => {
      clickRun();
    });

    expect(shown("pending")).toBe("idle");
    expect(shown("error")).toBe("");
    expect(shown("result")).toBe("ok");
    expect(onSuccess).toHaveBeenCalledWith("ok");
    expect(toastError).not.toHaveBeenCalled();
  });

  it("失败不抛：error 归一化为后端文案、返回 undefined、默认不重复 toast", async () => {
    const onError = vi.fn();
    const action = vi.fn(async () => {
      throw new Error("后端拒绝");
    });
    mount(<Probe action={action} options={{ onError }} />);

    await act(async () => {
      clickRun();
    });

    expect(shown("pending")).toBe("idle");
    expect(shown("error")).toBe("后端拒绝");
    expect(shown("result")).toBe("undefined");
    expect(onError).toHaveBeenCalledWith("后端拒绝", expect.any(Error));
    // apiClient 拦截器已统一提示，默认不再弹一次
    expect(toastError).not.toHaveBeenCalled();
  });

  it("toastOnError: true 时统一 toast（裸 fetch / silent 请求的场景）", async () => {
    const action = vi.fn(async () => {
      throw new Error("网络错误");
    });
    mount(<Probe action={action} options={{ toastOnError: true }} />);

    await act(async () => {
      clickRun();
    });

    expect(toastError).toHaveBeenCalledWith("网络错误");
  });

  it("进行中 pending=true（防重复提交的基础）", async () => {
    let resolve!: (value: string) => void;
    const action = () =>
      new Promise<string>((r) => {
        resolve = r;
      });
    mount(<Probe action={action} />);

    act(() => {
      clickRun();
    });
    expect(shown("pending")).toBe("pending");

    await act(async () => {
      resolve("done");
    });
    expect(shown("pending")).toBe("idle");
    expect(shown("result")).toBe("done");
  });

  it("reset 清空最近一次错误", async () => {
    const action = vi.fn(async () => {
      throw new Error("失败原因");
    });
    mount(<Probe action={action} />);

    await act(async () => {
      clickRun();
    });
    expect(shown("error")).toBe("失败原因");

    const reset = Array.from(document.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").trim() === "reset",
    );
    act(() => {
      reset?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(shown("error")).toBe("");
  });
});
