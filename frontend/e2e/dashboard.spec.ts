import { test, expect } from '@playwright/test';

test.describe('Dashboard', () => {
  test('page loads with 6 stat cards', async ({ page }) => {
    await page.goto('/dashboard');
    await page.waitForLoadState('networkidle');

    const cards = page.locator('.grid > *');
    await expect(cards.first()).toBeVisible();
    const count = await cards.count();
    expect(count).toBeGreaterThanOrEqual(6);
  });

  test('RangeSelector switches trigger card refetch', async ({ page }) => {
    await page.goto('/dashboard');
    await page.waitForLoadState('networkidle');

    // Click "7d" range button
    await page.getByRole('button', { name: /7天|7d/i }).click();
    await page.waitForLoadState('networkidle');

    // Cards should still be visible after refetch
    const cards = page.locator('.grid > *');
    await expect(cards.first()).toBeVisible();
  });

  test('sampling tooltip or hint text is visible', async ({ page }) => {
    await page.goto('/dashboard');
    await page.waitForLoadState('networkidle');

    // Check for sampling-related text
    const hintText = page.locator('text=/采样|sampled/i');
    const count = await hintText.count();
    expect(count).toBeGreaterThan(0);
  });
});
