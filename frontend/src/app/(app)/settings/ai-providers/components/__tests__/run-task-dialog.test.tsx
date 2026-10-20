import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";

vi.mock("@/lib/api/client", () => {
  const client = {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  };
  return { default: client, apiClient: client };
});

import {
  RunTaskDialog,
  parseRunValue,
  rowsToPayload,
  runErrorText,
} from "../run-task-dialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let client: QueryClient | null = null;

// Radix Dialog 走 portal 渲染到 document.body，断言必须查 body（不是 mounting container）
function text() {
  return document.body.textContent ?? "";
}

function button(label: string) {
  return Array.from(document.querySelectorAll("button")).find((el) =>
    (el.textContent ?? "").includes(label),
  );
}

async function fillParam(index: number, key: string, value: string) {
  const keyInput = document.querySelector<HTMLInputElement>(
    `input[aria-label="参数名 ${index}"]`,
  )!;
  const valueInput = document.querySelector<HTMLInputElement>(
    `input[aria-label="参数值 ${index}"]`,
  )!;
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  await act(async () => {
    setter?.call(keyInput, key);
    keyInput.dispatchEvent(new Event("input", { bubbles: true }));
    setter?.call(valueInput, value);
    valueInput.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function mount(onRan = vi.fn()) {
  client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      <QueryClientProvider client={client!}>
        <RunTaskDialog
          open
          onOpenChange={() => {}}
          taskKey="lead_scoring"
          taskName="线索评分"
          onRan={onRan}
        />
      </QueryClientProvider>,
    ),
  );
}

beforeEach(() => {
  vi.resetAllMocks();
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  document.body.innerHTML = "";
  client?.clear();
  root = null;
  container = null;
  client = null;
});

describe("RunTaskDialog · 参数表单与结果展示（C36 #13）", () => {
  it("默认空 payload 如实展示请求体；可加参数行并预览最终 payload", async () => {
    mount();
    expect(text()).toContain("运行任务：线索评分");
    expect(text()).toContain("lead_scoring");
    // 请求体预览（空 payload）
    expect(text()).toContain('"payload": {}');

    await fillParam(1, "company", '"Lone Star Fence"');
    expect(document.querySelector("pre")!.textContent).toContain(
      '"company": "Lone Star Fence"',
    );
  });

  it("成功（模板路径）⇒ 显示「运行成功」+ 模板兜底 + 无耗时 + result；触发 onRan", async () => {
    const onRan = vi.fn();
    vi.mocked(apiClient.post).mockResolvedValue({
      data: {
        result: { score: 88, reasons: ["fencing contractor"] },
        path: "template",
        task: "lead_scoring",
      },
    } as never);

    mount(onRan);
    await act(async () => {
      button("运行")!.click();
      await Promise.resolve();
    });

    expect(apiClient.post).toHaveBeenCalledWith(
      "/ai/tasks/lead_scoring/run",
      { payload: {} },
      { silent: true },
    );
    expect(text()).toContain("运行成功");
    expect(text()).toContain("模板兜底（未启用 AI）");
    expect(text()).toContain("—（模板路径不返回耗时）");
    expect(text()).toContain('"score": 88');
    expect(onRan).toHaveBeenCalledTimes(1);
  });

  it("成功（AI 路径）⇒ 显示 ai:provider 与耗时；all_providers_failed 额外提示", async () => {
    vi.mocked(apiClient.post).mockResolvedValue({
      data: {
        result: { ok: true },
        path: "ai:deepseek",
        task: "lead_scoring",
        latency_ms: 812,
        note: "all_providers_failed",
      },
    } as never);

    mount();
    await act(async () => {
      button("运行")!.click();
      await Promise.resolve();
    });

    expect(text()).toContain("ai:deepseek");
    expect(text()).toContain("812 ms");
    expect(text()).toContain("note=all_providers_failed");
  });

  it("403 ⇒ 如实显示「无权限」+ 后端错误码/文案，且不出现「运行成功」", async () => {
    vi.mocked(apiClient.post).mockRejectedValue({
      response: {
        status: 403,
        data: {
          detail: {
            error: "forbidden",
            code: "NOT_PLATFORM_OPS",
            detail: "仅平台运营可执行 AI 任务",
          },
        },
      },
    });

    mount();
    await act(async () => {
      button("运行")!.click();
      await Promise.resolve();
    });

    expect(text()).toContain("运行失败");
    expect(text()).toContain("无权限");
    expect(text()).toContain("NOT_PLATFORM_OPS");
    expect(text()).not.toContain("运行成功");
  });

  it("409 ⇒ 显示「冲突」+ 码；404 UNKNOWN_TASK 同理", async () => {
    vi.mocked(apiClient.post).mockRejectedValueOnce({
      response: {
        status: 409,
        data: { detail: { error: "conflict", code: "TASK_RUNNING" } },
      },
    });
    mount();
    await act(async () => {
      button("运行")!.click();
      await Promise.resolve();
    });
    expect(text()).toContain("冲突");
    expect(text()).toContain("TASK_RUNNING");

    vi.mocked(apiClient.post).mockRejectedValueOnce({
      response: {
        status: 404,
        data: { detail: { error: "not_found", code: "UNKNOWN_TASK" } },
      },
    });
    await act(async () => {
      button("运行")!.click();
      await Promise.resolve();
    });
    expect(text()).toContain("任务不存在");
    expect(text()).toContain("UNKNOWN_TASK");
    expect(text()).not.toContain("运行成功");
  });
});

describe("纯函数 · 值解析 / payload 组装 / 错误文案", () => {
  it("parseRunValue：JSON 优先，失败按字符串，空串保留空串", () => {
    expect(parseRunValue("30")).toBe(30);
    expect(parseRunValue("true")).toBe(true);
    expect(parseRunValue('{"a":1}')).toEqual({ a: 1 });
    expect(parseRunValue("Fence Co")).toBe("Fence Co");
    expect(parseRunValue("")).toBe("");
  });

  it("rowsToPayload：忽略空 key，同 key 后者覆盖", () => {
    expect(
      rowsToPayload([
        { key: "a", value: "1" },
        { key: " ", value: "x" },
        { key: "a", value: '"demo"' },
      ]),
    ).toEqual({ a: "demo" });
  });

  it("runErrorText：字符串 detail 与对象 detail 都能取到；无 detail 用 message", () => {
    expect(runErrorText({ response: { status: 422, data: { detail: "字段缺失" } } })).toBe(
      "字段缺失",
    );
    expect(
      runErrorText({
        response: { status: 422, data: { detail: { code: "BAD", detail: "值非法" } } },
      }),
    ).toBe("BAD：值非法");
    expect(runErrorText({ message: "Network Error" })).toBe("Network Error");
  });
});
