"use client";

import { useEffect, useState } from "react";
import { isMockMode } from "@/lib/api/config";

/**
 * MSW 就绪的**唯一** promise（模块级 = 每个 JS realm 一份）。
 *
 * **为什么必须是 promise，而不是"已启动过"的布尔量**：
 * `frontend/next.config.mjs` 是 `reactStrictMode: true`，React 18 在 dev 下
 * 会把 effect **跑两遍**（mount → 模拟 unmount → mount）。旧实现用
 * `started.current` / `globalStarted` 表示"启动过了"，于是**第二次调用直接
 * `setReady(true)` 放行** —— 而那时 `worker.start()` 还没 resolve。
 * ⇒ 首屏那一批 `/api/v1/*` **在 MSW 就绪之前发出** ⇒ 绕过 mock
 * ⇒ 直连 dev server 的 `/api/v1/*` rewrite ⇒ 自代理 ⇒ 失败/挂起
 * ⇒ `/auth/me` 拿不到身份 ⇒ `RouteGuard adminOnly` 整页渲染
 * 「没有访问此页面的权限」（2026-10-11 e2e 实测：`kb:4` 0/5，
 * 纯静态页面的标题都找不到）。
 *
 * 用 promise 同时满足两件事：
 *   1. **只 `worker.start()` 一次** —— 第二次调用只是 await 同一个 promise；
 *   2. **放行一定发生在真正就绪之后** —— `setReady(true)` 只挂在这条链的末尾
 *      （`start()` resolve **且** SW 已 `controllerchange`）。
 */
let mswReadyPromise: Promise<void> | null = null;

/**
 * 「已真正就绪」的缓存：**只在链路成功走完后**才置 true。
 * 它唯一的用途是让**二次挂载**（热更新／再次 mount）不必再闪一次空白；
 * 它**不能**用来表达"启动过了"（那正是旧实现的 bug）。
 */
let mswReady = false;

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
 * 启动 MSW 并等它**真正接管本页**；**同一个 realm 内只会真正启动一次**。
 *
 * 失败也必须 resolve（fail-open）：不能因为一个 mock 故障把整个应用卡成白屏，
 * 但失败**要有声音**（见下面的 `[MSW门] start FAILED`）。
 */
function ensureMswReady(): Promise<void> {
  if (mswReadyPromise) return mswReadyPromise;

  mswReadyPromise = import("@/mocks/browser")
    // `warn`：放行行为不变，但未匹配的请求会在控制台**被点名**。
    // 原先用 `bypass` 时 handler 缺失是**静默**的，这正是这个坑拖了很久的原因。
    .then((m) => m.worker.start({ onUnhandledRequest: "warn" }))
    .then((reg) => {
      // 探针：MSW 起来了，但实测**一个请求都没拦住**（缺口 0 条、
      // 兜底路由却接住 15 条）。要判定的就一件事：
      // **SW 注册成功了没有、有没有控制本页**。
      const sw =
        typeof navigator !== "undefined" && "serviceWorker" in navigator
          ? navigator.serviceWorker
          : null;
      console.log("[MSW门] started; controller =", String(Boolean(sw?.controller)));
      void sw
        ?.getRegistrations?.()
        .then((rs) => {
          const desc =
            rs
              .map((r) => `${r.scope}|${r.active ? "active" : "NO-ACTIVE"}`)
              .join(", ") || "(none)";
          console.log("[MSW门] registrations =", desc);
        })
        .catch((e) => console.log("[MSW门] getRegistrations failed:", String(e)));
      return reg;
    })
    // 再等 SW **真正接管本页**：`start()` resolve 时 `clients.claim()`
    // （activate 里的 waitUntil）可能还没生效，那段窗口里的请求会绕过 mock。
    .then(() => waitForServiceWorkerControl())
    .then(() => {
      mswReady = true;
    })
    .catch((err) => {
      // **不再静默**。原注释写"非 mock 构建里失败是预期的，静默忽略"——
      // 但在 mock 构建里，静默吞掉会让现象**完全误导**：MSW 没起来时页面照常
      // 发真实请求（e2e 里 → 自代理 → 一堆 500），而日志里**一个字都没有**，
      // 于是人会去查"请求为什么没被匹配"，而不是"mock 层根本没起来"。
      //
      // 这与 `onUnhandledRequest` 由 `bypass` 改 `warn` 是**同一类修正：
      // 失败必须有声音**。起不来仍要放行（不能把页面卡成白屏），但要说出来。
      console.log("[MSW门] start FAILED:", String(err));
    });

  return mswReadyPromise;
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
 *
 * **2026-10-11 修**：这个门原先在 `reactStrictMode: true` 下**是失效的** ——
 * 用 `started.current`（"启动过"）当放行条件，而 StrictMode 会把 effect 跑两遍，
 * 第二遍看到"启动过"就**立刻放行**，于是首屏请求仍然发在 `worker.start()` 之前。
 * 现在改成 await 模块级 **`ensureMswReady()` 的同一个 promise**（见上）：
 * 只 start 一次，且**放行只发生在真正就绪之后**。
 */
export function MswProvider({ children }: { children: React.ReactNode }) {
  // 非 mock 模式无需等待；已**真正就绪**过（热更新／二次挂载）也不必再闪一次空白。
  const [ready, setReady] = useState(() => !isMockMode || mswReady);

  useEffect(() => {
    if (!isMockMode) {
      setReady(true);
      return;
    }

    // ⚠️ StrictMode 下这个 effect 会跑两遍（mount → 模拟 unmount → mount）。
    // 第二次调用**只 await 同一个 promise**：既不会重复 `worker.start()`，
    // 也不会像旧实现那样"看到启动过就立刻放行"。
    let cancelled = false;
    void ensureMswReady().then(() => {
      if (!cancelled) setReady(true);
    });

    // 模拟 unmount 只取消**这一次**的回调；promise 继续跑，
    // 第二次调用会重新挂 `.then`，并在真正就绪后放行。
    return () => {
      cancelled = true;
    };
  }, []);

  if (!ready) return null;

  return <>{children}</>;
}
