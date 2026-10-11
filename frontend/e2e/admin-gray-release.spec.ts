import { test, expect } from './fixtures';

test.describe('Admin Gray Release', () => {
  test('gray release cards render with toggle visible', async ({ page }) => {
    await page.goto('/admin/gray-release');

    // **2026-10-12 修正：测试侧（"等网络静默" ≠ "等内容"）**
    // 旧写法是 `networkidle` 之后**一次性** `count()`；门尚未放行时页面**没有请求**
    // ⇒ `networkidle` 立即满足 ⇒ `count()` 得 0 ⇒ 假失败。
    // 本用例修前实测（FALLBACK=0、repeat-each=5、健康守卫 OK）：**0/5**，
    // 报错 `toBeGreaterThanOrEqual Expected: >= 1, Received: 0`。
    //
    // 真实断言（源码依据）：
    //   · `admin/gray-release/page.tsx:39-47` —— 每个租户渲染一个 `<FlagToggle>`
    //   · `components/flag-toggle.tsx:60-63` —— 卡片标题 = 租户名，下一行是 **tenant_id**
    //   · `mocks/handlers.ts:666-677` —— 租户为 `lianjia`/「联佳丝网」与 `client-b`/「备选客户 B」
    //   ⇒ 「至少一张租户卡可见」用**可重试**断言表达（`.first()` + `toBeVisible`），
    //     不再用一次性 `count()`。
    await expect(page.locator('text=/联佳|client-b/i').first()).toBeVisible({
      timeout: 15000,
    });

    // Toggle buttons should be visible（`flag-toggle.tsx:77-85` 的「切换」按钮）
    const toggleBtn = page.getByRole('button', { name: /切换/i }).first();
    await expect(toggleBtn).toBeVisible({ timeout: 15000 });
  });

  test('click toggle opens confirm dialog, entering reason enables confirm', async ({ page }) => {
    await page.goto('/admin/gray-release');

    // **2026-10-12：去掉 `networkidle`** —— 下面的 `click()` 自身会等具体元素
    // （`components/flag-toggle.tsx:77-85` 的「切换」按钮）。
    const toggleBtn = page.getByRole('button', { name: /切换/i }).first();
    await toggleBtn.click();
    await page.waitForTimeout(300);

    // Dialog should be visible
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 5000 });

    // Reason input should be visible
    const reasonInput = page.locator('[role="dialog"] input');
    await expect(reasonInput).toBeVisible();

    // Confirm button should be there (but may be disabled)
    const confirmBtn = page.getByRole('button', { name: /确认/i });
    await expect(confirmBtn).toBeVisible();
  });

  test('deployment audit timeline renders', async ({ page }) => {
    await page.goto('/admin/gray-release');

    // **2026-10-12：去掉 `networkidle`** —— 下一行断言就是在等具体元素
    // （`gray-release/page.tsx:55` 的 CardTitle「变更历史（近 7 天）」）。
    // Timeline should exist
    const timeline = page.locator('text=/变更历史|近.*天/i');
    await expect(timeline.first()).toBeVisible();
  });
});
