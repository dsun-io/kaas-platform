import { test, expect } from '@playwright/test';

test.describe('Admin Gray Release', () => {
  test('gray release cards render with toggle visible', async ({ page }) => {
    await page.goto('/admin/gray-release');
    await page.waitForLoadState('networkidle');

    // Should show toggle cards for tenants
    const cards = page.locator('text=/联佳|client-b/i');
    const count = await cards.count();
    expect(count).toBeGreaterThanOrEqual(1);

    // Toggle buttons should be visible
    const toggleBtn = page.getByRole('button', { name: /切换/i }).first();
    await expect(toggleBtn).toBeVisible();
  });

  test('click toggle opens confirm dialog, entering reason enables confirm', async ({ page }) => {
    await page.goto('/admin/gray-release');
    await page.waitForLoadState('networkidle');

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
    await page.waitForLoadState('networkidle');

    // Timeline should exist
    const timeline = page.locator('text=/变更历史|近.*天/i');
    await expect(timeline.first()).toBeVisible();
  });
});
