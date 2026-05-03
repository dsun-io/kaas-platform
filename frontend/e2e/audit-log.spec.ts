import { test, expect } from '@playwright/test';

test.describe('Audit Log', () => {
  test('page loads with filter bar and table', async ({ page }) => {
    await page.goto('/audit-log');
    await page.waitForLoadState('networkidle');

    // Heading should be visible
    await expect(page.getByRole('heading', { name: '操作日志' })).toBeVisible({ timeout: 10000 });

    // Filter card should be visible
    await expect(page.getByText('日志筛选')).toBeVisible();

    // Table should have rows (or empty state if MSW not intercepting)
    const hasRows = page.locator('table tbody tr');
    const hasEmpty = page.getByText('暂无操作记录');
    await expect(hasRows.first().or(hasEmpty)).toBeVisible({ timeout: 10000 });
  });

  test('click row expands detail JSON', async ({ page }) => {
    await page.goto('/audit-log');
    await page.waitForLoadState('networkidle');

    // Click first table row
    const firstRow = page.locator('table tbody tr').first();
    await firstRow.click();
    await page.waitForTimeout(300);

    // JSON detail should be visible somewhere on the page
    const jsonText = page.getByText(/actor_id|timestamp|action/i);
    const count = await jsonText.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });
});
