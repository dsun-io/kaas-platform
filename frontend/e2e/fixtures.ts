/**
 * e2e 的公共 fixture。
 *
 * 唯一职责：把页面 console 里 **MSW 的「未匹配请求」警告**转发到 stdout。
 *
 * 为什么需要它：MSW 的 `onUnhandledRequest: "warn"` 走的是 `console.warn`，
 * 而 **Playwright 默认不把页面 console 转发到 stdout** —— 于是
 * 「哪个请求没被 mock」这条最关键的信息在 CI 日志里**根本看不到**，
 * 只能从 dev server 的 rewrite 报错（`EADDRINUSE`）反推**结果**。
 *
 * 这条线索在 2026-10-11 量过：e2e 的失败**不是**"少一次数据"，
 * 而是**请求失败 → 页面进错误边界**（页面显示「页面加载异常 / 后端繁忙」）。
 * 也就是说缺一个 mock 就足以让整页不可用。
 *
 * 只转这一条，不转整页 console（否则日志会被淹掉，关键信息反而找不到）。
 * 试过用 `onUnhandledRequest: "error"` 让缺口自证，**已证伪并回退**：
 * 它把 9 failed/15 passed 打成 19/5，而警告仍然没进 stdout。
 */
import { test as base, expect } from '@playwright/test';

export const test = base.extend({
  page: async ({ page }, use) => {
    page.on('console', (msg) => {
      const text = msg.text();
      if (text.includes('intercepted a request without a matching request handler')) {
        console.log('[MSW缺口]', text.replace(/\s+/g, ' ').slice(0, 400));
      }
    });

    // 应用侧探针（见 msw-provider.tsx 的 [MSW门]）：
    // 「MSW 是否起来了 / SW 是否控制本页 / 有没有注册记录」都靠它带出来。
    page.on('console', (msg) => {
      const text = msg.text();
      if (text.includes('[MSW门]')) {
        console.log('[应用探针]', text.replace(/\s+/g, ' ').slice(0, 300));
      }
    });

    // **决定性仪器**：`response.fromServiceWorker()` 直接回答
    // 「这个响应是不是 MSW（Service Worker）给的」。
    //
    // 之前只能从 dev server 的反向报错（rewrite 的 EADDRINUSE）去猜，
    // 既看不到是**哪个**请求，也分不清"没被匹配"与"没被接管"。
    // 有了这一条，绕过 mock 的 `/api/v1/*` 请求会**逐个点名**。
    page.on('response', (res) => {
      const url = res.url();
      if (!url.includes('/api/v1/')) return;
      if (res.fromServiceWorker()) return;   // 走了 MSW = 正常
      console.log(
        '[绕过MSW]',
        `${res.request().method()} ${url.replace('http://localhost:3000', '')}`,
        `-> ${res.status()}`,
      );
    });

    // ── 兜底路由：接住**绕过 MSW** 的 /api/v1 请求 ──────────────────────
    //
    // 为什么这能工作：**被 Service Worker 处理的请求根本到不了 `page.route`**
    // （Playwright：SW 拦截的请求不经 page.route）。所以这里只会看到
    // **漏网的那些** —— 正是要处理的。
    //
    // 它们原本的遭遇：直连 dev server → `/api/v1/*` rewrite → 自己代理自己
    // → **500 或永久挂起** → `/auth/me` 失败 → 会话被清 → 守卫渲染
    // 「您没有访问此页面的权限」；其余 → 错误边界；挂起 → networkidle 超时。
    //
    // 这里给两类答复：
    //   · `/auth/me` → 与 MSW 同一个管理员身份（**直接解掉"无权限"**）
    //   · 其余 → 200 `{}`：形状可能不够，但**比 500 好**（不崩、不挂），
    //     并且下面会把名字打出来，缺口依旧可见
    // 可用 `E2E_FALLBACK=0` 关闭 —— 用来判定
    // 「Playwright 的 page.route 是否先于 Service Worker 拦截」
    // （若是，则兜底路由其实**抢走了 MSW 的活**，而不是"只接漏网的"）。
    const fallbackEnabled = process.env.E2E_FALLBACK !== '0';
    if (fallbackEnabled) await page.route('**/api/v1/**', async (route) => {
      const reqUrl = route.request().url();
      const path = reqUrl.replace(/^https?:\/\/[^/]+/, '');
      console.log('[兜底路由]', route.request().method(), path);
      if (path.startsWith('/api/v1/auth/me')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            user_id: 1,
            email: 'admin@kaas.local',
            display_name: '平台管理员',
            account_type: 'internal',
            role: 'system_admin',
            plan: 'enterprise',
            team_id: null,
            team_name: null,
            console_access: true,
          }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: '{}',
      });
    });

    await use(page);
  },
});

export { expect };
