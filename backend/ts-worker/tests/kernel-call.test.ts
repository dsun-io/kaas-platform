/**
 * callKernel（kernel.ts）· 与 proxy.ts 共用冷启动重试策略的回归测试。
 *
 * 语义铁律（EXECUTION_PLAYBOOK §2 + Lead 口径）：/health?deep=1 与 outreach 都走 callKernel，
 * 只改重试窗口，**不改**「不可达 → KernelError(503) / 5xx → KernelError(status)」的形状。
 */
import { describe, expect, it, vi } from "vitest";

import { callKernel, KernelError, type KernelCaller } from "../src/kernel";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("callKernel：冷启动重试（与 proxy 同款策略）", () => {
  it("GET 冷启动失败一次 → 重试成功（不抛 503）", async () => {
    let calls = 0;
    const kernel: KernelCaller = {
      fetch: async () => {
        calls += 1;
        if (calls === 1) throw new Error("isolate booting");
        return jsonResponse({ status: "ok" });
      },
    };

    const res = await callKernel(kernel, "/health");

    expect(res.status).toBe(200);
    expect(calls).toBe(2);
  });

  it("GET 全部失败 → 5 次尝试后抛 KernelError(503, kernel unreachable)", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const kernel: KernelCaller = {
        fetch: async () => {
          calls += 1;
          throw new Error("service binding down");
        },
      };

      const settled = callKernel(kernel, "/health").then(
        () => null,
        (err: unknown) => err,
      );
      await vi.advanceTimersByTimeAsync(10_000);
      const err = await settled;

      expect(calls).toBe(5);
      expect(err).toBeInstanceOf(KernelError);
      const kernelErr = err as KernelError;
      expect(kernelErr.status).toBe(503);
      expect(kernelErr.message).toContain("kernel unreachable");
      expect(kernelErr.message).toContain("service binding down");
    } finally {
      vi.useRealTimers();
    }
  });

  it("内核返回 5xx → 抛 KernelError(status)，不重试（有响应≠可安全重放）", async () => {
    let calls = 0;
    const kernel: KernelCaller = {
      fetch: async () => {
        calls += 1;
        return new Response("boom", { status: 503 });
      },
    };

    await expect(callKernel(kernel, "/health")).rejects.toMatchObject({
      name: "KernelError",
      status: 503,
      message: "kernel returned 503",
    });
    expect(calls).toBe(1);
  });

  it("POST 字符串 body → 至多 1 次重试，且 body 原样重放", async () => {
    const bodies: string[] = [];
    let calls = 0;
    const kernel: KernelCaller = {
      fetch: async (input) => {
        calls += 1;
        if (typeof input !== "string") bodies.push(await input.text());
        if (calls === 1) throw new Error("isolate booting");
        return jsonResponse({ ok: true });
      },
    };

    const res = await callKernel(kernel, "/api/v1/outreach/generate", {
      method: "POST",
      body: JSON.stringify({ lead_id: 9 }),
    });

    expect(res.status).toBe(200);
    expect(calls).toBe(2);
    // 两次尝试都必须带同样的 body：重放不是「发空请求」
    expect(bodies).toEqual([JSON.stringify({ lead_id: 9 }), JSON.stringify({ lead_id: 9 })]);
  });

  it("POST 不可重放 body（FormData）→ 不重试，直接抛 KernelError", async () => {
    let calls = 0;
    const kernel: KernelCaller = {
      fetch: async () => {
        calls += 1;
        throw new Error("binding down");
      },
    };
    const form = new FormData();
    form.append("file", "x");

    await expect(
      callKernel(kernel, "/api/v1/imports/preview", { method: "POST", body: form }),
    ).rejects.toBeInstanceOf(KernelError);
    expect(calls).toBe(1);
  });
});
