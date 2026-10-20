import { test, expect } from './fixtures';

/**
 * 全站 a11y/一致性冒烟：核心页面逐页检查
 *  - 只有一个 h1
 *  - 表头都有 scope
 *  - 没有无名称的 icon-only 按钮
 *  - 1366 下无横向溢出
 *
 * 只做结构断言，不校验业务数据；mock 模式下页面应稳定可打开。
 */
const PAGES = [
  '/dashboard',
  '/customers',
  '/quotes',
  '/orders',
  '/trade-docs',
  '/products',
  '/events',
  '/settings',
  '/intel',
  '/shipments',
];

test('core pages pass structural a11y checks', async ({ page }) => {
  test.setTimeout(120_000);

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
