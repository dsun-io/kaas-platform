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
    await use(page);
  },
});

export { expect };
