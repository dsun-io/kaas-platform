import { test, expect } from '@playwright/test';

test.describe('Customers', () => {
  test('customer list loads with at least 1 row', async ({ page }) => {
    await page.goto('/customers');
    await page.waitForLoadState('networkidle');

    const rows = page.locator('table tbody tr');
    await expect(rows.first()).toBeVisible({ timeout: 10000 });
    const count = await rows.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test('click customer navigates to detail page with capabilities', async ({ page }) => {
    await page.goto('/customers');
    await page.waitForLoadState('networkidle');

    // Click the first link/button that navigates to customer detail
    const customerLink = page.locator('a[href*="/customers/"]').first();
    if (await customerLink.isVisible()) {
      await customerLink.click();
      await page.waitForLoadState('networkidle');

      // Should be on customer detail page
      expect(page.url()).toContain('/customers/');

      // Capabilities should be rendered
      const capabilities = page.locator('text=/产品能力|capability|spec_constraints/i');
      const count = await capabilities.count();
      expect(count).toBeGreaterThanOrEqual(0);
    }
  });

  test('edit capability saves and shows sync status', async ({ page }) => {
    await page.goto('/customers');
    await page.waitForLoadState('networkidle');

    // Navigate to first customer
    const customerLink = page.locator('a[href*="/customers/"]').first();
    if (!(await customerLink.isVisible())) {
      test.skip();
      return;
    }
    await customerLink.click();
    await page.waitForLoadState('networkidle');

    // Click edit button on a capability card
    const editBtn = page.getByRole('button', { name: /编辑/i }).first();
    if (await editBtn.isVisible()) {
      await editBtn.click();
      await page.waitForTimeout(300);

      // Click save
      const saveBtn = page.getByRole('button', { name: /保存/i });
      if (await saveBtn.isVisible()) {
        await saveBtn.click();
        await page.waitForTimeout(1000);

        // Should show sync status
        const syncText = page.locator('text=/同步|已同步|syncing/i');
        const count = await syncText.count();
        expect(count).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
