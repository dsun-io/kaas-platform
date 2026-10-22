import { test, expect } from '@playwright/test';

/**
 * 导出态导航回归（2026-10-22）
 *
 * 覆盖 2026-10-22 生产事故 P0：**静态导出下点侧边栏无反应**。
 * 根因是 `Link prefetch={true}` 在 `output:"export"` 下让点击导航永久挂死
 * （linkClicked 先 preventDefault，随后等 prefetch 永不 resolve：30s 零请求零报错）。
 * dev 态 e2e 抓不到 —— 因为 dev 下 prefetch 路径不挂。
 *
 * 断言策略（每条都对应一个可观测事实，不写"看起来对"）：
 *   ① 点击后 URL 真变化（dev 态下这条在 false 配置下也会过，所以要叠加 ②③）；
 *   ② 发生 `/xxx.txt?_rsc=…` 的 RSC 导航请求且 **200**（= 走的是导出态客户端路由，不是整页刷新）；
 *   ③ 全程无 `*__next*.txt` 的 4xx/5xx（= 逐段预取文件形态正确，P1 回归）；
 *   ④ `window.next.router` 存在（= 客户端 chunk 已执行，排除"白页但 200"）。
 */

test.describe('导出态导航（P0 回归：点击侧边栏必须真跳转）', () => {
  test('点「产品」→ URL 变成 /products，且伴随 RSC 200（不是整页刷新）', async ({
    page,
  }) => {
    const rsc: { url: string; status: number }[] = [];
    page.on('response', (r) => {
      const url = r.url();
      if (/\.txt(\?|$)/.test(url)) rsc.push({ url, status: r.status() });
    });

    await page.goto('/quotes');
    await expect(page.locator('nav a[href="/products"]').first()).toBeVisible();

    // 客户端确实跑起来了（否则点击无反应也可能是 bundle 没执行）
    await expect
      .poll(async () => page.evaluate(() => Boolean((window as unknown as { next?: { router?: unknown } }).next?.router)))
      .toBe(true);

    await page.locator('nav a[href="/products"]').first().click();

    await expect(page).toHaveURL(/\/products$/, { timeout: 15_000 });
    const navRequests = rsc.filter((r) => r.url.includes('/products.txt'));
    expect(
      navRequests.some((r) => r.status === 200),
      `期望出现 /products.txt?_rsc=… 的 200；实际捕获：${JSON.stringify(rsc)}`,
    ).toBe(true);
  });

  test('连续点三个侧边栏入口都不挂死（P0 的"卡住"是永久性的，不能只测一次）', async ({
    page,
  }) => {
    await page.goto('/quotes');
    await expect(page.locator('nav a[href="/products"]').first()).toBeVisible();

    const steps: [string, RegExp][] = [
      ['/products', /\/products$/],
      ['/customers', /\/customers$/],
      ['/dashboard', /\/dashboard$/],
    ];
    for (const [href, pattern] of steps) {
      await page.locator(`nav a[href="${href}"]`).first().click();
      await expect(page, `点 ${href} 后 URL 未变化（疑似 prefetch+导出态挂死复发）`).toHaveURL(
        pattern,
        { timeout: 15_000 },
      );
    }
  });

  test('导航全程无 __next*.txt 的 4xx（P1 回归：逐段预取文件必须可解析）', async ({ page }) => {
    const failures: string[] = [];
    page.on('response', (r) => {
      const url = r.url();
      if (/__next.*\.txt/.test(url) && r.status() >= 400) {
        failures.push(`${r.status()} ${url}`);
      }
    });

    await page.goto('/quotes');
    await expect(page.locator('nav a[href="/products"]').first()).toBeVisible();
    // 首屏会给侧边栏所有入口发 prefetch，等它们打完再点，才能把"预取文件 404"抓全
    await page.waitForTimeout(1_500);
    await page.locator('nav a[href="/products"]').first().click();
    await expect(page).toHaveURL(/\/products$/, { timeout: 15_000 });
    await page.waitForTimeout(1_500);

    expect(
      failures,
      `逐段预取出现失败（Windows 构建会写成目录、客户端点号名 404）：\n${failures.join('\n')}`,
    ).toEqual([]);
  });
});
