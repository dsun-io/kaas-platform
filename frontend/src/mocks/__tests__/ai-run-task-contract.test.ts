// @vitest-environment node
/**
 * C36 #13 · `POST /ai/tasks/{task_key}/run` MSW 契约测试
 *
 * 形状真源：`backend/worker/src/chain.py:475 run_ai_task` + `:751` 路由。
 *  - 200 模板路径：`{result, path:"template", task}`（**无 latency_ms**）
 *  - 200 AI 路径：`{result, path:"ai:<provider>", task, latency_ms}`
 *  - 404 `UNKNOWN_TASK`
 *  - 每次运行落一条 ai_usage（页面"用量审计"要能看到）
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupServer } from "msw/node";

// `handlers` 已 `...longtailHandlers` 展开（handlers.ts:7778），直接用它即可
import { handlers, resetMockData } from "../handlers";

const server = setupServer(...handlers);
const ORIGIN = "http://localhost:3000";
const BASE = `${ORIGIN}/api/v1`;
const JSON_HEADERS = { "Content-Type": "application/json" };

beforeAll(() => {
  Object.defineProperty(globalThis, "location", {
    value: { href: `${ORIGIN}/` },
    configurable: true,
  });
  server.listen({ onUnhandledRequest: "error" });
});
afterAll(() => server.close());
beforeEach(() => resetMockData());

type Json = Record<string, unknown>;

async function send<T>(
  path: string,
  method: "GET" | "POST" | "PUT",
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: JSON_HEADERS,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as T };
}

describe("POST /ai/tasks/{key}/run", () => {
  it("模板路径：200 + path=template，无 latency_ms，result 回显 payload", async () => {
    const run = await send<{ result: Json; path: string; task: string; latency_ms?: number }>(
      "/ai/tasks/lead_scoring/run",
      "POST",
      { payload: { company: "Lone Star Fence" } },
    );

    expect(run.status).toBe(200);
    expect(run.body.path).toBe("template");
    expect(run.body.task).toBe("lead_scoring");
    expect(run.body.latency_ms).toBeUndefined();
    expect(run.body.result).toMatchObject({
      task_key: "lead_scoring",
      payload: { company: "Lone Star Fence" },
      template: true,
    });
  });

  it("AI 路径：配置并启用服务商 + 绑定后返回 ai:<provider> 与 latency_ms，并落 usage", async () => {
    // 1) 配密钥并启用服务商
    const provider = await send<Json>("/ai/providers/deepseek", "PUT", {
      api_key: "sk-test-123",
      enabled: true,
    });
    expect(provider.status).toBe(200);
    expect(provider.body.enabled).toBe(true);

    // 2) 打开任务绑定
    const binding = await send<Json>("/ai/task-bindings/lead_scoring", "PUT", {
      enabled: true,
      provider: "deepseek",
    });
    expect(binding.status).toBe(200);
    expect(binding.body.enabled).toBe(true);

    // 3) 运行 ⇒ AI 路径 + 耗时
    const run = await send<{ path: string; latency_ms?: number }>(
      "/ai/tasks/lead_scoring/run",
      "POST",
      { payload: {} },
    );
    expect(run.status).toBe(200);
    expect(run.body.path).toBe("ai:deepseek");
    expect(typeof run.body.latency_ms).toBe("number");

    // 4) 用量审计能看到刚这次调用（success + provider）
    const usage = await send<{
      items: Json[];
      stats: Array<{ task_key: string; status: string; provider: string; count: number }>;
    }>("/ai/usage?task_key=lead_scoring", "GET");
    expect(usage.status).toBe(200);
    const stat = usage.body.stats.find(
      (s) => s.task_key === "lead_scoring" && s.status === "success" && s.provider === "deepseek",
    );
    expect(stat?.count ?? 0).toBeGreaterThanOrEqual(1);
  });

  it("未知任务 ⇒ 404 UNKNOWN_TASK（如实透出，不静默 200）", async () => {
    const run = await send<{ detail: { code: string } }>(
      "/ai/tasks/no_such_task/run",
      "POST",
      { payload: {} },
    );
    expect(run.status).toBe(404);
    expect(run.body.detail.code).toBe("UNKNOWN_TASK");
  });
});
