import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppEnv, ApiTokenActor } from "../src/actor";
import { verifyToken } from "../src/auth";
import { createProxyApp, KERNEL_UNAVAILABLE_MESSAGE } from "../src/proxy";

afterEach(() => {
  vi.useRealTimers();
});

function makeEnv(overrides: Record<string, unknown> = {}) {
  return {
    JWT_SECRET: "test-secret",
    KERNEL: {
      fetch: async (req: Request) =>
        new Response(JSON.stringify({ echo: new URL(req.url).pathname, method: req.method }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    },
    ...overrides,
  };
}

describe("proxy 透传层", () => {
  it("2xx 原样透传 + 路径保持", async () => {
    const app = createProxyApp("/api/v1/quotes");
    const res = await app.request("/api/v1/quotes/123", {}, makeEnv());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ echo: "/api/v1/quotes/123", method: "GET" });
  });

  it("4xx 原样透传（不改信封、不重试）", async () => {
    let calls = 0;
    const env = makeEnv({
      KERNEL: {
        fetch: async () => {
          calls += 1;
          return new Response(JSON.stringify({ detail: { error: "not_found", code: "X" } }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          });
        },
      },
    });
    const app = createProxyApp("/api/v1/quotes");
    const res = await app.request("/api/v1/quotes/nope", {}, env);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ detail: { error: "not_found", code: "X" } });
    expect(calls).toBe(1); // 4xx 是业务结果，重试没有意义
  });

  it("内核返回 5xx → 归一 kernel_error，且不重试（可能已有副作用）", async () => {
    let calls = 0;
    const env = makeEnv({
      KERNEL: {
        fetch: async () => {
          calls += 1;
          return new Response("boom: engine exploded", { status: 500 });
        },
      },
    });
    const app = createProxyApp("/api/v1/quotes");
    const res = await app.request("/api/v1/quotes/x", {}, env);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; message: string; status: number };
    expect(body.error).toBe("kernel_error");
    expect(body.message).toContain("boom");
    expect(body.status).toBe(500);
    expect(calls).toBe(1);
  });

  it("GET 全部 reject → 5 次尝试后 502 kernel_unavailable（可诊断信封 + Retry-After）", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const env = makeEnv({
      KERNEL: {
        fetch: async () => {
          calls += 1;
          throw new Error("binding down");
        },
      },
    });
    const app = createProxyApp("/api/v1/quotes");

    const pending = app.request("/api/v1/quotes/x", {}, env);
    // 走完 200/500/1200/2500ms 的退避序列（假时钟，不真等 4.4s）
    await vi.advanceTimersByTimeAsync(10_000);
    const res = await pending;

    expect(res.status).toBe(502);
    expect(calls).toBe(5); // 1 首发 + 4 重试：窗口必须能覆盖 1–3s 冷启动
    expect(res.headers.get("Retry-After")).toBe("1");
    const body = (await res.json()) as {
      error: string;
      message: string;
      status: number;
      retryable: boolean;
      attempts: number;
      elapsed_ms: number;
    };
    expect(body).toMatchObject({
      error: "kernel_unavailable",
      message: KERNEL_UNAVAILABLE_MESSAGE,
      status: 502,
      retryable: true,
      attempts: 5,
    });
    // elapsed_ms 是诊断字段：假时钟推进过，必须 > 0 才说明真的量过耗时
    expect(typeof body.elapsed_ms).toBe("number");
    expect(body.elapsed_ms).toBeGreaterThan(0);
    // 不是内部异常串泄漏给前端
    expect(body.message).not.toContain("binding down");
  });

  it("POST 带 body 全部 reject → 至多 2 次尝试（非幂等不无限重试）", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const env = makeEnv({
      KERNEL: {
        fetch: async () => {
          calls += 1;
          throw new Error("binding down");
        },
      },
    });
    const app = createProxyApp("/api/v1/products");

    const pending = app.request(
      "/api/v1/products/chain_link/media",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hello: "media" }),
      },
      env,
    );
    await vi.advanceTimersByTimeAsync(10_000);
    const res = await pending;

    expect(res.status).toBe(502);
    expect(calls).toBe(2); // 副作用请求：1 首发 + 至多 1 次重放
    const body = (await res.json()) as { error: string; attempts: number; retryable: boolean };
    expect(body).toMatchObject({ error: "kernel_unavailable", attempts: 2, retryable: true });
  });

  it("GET 前两次 reject → 第三次成功（冷启动抖动自愈，不把 502 抛给用户）", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const env = makeEnv({
      KERNEL: {
        fetch: async () => {
          calls += 1;
          if (calls < 3) throw new Error("isolate booting");
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        },
      },
    });
    const app = createProxyApp("/api/v1/export-quote");

    const pending = app.request("/api/v1/export-quote/products", {}, env);
    await vi.advanceTimersByTimeAsync(10_000);
    const res = await pending;

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(calls).toBe(3);
  });

  it("OPTIONS 预检同样按幂等重试（CORS 预检不应被冷启动打断）", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const env = makeEnv({
      KERNEL: {
        fetch: async () => {
          calls += 1;
          if (calls === 1) throw new Error("isolate booting");
          return new Response(null, { status: 204 });
        },
      },
    });
    const app = createProxyApp("/api/v1/quotes");

    const pending = app.request("/api/v1/quotes/x", { method: "OPTIONS" }, env);
    await vi.advanceTimersByTimeAsync(10_000);
    const res = await pending;

    expect(res.status).toBe(204);
    expect(calls).toBe(2);
  });

  it("内核冷启动失败一次 → 自动重试成功（不再把 502 抛给用户）", async () => {
    let calls = 0;
    const env = makeEnv({
      KERNEL: {
        fetch: async () => {
          calls += 1;
          if (calls === 1) throw new Error("isolate booting");
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        },
      },
    });
    const app = createProxyApp("/api/v1/export-quote");
    const res = await app.request("/api/v1/export-quote/products", {}, env);
    expect(res.status).toBe(200);
    expect(calls).toBe(2);
  });

  it("POST 带 body：冷启动失败后重试仍能重放 body（不会变成空请求）", async () => {
    const bodies: string[] = [];
    let calls = 0;
    const env = makeEnv({
      KERNEL: {
        fetch: async (input: Request) => {
          calls += 1;
          if (calls === 1) throw new Error("isolate booting");
          bodies.push(await input.text());
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        },
      },
    });
    const app = createProxyApp("/api/v1/products");
    const res = await app.request(
      "/api/v1/products/chain_link/media",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hello: "media" }),
      },
      env,
    );
    expect(res.status).toBe(200);
    expect(calls).toBe(2);
    expect(bodies).toEqual([JSON.stringify({ hello: "media" })]);
  });

  it("KERNEL binding 缺失 → 503", async () => {
    const env = makeEnv({ KERNEL: undefined });
    const app = createProxyApp("/api/v1/quotes");
    const res = await app.request("/api/v1/quotes/x", {}, env);
    expect(res.status).toBe(503);
  });

  it("非法 token → 401 且不触达内核", async () => {
    let called = false;
    const env = makeEnv({
      KERNEL: {
        fetch: async () => {
          called = true;
          return new Response("{}", { status: 200 });
        },
      },
    });
    const app = createProxyApp("/api/v1/quotes");
    const res = await app.request("/api/v1/quotes/x", {
      headers: { Authorization: "Bearer not-a-jwt" },
    }, env);
    expect(res.status).toBe(401);
    expect(called).toBe(false);
  });

  it("无 token → 放行给内核裁决（与 Python 端点行为一致）", async () => {
    const app = createProxyApp("/api/v1/quotes");
    const res = await app.request("/api/v1/quotes/public-ok", {}, makeEnv());
    expect(res.status).toBe(200);
  });

  it("POST body / query 原样转发（path 与方法不变）", async () => {
    const seen: Array<{ method: string; url: string; body: string }> = [];
    const env = makeEnv({
      KERNEL: {
        fetch: async (input: Request) => {
          seen.push({ method: input.method, url: input.url, body: await input.text() });
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        },
      },
    });
    const app = createProxyApp("/api/v1/events");
    const res = await app.request(
      "/api/v1/events/ingest?batch=2",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ items: [1, 2] }),
      },
      env,
    );

    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe("POST");
    const url = new URL(seen[0]!.url);
    expect(url.hostname).toBe("kernel.internal");
    expect(url.pathname).toBe("/api/v1/events/ingest");
    expect(url.search).toBe("?batch=2");
    expect(JSON.parse(seen[0]!.body)).toEqual({ items: [1, 2] });
  });

  it("API token 身份 → Authorization 换成短时效内部 JWT（不透传 kaas_oat_）", async () => {
    const actor: ApiTokenActor = {
      kind: "api_token",
      tokenId: 7,
      tenantId: "default",
      teamId: 4,
      scopes: ["quotes:read"],
      name: "CI token",
      createdBy: 5,
    };
    let seenAuth: string | null = null;
    const env = makeEnv({
      KERNEL: {
        fetch: async (input: Request) => {
          seenAuth = input.headers.get("authorization");
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        },
      },
    });
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("apiTokenActor", actor);
      await next();
    });
    app.route("/api/v1/quotes", createProxyApp("/api/v1/quotes"));

    const res = await app.request(
      "/api/v1/quotes/1",
      { headers: { Authorization: "Bearer kaas_oat_plaintext-should-not-leak" } },
      env,
    );

    expect(res.status).toBe(200);
    expect(seenAuth).toMatch(/^Bearer /);
    expect(seenAuth).not.toContain("kaas_oat_");
    const payload = await verifyToken(seenAuth!.slice("Bearer ".length), "test-secret");
    expect(payload.sub).toBe("5");
  });
});