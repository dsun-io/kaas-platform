import { describe, expect, it } from "vitest";

import { createProxyApp } from "../src/proxy";

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

  it("4xx 原样透传（不改信封）", async () => {
    const env = makeEnv({
      KERNEL: {
        fetch: async () =>
          new Response(JSON.stringify({ detail: { error: "not_found", code: "X" } }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          }),
      },
    });
    const app = createProxyApp("/api/v1/quotes");
    const res = await app.request("/api/v1/quotes/nope", {}, env);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ detail: { error: "not_found", code: "X" } });
  });

  it("5xx 归一为 kernel_error", async () => {
    const env = makeEnv({
      KERNEL: {
        fetch: async () => new Response("boom: engine exploded", { status: 500 }),
      },
    });
    const app = createProxyApp("/api/v1/quotes");
    const res = await app.request("/api/v1/quotes/x", {}, env);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; message: string; status: number };
    expect(body.error).toBe("kernel_error");
    expect(body.message).toContain("boom");
    expect(body.status).toBe(500);
  });

  it("内核不可达 → 502 kernel_error", async () => {
    const env = makeEnv({
      KERNEL: {
        fetch: async () => {
          throw new Error("binding down");
        },
      },
    });
    const app = createProxyApp("/api/v1/quotes");
    const res = await app.request("/api/v1/quotes/x", {}, env);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("kernel_error");
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
});
