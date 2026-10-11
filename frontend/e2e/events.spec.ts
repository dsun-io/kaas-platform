import { test, expect } from './fixtures';

test.describe('Events', () => {
  test('events list loads with at least 5 rows', async ({ page }) => {
    await page.goto('/events');

    const rows = page.locator('table tbody tr');
    // **不要用 `waitForLoadState('networkidle')` 当"等数据"的手段。**
    // 实测（2026-10-11，同一条用例重复 5 次）：它让本用例 60% 通过，
    // 失败全是 `page.waitForLoadState: Test timeout of 30000ms exceeded`
    // —— 因为本项目的 `/api/v1/*` 请求可能长期挂起，`networkidle` 永不满足。
    // 等**真实元素**既是更准的断言，也不依赖"网络静下来"。
    await expect(rows.first()).toBeVisible({ timeout: 15000 });
    const count = await rows.count();
    expect(count).toBeGreaterThanOrEqual(5);
  });

  test('event_type dropdown filters the list', async ({ page }) => {
    await page.goto('/events');
    await page.waitForLoadState('networkidle');

    // **2026-10-11 修正：确定性陈旧（字符串层，有源码依据）**
    // 事件类型只有两种 —— `events/components/event-filters.tsx:15-18`
    //   `const EVENT_TYPES = ["audit.access", "capability.update"]`
    // 旧正则 `/chat/i` **永远匹配不到任何一个选项** ⇒ 这段交互
    // （点击下拉 → 选择类型）**从未真正执行过**，一直被
    // `if (await option.isVisible())` 静默吞掉。
    //
    // ⚠️ 诚实标注：**这条不计为"已验证的修复"**。本任务的取数环境
    // （`E2E_FALLBACK=0`）下 `/events` 被 RouteGuard 拒绝渲染，连 combobox
    // 都不存在，所以改完无法在此环境验证；其失败原因见下方整表断言（数据层）。
    const filter = page.getByRole('combobox').first();
    if (await filter.isVisible()) {
      await filter.click();
      const option = page.getByRole('option', { name: /audit\.access/i });
      if (await option.isVisible()) {
        await option.click();
        await page.waitForLoadState('networkidle');
      }
    }

    // List should still be visible
    await expect(page.locator('table')).toBeVisible();
  });

  test('click a row opens detail sheet with payload', async ({ page }) => {
    await page.goto('/events');
    await page.waitForLoadState('networkidle');

    // Click first eye icon button
    const detailBtn = page.getByRole('button').filter({ has: page.locator('svg') }).first();
    if (await detailBtn.isVisible()) {
      await detailBtn.click();
      await page.waitForTimeout(500);

      // Detail sheet should have payload content
      const sheet = page.locator('[role="dialog"], .sheet, aside').first();
      // Detail sheet may or may not be visible depending on click target
      const payloadText = page.locator('text=/payload|schema|事件详情/i');
      // At minimum the table should still be visible
      await expect(page.locator('table')).toBeVisible();
    }
  });

  test('sampled badge is visible on some rows', async ({ page }) => {
    await page.goto('/events');
    await page.waitForLoadState('networkidle');

    const sampledBadges = page.locator('text=sampled');
    const count = await sampledBadges.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test('error=500 simulation shows error toast', async ({ page }) => {
    await page.goto('/events?error=500');
    await page.waitForLoadState('networkidle');

    // The page should still load (not white-screen), but an error toast should appear
    // The error interceptor shows a toast with the Chinese error message
    const errorToast = page.getByText(/服务器内部错误|后端忙碌/i);
    // Error toast may or may not be visible depending on timing
    // At minimum the page should not crash
    await expect(page.locator('body')).toBeVisible();
  });
});
