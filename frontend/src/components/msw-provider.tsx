"use client";

import { useEffect, useRef, useState } from "react";
import { isMockMode } from "@/lib/api/config";

let globalStarted = false;

/**
 * MSW 启动门 —— **必须等它就绪再渲染 children**。
 *
 * 原先的写法是「立刻渲染 + 在 effect 里异步 `worker.start()`」，看起来无害，
 * 实际会漏掉**首屏那一批请求**：React Query 在挂载时立刻发 fetch，
 * 而 `worker.start()` 是异步的，等它 resolve 时请求早已发出去了。
 *
 * 后果不是"少几个 mock"，而是**连锁的**（2026-10-11 定位 e2e 失败时查明）：
 *   未拦截的请求 → 直连网络 → 命中 Next 的 `/api/v1/*` rewrite →
 *   e2e 里 BASE_URL 指向页面源 → **代理到自己**（EADDRINUSE）→
 *   **请求永远不结束** → `waitForLoadState('networkidle')` **永远不满足**
 *   → 所有用它的用例 30 秒超时。
 *
 * 而且它**伪装得很好**：被绕过的偏偏是 `/auth/me`、`/events`、`/customers`、
 * `/dashboard/summary` 这些**本来就有 handler** 的端点，于是看起来像
 * "handler 缺失"或"权限不足"，实际只是**发早了**。
 *
 * 所以：mock 模式下先 return null，等 MSW 就绪；起不来也必须放行
 * （否则一个 mock 故障会把整个应用卡成白屏）。
 */
export function MswProvider({ children }: { children: React.ReactNode }) {
  // 非 mock 模式无需等待；已启动过（热更新/二次挂载）同理
  const [ready, setReady] = useState(() => !isMockMode || globalStarted);
  const started = useRef(false);

  useEffect(() => {
    if (!isMockMode || started.current) {
      setReady(true);
      return;
    }
    started.current = true;

    if (globalStarted) {
      setReady(true);
      return;
    }
    globalStarted = true;

    import("@/mocks/browser")
      // `warn`：放行行为不变，但未匹配的请求会在控制台**被点名**。
      // 原先用 `bypass` 时 handler 缺失是**静默**的，这正是这个坑拖了很久的原因。
      .then((m) => m.worker.start({ onUnhandledRequest: "warn" }))
      .then(() => setReady(true))
      .catch(() => {
        // MSW init failure in non-mock builds is expected — ignore silently.
        // 但**不能因此把页面卡死**：起不来也要放行。
        setReady(true);
      });
  }, []);

  if (!ready) return null;

  return <>{children}</>;
}
