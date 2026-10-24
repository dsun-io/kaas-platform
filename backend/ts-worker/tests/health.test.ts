/** /health 探针单测（默认浅探针 + ?deep=1 内核深探针）。 */
import { describe, expect, it } from "vitest";

import app from "../src/index";
import { makeTestEnv } from "./helpers";

describe("GET /health", () => {
  it("返回 200 {status:'ok', service:'kaas-edge'}", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ status: "ok", service: "kaas-edge" });
  });

  it("默认浅探针不触发内核（监控高频调用不放大 Python 冷启动）", async () => {
    let called = 0;
    const env = makeTestEnv({
      KERNEL: {
        fetch: async () => {
          called += 1;
          return new Response("{}", { status: 200 });
        },
      },
    });
    const res = await app.request("/health", {}, env);
    expect(res.status).toBe(200);
    expect(called).toBe(0);
  });

  it("?deep=1 经 KERNEL Service Binding 探内核并回传 shared.loaded", async () => {
    const seen: string[] = [];
    const env = makeTestEnv({
      KERNEL: {
        fetch: async (input) => {
          seen.push(input instanceof Request ? input.url : String(input));
          return new Response(
            JSON.stringify({ status: "ok", service: "kaas", shared: { loaded: true } }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        },
      },
    });
    const res = await app.request("/health?deep=1", {}, env);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "ok",
      service: "kaas-edge",
      kernel: { status: "ok", service: "kaas", shared_loaded: true, http_status: 200 },
    });
    expect(seen).toEqual(["https://kernel.internal/health"]);
  });

  it("?deep=1 内核 200 但 status != ok → 503（避免监控误判健康）", async () => {
    const env = makeTestEnv({
      KERNEL: {
        fetch: async () =>
          new Response(JSON.stringify({ status: "degraded", service: "kaas", shared: { loaded: true } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      },
    });
    const res = await app.request("/health?deep=1", {}, env);

    expect(res.status).toBe(503);
    const body = (await res.json()) as { kernel: { status: string } };
    expect(body.kernel.status).toBe("degraded");
  });

  it("?deep=1 内核 200 但 shared_loaded=false → 503（kaas_common 未随包）", async () => {
    const env = makeTestEnv({
      KERNEL: {
        fetch: async () =>
          new Response(JSON.stringify({ status: "ok", service: "kaas", shared: { loaded: false } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      },
    });
    const res = await app.request("/health?deep=1", {}, env);

    expect(res.status).toBe(503);
    const body = (await res.json()) as { kernel: { shared_loaded: boolean } };
    expect(body.kernel.shared_loaded).toBe(false);
  });

  it("?deep=1 内核冷启动失败一次 → 自动重试成功（部署门禁不再误红）", async () => {
    let calls = 0;
    const env = makeTestEnv({
      KERNEL: {
        fetch: async () => {
          calls += 1;
          if (calls === 1) throw new Error("isolate booting");
          return new Response(
            JSON.stringify({ status: "ok", service: "kaas", shared: { loaded: true } }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        },
      },
    });
    const res = await app.request("/health?deep=1", {}, env);
    expect(res.status).toBe(200);
    expect(calls).toBe(2);
  });

  it("?deep=1 内核不可达 → 503 且给出 unreachable（流水线据此判失败）", async () => {
    const env = makeTestEnv({
      KERNEL: {
        fetch: async () => {
          throw new Error("service binding down");
        },
      },
    });
    const res = await app.request("/health?deep=1", {}, env);

    expect(res.status).toBe(503);
    const body = (await res.json()) as {
      status: string;
      service: string;
      kernel: { status: string; message: string };
    };
    expect(body.status).toBe("ok");
    expect(body.service).toBe("kaas-edge");
    expect(body.kernel.status).toBe("unreachable");
    expect(body.kernel.message).toBe("kernel unreachable");
  });
});