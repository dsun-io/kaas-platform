/**
 * 内核冷启动重试策略（kernel.ts）· 纯策略 + 重试器单测。
 *
 * 背景（2026-10-24 生产事故）：Python/Pyodide 冷启动实测 1–3s，旧实现 150ms×3 的总窗口
 * <0.5s，打不过冷启动 ⇒ 一次页面加载 10+ 个透传请求全部 502。因此策略必须是：
 * ① 只对 fetch 抛错（无响应）重试；② 幂等给足 ≈4.4s 窗口；③ 非幂等至多 1 次且 body 必须
 * 可确定重建；④ 退避带 ±20% 抖动（并发 10+ 请求不许同步重试）。
 */
import { describe, expect, it } from "vitest";

import {
  fetchKernelWithRetry,
  isReplayableBody,
  jitteredBackoffMs,
  KERNEL_RETRY_BACKOFF_MS,
  KERNEL_RETRY_JITTER_RATIO,
  planKernelRetry,
  type KernelCaller,
} from "../src/kernel";

describe("planKernelRetry：按幂等性给预算", () => {
  it("GET/HEAD/OPTIONS → 1 首发 + 4 重试，退避窗口覆盖 1–3s 冷启动", () => {
    for (const method of ["GET", "HEAD", "OPTIONS", "get", "Head"]) {
      const plan = planKernelRetry(method, true);
      expect(plan.maxAttempts).toBe(5);
      expect(plan.backoffMs).toEqual([200, 500, 1200, 2500]);
      const total = plan.backoffMs.reduce((sum, ms) => sum + ms, 0);
      expect(total).toBe(4400);
      // 下限：必须覆盖 Python 冷启动上界（3s）；上限：不能把用户挂太久（5s）
      expect(total).toBeGreaterThanOrEqual(3000);
      expect(total).toBeLessThanOrEqual(5000);
    }
  });

  it("POST/PUT/PATCH/DELETE 即使 body 可重放 → 至多 1 次重试（副作用不可重复）", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "post"]) {
      expect(planKernelRetry(method, true)).toEqual({ maxAttempts: 2, backoffMs: [200] });
    }
  });

  it("非幂等且 body 不可重放 → 绝不重试", () => {
    expect(planKernelRetry("POST", false)).toEqual({ maxAttempts: 1, backoffMs: [] });
  });

  it("methods 大小写不敏感（不因为 'get' 被当成非幂等）", () => {
    expect(planKernelRetry("get", true).maxAttempts).toBe(5);
    expect(planKernelRetry("Options", true).maxAttempts).toBe(5);
  });

  it("幂等方法的 bodyReplayable 参数不缩小窗口（读操作无副作用）", () => {
    expect(planKernelRetry("GET", false).maxAttempts).toBe(5);
  });
});

describe("jitteredBackoffMs：±20% 抖动且非负", () => {
  it("random=0/0.5/1 分别取 0.8x / 1x / 1.2x", () => {
    expect(jitteredBackoffMs(1000, () => 0)).toBe(800);
    expect(jitteredBackoffMs(1000, () => 0.5)).toBe(1000);
    expect(jitteredBackoffMs(1000, () => 1)).toBe(1200);
  });

  it("每个基准值都落在 ±20% 内、为整数", () => {
    for (const base of KERNEL_RETRY_BACKOFF_MS) {
      for (const r of [0, 0.1, 0.25, 0.5, 0.75, 0.99, 1]) {
        const delay = jitteredBackoffMs(base, () => r);
        expect(delay).toBeGreaterThanOrEqual(base * (1 - KERNEL_RETRY_JITTER_RATIO));
        expect(delay).toBeLessThanOrEqual(base * (1 + KERNEL_RETRY_JITTER_RATIO));
        expect(Number.isInteger(delay)).toBe(true);
      }
    }
  });

  it("0 基准不会产生负抖动", () => {
    expect(jitteredBackoffMs(0, () => 0)).toBe(0);
  });
});

describe("fetchKernelWithRetry：只重试抛错", () => {
  it("前两次抛错、第三次成功 → attempts=3，按退避序列等待", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const kernel: KernelCaller = {
      fetch: async () => {
        calls += 1;
        if (calls < 3) throw new Error("isolate booting");
        return new Response("{}", { status: 200 });
      },
    };
    let clock = 0;
    const result = await fetchKernelWithRetry(
      kernel,
      planKernelRetry("GET", true),
      () => new Request("https://kernel.internal/quotes"),
      { sleep: async (ms) => void sleeps.push(ms), random: () => 0.5, now: () => (clock += 100) },
    );

    expect(calls).toBe(3);
    expect(result.attempts).toBe(3);
    expect(result.response?.status).toBe(200);
    expect(result.lastError).toBeNull();
    expect(sleeps).toEqual([200, 500]);
    expect(result.elapsedMs).toBeGreaterThan(0);
  });

  it("全部抛错 → 5 次尝试、4 次退避、response=null（交给上层包 502）", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const kernel: KernelCaller = {
      fetch: async () => {
        calls += 1;
        throw new Error("binding down");
      },
    };
    const result = await fetchKernelWithRetry(
      kernel,
      planKernelRetry("GET", true),
      () => new Request("https://kernel.internal/quotes"),
      { sleep: async (ms) => void sleeps.push(ms), random: () => 0.5 },
    );

    expect(calls).toBe(5);
    expect(result.attempts).toBe(5);
    expect(result.response).toBeNull();
    expect((result.lastError as Error).message).toBe("binding down");
    expect(sleeps).toEqual([200, 500, 1200, 2500]);
  });

  it("内核返回 5xx 属于「有响应」→ 不重试（请求可能已有副作用）", async () => {
    let calls = 0;
    const kernel: KernelCaller = {
      fetch: async () => {
        calls += 1;
        return new Response("boom", { status: 500 });
      },
    };
    const result = await fetchKernelWithRetry(
      kernel,
      planKernelRetry("GET", true),
      () => new Request("https://kernel.internal/quotes"),
      { sleep: async () => {}, random: () => 0.5 },
    );

    expect(calls).toBe(1);
    expect(result.attempts).toBe(1);
    expect(result.response?.status).toBe(500);
  });

  it("非幂等 plan（2 次）→ 只重试一次就放弃", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const kernel: KernelCaller = {
      fetch: async () => {
        calls += 1;
        throw new Error("binding down");
      },
    };
    const result = await fetchKernelWithRetry(
      kernel,
      planKernelRetry("POST", true),
      () => new Request("https://kernel.internal/imports"),
      { sleep: async (ms) => void sleeps.push(ms), random: () => 0.5 },
    );

    expect(calls).toBe(2);
    expect(result.attempts).toBe(2);
    expect(sleeps).toEqual([200]);
  });
});

describe("isReplayableBody：保守口径", () => {
  it("无 body / 字符串 body 可重放", () => {
    expect(isReplayableBody(undefined)).toBe(true);
    expect(isReplayableBody(null)).toBe(true);
    expect(isReplayableBody("{\"a\":1}")).toBe(true);
  });

  it("流式/表单/二进制 body 不可重放（宁可 502 也不发假请求）", () => {
    expect(isReplayableBody(new ReadableStream())).toBe(false);
    expect(isReplayableBody(new FormData())).toBe(false);
    expect(isReplayableBody(new Uint8Array([1, 2, 3]))).toBe(false);
    expect(isReplayableBody(new Blob(["x"]))).toBe(false);
  });
});
