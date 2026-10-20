// @vitest-environment jsdom
/**
 * C5 持久化回归：mock 模式刷新不丢数据
 *
 * 两块断言：
 * 1. **持久化层本身**（`persistence.ts`）：版本化键、坏数据丢弃、只清自己的键、
 *    重置标记/query 消费、写请求 → 集合映射；
 * 2. **端到端**：handler 写入 → `persistAfterMockedResponse` → 模块重新加载（模拟刷新）
 *    → `bootstrapMockData()` hydrate → 数据还在。
 *
 * 端到端用例用 `vi.resetModules()` 模拟"刷新后重新 import 模块"：
 * 这正是此前数据丢失的原因（module-scoped store 被重建）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { setupServer } from "msw/node";

import {
  clearMockPersistence,
  collectionsForRequest,
  consumeMockFreshFlag,
  consumeMockResetQuery,
  hydrateMockState,
  isMockStorageAvailable,
  persistMockState,
  registerMockCollection,
} from "../persistence";

const KEY = (name: string) => `kaas-mock-v1:${name}`;

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("persistence 基础行为", () => {
  it("jsdom 里 localStorage 可用（浏览器路径的可测性前提）", () => {
    expect(isMockStorageAvailable()).toBe(true);
  });

  it("持久化 → hydrate 回灌；键带版本前缀与 schema 版本", () => {
    let restored: unknown = null;
    registerMockCollection(
      "unitRoundTrip",
      () => ({ hello: "world" }),
      (value) => {
        restored = value;
      },
    );
    persistMockState(["unitRoundTrip"]);
    const raw = window.localStorage.getItem(KEY("unitRoundTrip"));
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw ?? "{}") as { v?: number; data?: unknown };
    expect(parsed.v).toBe(1);
    expect(parsed.data).toEqual({ hello: "world" });

    const hydrated = hydrateMockState();
    expect(hydrated).toContain("unitRoundTrip");
    expect(restored).toEqual({ hello: "world" });
  });

  it("版本不匹配 / 坏 JSON 一律丢弃，不把坏数据灌进新代码", () => {
    let called = false;
    registerMockCollection(
      "unitVersionMismatch",
      () => 1,
      () => {
        called = true;
      },
    );
    window.localStorage.setItem(
      KEY("unitVersionMismatch"),
      JSON.stringify({ v: 999, data: 1 }),
    );
    hydrateMockState();
    expect(called).toBe(false);
    expect(window.localStorage.getItem(KEY("unitVersionMismatch"))).toBeNull();

    window.localStorage.setItem(KEY("unitVersionMismatch"), "{not-json");
    hydrateMockState();
    expect(window.localStorage.getItem(KEY("unitVersionMismatch"))).toBeNull();
  });

  it("clearMockPersistence 只清 kaas-mock-v1:*，不动别人的键", () => {
    window.localStorage.setItem(KEY("unitA"), "1");
    window.localStorage.setItem("other-app:key", "keep-me");
    clearMockPersistence();
    expect(window.localStorage.getItem(KEY("unitA"))).toBeNull();
    expect(window.localStorage.getItem("other-app:key")).toBe("keep-me");
  });

  it("重置标记：kaas-mock-fresh 消费一次即删", () => {
    expect(consumeMockFreshFlag()).toBe(false);
    window.localStorage.setItem("kaas-mock-fresh", "1");
    expect(consumeMockFreshFlag()).toBe(true);
    expect(consumeMockFreshFlag()).toBe(false);
    expect(window.localStorage.getItem("kaas-mock-fresh")).toBeNull();
  });

  it("重置入口 ?mock_reset=1：消费一次并从地址栏移除", () => {
    window.history.replaceState({}, "", "/settings?mock_reset=1");
    expect(consumeMockResetQuery()).toBe(true);
    expect(window.location.search).toBe("");
    expect(consumeMockResetQuery()).toBe(false);
  });

  it("写请求 → 集合映射：GET 不落盘，未知写请求不误伤", () => {
    expect(collectionsForRequest("GET", "http://x/api/v1/customers")).toEqual([]);
    expect(
      collectionsForRequest("POST", "http://x/api/v1/customers"),
    ).toContain("customers");
    expect(
      collectionsForRequest("PATCH", "http://x/api/v1/auth/me"),
    ).toEqual(["adminUser", "registeredEmails", "authResetToken"]);
    expect(
      collectionsForRequest("POST", "http://x/api/v1/__test/override-quote-status"),
    ).toEqual([]);
  });
});

describe("C5 端到端：写操作 → 刷新后仍可见", () => {
  it("POST /customers 落盘；模块重新加载后从 localStorage 恢复", async () => {
    window.localStorage.clear();
    const persistence = await import("../persistence");
    const first = await import("../handlers");

    const server = setupServer(...first.handlers);
    server.listen({ onUnhandledRequest: "error" });
    try {
      const res = await fetch("http://localhost:3000/api/v1/customers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ company_name: "持久化客户A", stage: "active" }),
      });
      expect(res.status).toBe(201);
      // 浏览器里由 msw-provider/browser 的 `response:mocked` 事件触发；测试里显式调用同一函数
      persistence.persistAfterMockedResponse(
        "POST",
        "http://localhost:3000/api/v1/customers",
      );
      expect(window.localStorage.getItem(KEY("customers"))).toBeTruthy();
    } finally {
      server.close();
    }

    // 模拟页面刷新：模块重新 import ⇒ store 重建 ⇒ bootstrap 从 localStorage hydrate
    vi.resetModules();
    const second = await import("../handlers");
    const server2 = setupServer(...second.handlers);
    server2.listen({ onUnhandledRequest: "error" });
    try {
      const list = (await (
        await fetch(
          "http://localhost:3000/api/v1/customers?q=" +
            encodeURIComponent("持久化客户A"),
        )
      ).json()) as { items: Array<{ company_name: string }>; total: number };
      expect(list.total).toBe(1);
      expect(list.items[0]?.company_name).toBe("持久化客户A");
    } finally {
      server2.close();
    }
  });

  it("带 ?mock_reset=1 重新加载 ⇒ 清空持久化、回到种子", async () => {
    window.localStorage.clear();
    const persistence = await import("../persistence");
    persistence.registerMockCollection(
      "resetProbe",
      () => "probe",
      () => undefined,
    );
    persistence.persistMockState(["resetProbe"]);
    expect(window.localStorage.getItem(KEY("resetProbe"))).toBeTruthy();

    window.history.replaceState({}, "", "/customers?mock_reset=1");
    vi.resetModules();
    await import("../handlers");
    expect(window.localStorage.getItem(KEY("resetProbe"))).toBeNull();
    expect(window.location.search).toBe("");
  });
});
