import fs from 'node:fs';
import path from 'node:path';

import { test, expect } from './fixtures';

/**
 * 全站 a11y/一致性冒烟：自动发现 `src/app/(app)` 下所有 page.tsx。
 * 新增页面不需要改这份清单，路由会自动纳入硬约束。
 *
 * 逐页检查：
 *  - 只有一个 h1
 *  - 表头都有 scope
 *  - 没有无名称的 icon-only 按钮
 *  - 1366 下无横向溢出
 *
 * 只做结构断言，不校验业务数据；mock 模式下页面应稳定可打开。
 */
const APP_DIR = path.join(process.cwd(), 'src', 'app', '(app)');

function collectRoutes(dir: string, prefix: string): string[] {
  const routes: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const routePath = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      routes.push(...collectRoutes(full, routePath));
    } else if (entry.name === 'page.tsx') {
      routes.push(prefix || '/');
    }
  }
  return routes;
}

const PAGES = collectRoutes(APP_DIR, '').sort();

test('all app routes pass structural a11y checks', async ({ page }) => {
  test.setTimeout(240_000);
  expect(PAGES.length, '至少发现一个 (app) 路由').toBeGreaterThan(0);

  for (const path of PAGES) {
    await page.goto(path);
    await expect(page.locator('h1')).toHaveCount(1, { timeout: 15_000 });

    const result = await page.evaluate(() => {
      const th = Array.from(document.querySelectorAll('th'));
      const buttons = Array.from(document.querySelectorAll('button'));
      const unlabeled = buttons.filter((b) => {
        const text = (b.textContent ?? '').trim();
        const named =
          b.getAttribute('aria-label') ||
          b.getAttribute('aria-labelledby') ||
          b.getAttribute('title');
        const img = b.querySelector('img[alt]:not([alt=""])');
        return !text && !named && !img;
      }).length;
      return {
        h1: document.querySelectorAll('h1').length,
        unscopedTh: th.filter((t) => !t.getAttribute('scope')).length,
        unlabeled,
        overflow: document.documentElement.scrollWidth > window.innerWidth,
      };
    });

    expect(result.h1, `${path} h1`).toBe(1);
    expect(result.unscopedTh, `${path} 无 scope 表头`).toBe(0);
    expect(result.unlabeled, `${path} 无名称按钮`).toBe(0);
    expect(result.overflow, `${path} 横向溢出`).toBe(false);
  }
});
