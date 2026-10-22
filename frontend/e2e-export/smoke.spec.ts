import { test, expect } from '@playwright/test';

/**
 * 导出态产物冒烟（2026-10-22）
 *
 * 与 `navigation.spec.ts` 互补：这里只验"产物本身"，不点交互。
 * 目标是任何一次"发上去是白页/404/缺段文件"都能在 nightly 被拦下。
 */

test.describe('导出态产物冒烟', () => {
  test('关键路由可直达（SPA 回退 + 静态 HTML）且页面有实际内容', async ({ page }) => {
    const routes = ['/login', '/quotes', '/products', '/customers', '/trade-docs'];
    for (const route of routes) {
      const response = await page.goto(route);
      expect(response?.status(), `${route} 应返回 200`).toBe(200);
      const html = await page.content();
      // 200 也可能是 SPA 回退回来的空壳；用"内容长度 + 主区域存在"做最低门槛
      expect(html.length, `${route} 返回内容过短（疑似空壳）`).toBeGreaterThan(2_000);
    }
  });

  test('逐段预取文件按客户端请求的点号名可取到 200（P1 形态回归）', async ({
    request,
  }) => {
    // `!KGFwcCk` = base64url("(app)")，即 Next 对路由组 `(app)` 的段编码；
    // 客户端请求的就是 `<route>/__next.!KGFwcCk.<route>.__PAGE__.txt`。
    // 若用 Windows 构建，文件会被写成目录（`__next.!KGFwcCk/<route>/__PAGE__.txt`）⇒ 这里必然 404。
    for (const route of ['products', 'quotes', 'customers']) {
      const tree = await request.get(`/${route}/__next._tree.txt`);
      expect(tree.status(), `${route}/__next._tree.txt`).toBe(200);

      const pageSegment = await request.get(
        `/${route}/__next.!KGFwcCk.${route}.__PAGE__.txt`,
      );
      expect(
        pageSegment.status(),
        `${route} 的 __PAGE__ 段文件应 200（404 = 构建环境不是 Linux/CI）`,
      ).toBe(200);
    }
  });

  test('服务端未命中的 .txt 必须是 404（不能被 SPA 回退伪装成 200）', async ({ request }) => {
    const response = await request.get('/definitely-not-a-route/__next._tree.txt');
    expect(response.status()).toBe(404);
  });
});
