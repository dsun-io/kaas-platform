import { test, expect } from './fixtures';

test.describe('Knowledge Base', () => {
  test('page loads with stat cards and placeholder', async ({ page }) => {
    await page.goto('/kb');

    // **2026-10-12：去掉 `networkidle`** —— 下一行断言就是在等具体元素
    // （`kb/page.tsx:22` 的 h1「知识库管理」，纯静态页）。
    // Heading should be visible
    await expect(page.getByRole('heading', { name: '知识库管理' })).toBeVisible();

    // At least one stat card should be visible
    const cards = page.getByTestId('stat-card');
    await expect(cards.first()).toBeVisible({ timeout: 10000 });

    // Placeholder area should mention 即将上线 or 建设中
    const badge = page.locator('text=/建设中|即将上线/i');
    const count = await badge.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });
});
