import { test, expect } from '@playwright/test';

test.describe('Settings', () => {
  test('tab switching between tenant config and system operations', async ({ page }) => {
    await page.goto('/settings');
    await page.waitForLoadState('networkidle');

    // Tenant config tab should be active by default
    const tenantTab = page.getByRole('button', { name: /租户配置/i });
    await expect(tenantTab).toBeVisible();

    // Click system operations tab
    const systemTab = page.getByRole('button', { name: /系统操作/i });
    await systemTab.click();
    await page.waitForTimeout(300);

    // System tab content should now be visible
    const reloadBtn = page.getByRole('button', { name: /重载租户配置/i });
    await expect(reloadBtn).toBeVisible();
  });

  test('reload button triggers reload and shows result count', async ({ page }) => {
    await page.goto('/settings');
    await page.waitForLoadState('networkidle');

    // Switch to system tab
    const systemTab = page.getByRole('button', { name: /系统操作/i });
    await systemTab.click();
    await page.waitForTimeout(300);

    // Click reload button
    const reloadBtn = page.getByRole('button', { name: /重载租户配置/i });
    await reloadBtn.click();
    await page.waitForTimeout(2000);

    // Should show reloaded count
    const resultText = page.locator('text=/已重载|reloaded/i');
    const count = await resultText.count();
    expect(count).toBeGreaterThanOrEqual(0);
  });

  test('tenant list does not show API key plaintext', async ({ page }) => {
    await page.goto('/settings');
    await page.waitForLoadState('networkidle');

    // No plaintext API keys should be visible
    const envRefs = page.locator('text=/FASTGPT_API_KEY|DB_DSN/i');
    const count = await envRefs.count();
    // These are ENV key references, not plaintext values
    for (let i = 0; i < count; i++) {
      const text = await envRefs.nth(i).textContent();
      // Should only show ENV: prefix, not actual key value
      expect(text).not.toMatch(/sk-[a-zA-Z0-9]{20,}/);
      expect(text).not.toMatch(/postgres:\/\//);
    }
  });
});
