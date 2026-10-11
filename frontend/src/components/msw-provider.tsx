"use client";

import { useEffect, useRef, useState } from "react";
import { isMockMode } from "@/lib/api/config";

let globalStarted = false;

/**
 * 等 Service Worker **真正接管本页**。
 *
 * 为什么 `worker.start()` resolve 还不够：MSW 的 `mockServiceWorker.js` 在
 * `activate` 里 `clients.claim()`，而那是 `event.waitUntil`（**异步**）——
 * 所以 `start()` 返回时，SW 可能还没拿到本页的控制权。这段窗口里发出的请求
 * **绕过 mock 直连网络**：e2e 里会打到 Next dev server 的 `/api/v1/*` rewrite，
 * 而 rewrite 指向页面源 → **自己代理自己**（EADDRINUSE）→ **请求永久挂起**
 * → `waitForLoadState('networkidle')` 永不满足 → 用例超时。
 *
 * 而且它**不留痕迹**：MSW 不会记录这段窗口里的请求（那时它还没接管），
 * 所以缺口日志里看不到 `/api/v1/*` —— 这正是之前那个"看起来自相矛盾"的点。
 *
 * Playwright **每个用例新建 browser context**，于是这个竞态**每次首屏都会踩**，
 * 与"每轮通过数都不一样"高度吻合。
 *
 * 兜底：超时也要放行 —— 不能因为一个 SW 竞态把应用卡成白屏。
 */
async function waitForServiceWorkerControl(timeoutMs = 3000): Promise<void> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  if (navigator.serviceWorker.controller) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      navigator.serviceWorker.removeEventListener("controllerchange", done);
      resolve();
    };
    navigator.serviceWorker.addEventListener("controllerchange", done);
    setTimeout(done, timeoutMs);
  });
}

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
      // 再等 SW **真正接管本页**：`start()` resolve 时 `clients.claim()`
      // （activate 里的 waitUntil）可能还没生效，那段窗口里的请求会绕过 mock。
      .then(() => waitForServiceWorkerControl())
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
