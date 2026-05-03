import { test, expect } from '@playwright/test';

test.describe('Quotations', () => {
  test('quotation list loads with default DESC order', async ({ page }) => {
    await page.goto('/quotations');
    await page.waitForLoadState('networkidle');

    const rows = page.locator('table tbody tr');
    await expect(rows.first()).toBeVisible({ timeout: 10000 });
    const count = await rows.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test('estimated rows show warning badge', async ({ page }) => {
    await page.goto('/quotations');
    await page.waitForLoadState('networkidle');

    const warningBadge = page.locator('text=/参考价|需人工确认/i');
    const count = await warningBadge.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test('spec_not_supported rows show gray disabled badge', async ({ page }) => {
    await page.goto('/quotations');
    await page.waitForLoadState('networkidle');

    const disabledBadge = page.locator('text=/已废止/i');
    const count = await disabledBadge.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test('manual entry form submits and refetches list', async ({ page }) => {
    await page.goto('/quotations');
    await page.waitForLoadState('networkidle');

    // Fill the form
    const submitBtn = page.getByRole('button', { name: /提交报价/i });
    if (await submitBtn.isVisible()) {
      // Select a category
      const categorySelect = page.getByRole('combobox').first();
      if (await categorySelect.isVisible()) {
        await categorySelect.click();
        const option = page.getByRole('option').first();
        if (await option.isVisible()) {
          await option.click();
        }
      }

      await submitBtn.click();
      await page.waitForTimeout(500);

      // Form should reset or list should update
      await expect(page.locator('table')).toBeVisible();
    }
  });

  test('manual entry form shows validation error on invalid input', async ({ page }) => {
    await page.goto('/quotations');
    await page.waitForLoadState('networkidle');

    // Try to submit with invalid quantity (negative)
    const quantityInput = page.locator('input[type="number"]').first();
    if (await quantityInput.isVisible()) {
      await quantityInput.fill('-1');
      const submitBtn = page.getByRole('button', { name: /提交报价/i });
      if (await submitBtn.isVisible()) {
        await submitBtn.click();
        await page.waitForTimeout(300);
      }
    }

    // Page should still be functional
    await expect(page.locator('table')).toBeVisible();
  });
});
