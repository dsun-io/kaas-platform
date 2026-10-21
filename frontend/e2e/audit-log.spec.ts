import { test, expect } from './fixtures';

test.describe('Audit Log', () => {
  test('page loads with filter bar and table', async ({ page }) => {
    await page.goto('/audit-log');

    // **2026-10-12：去掉 `networkidle`** —— 下一行断言就是在等具体元素
    // （`audit-log/page.tsx:191` 的 h1「操作日志」），不需要额外等待。
    // Heading should be visible
    await expect(
      page.getByRole('heading', { level: 1, name: '操作日志' }),
    ).toBeVisible({ timeout: 10000 });

    // Filter card should be visible
    await expect(page.getByText('日志筛选')).toBeVisible();

    // Table should have rows (or empty state if MSW not intercepting)
    const hasRows = page.locator('table tbody tr');
    const hasEmpty = page.getByText('暂无操作记录');
    await expect(hasRows.first().or(hasEmpty)).toBeVisible({ timeout: 10000 });
  });

  test('click row expands detail JSON', async ({ page }) => {
    await page.goto('/audit-log');

    // **2026-10-12：把 `networkidle` 换成等具体元素**（表格首行）。
    // 源码：`audit-log/page.tsx:228-247` —— 只有 `items.length > 0` 才渲染 `<Table>`；
    // mock `/admin/audit-log` 有 5+ 条（`mocks/handlers.ts:588-663`）。
    // 这样若行确实不存在，失败会是有信息量的 `element(s) not found`，
    // 而不是 `click` 的 30s 超时。
    const firstRow = page.locator('table tbody tr').first();
    await expect(firstRow).toBeVisible({ timeout: 15000 });

    // Click first table row
    await firstRow.click();
    await page.waitForTimeout(300);

    // JSON detail should be visible somewhere on the page
    const jsonText = page.getByText(/actor_id|timestamp|action/i);
    const count = await jsonText.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });
});
