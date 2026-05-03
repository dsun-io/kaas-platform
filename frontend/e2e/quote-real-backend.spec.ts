import { test, expect } from '@playwright/test';

/**
 * V2 Quote page — REAL BACKEND E2E scenarios.
 *
 * This file targets the real backend (NEXT_PUBLIC_API_MODE=real, backend port 8000).
 * In mock mode these scenarios also pass because MSW mocks match the real backend contract
 * (verified via curl in INT-R4.5), but the test itself does NOT use __test/override-quote-status
 * or any MSW-specific test helpers.
 *
 * MSW contract/status-override tests live in quote-contract-e2e.spec.ts.
 */

async function selectOption(page: any, comboboxIndex: number, optionName: string) {
  await page.getByRole('combobox').nth(comboboxIndex).click();
  await page.getByRole('option', { name: optionName }).click();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
}

test.describe('V2 Quote — Real Backend Scenarios', () => {
  test('Scenario 1: matched — valid specs return tiered pricing', async ({ page }) => {
    await page.goto('/quotations/v2-quote');
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('combobox')).toHaveCount(6, { timeout: 10000 });

    // Fill form: 牛栏网 + required specs + province
    await selectOption(page, 1, '上疏下密');
    await selectOption(page, 2, '2.5x2.0');
    await selectOption(page, 3, '15mm');
    await selectOption(page, 4, '1.5m');
    await selectOption(page, 5, '50m');
    await page.locator('input[type="number"]').first().fill('100');
    await page.getByPlaceholder('如：广东省').fill('四川');

    await page.getByRole('button', { name: '获取报价' }).click();

    // Verify matched result
    await expect(page.locator('span').filter({ hasText: '已匹配' }).first()).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(/梯度价格/)).toBeVisible();
    await expect(page.getByText(/总计/)).toBeVisible();
    // Use role='cell' to avoid matching the textarea content which also contains 182.33
    await expect(page.getByRole('cell', { name: /182\.33/ })).toBeVisible();
    await expect(page.getByText(/可复制话术/).first()).toBeVisible();
  });

  test('Scenario 2: matched with accessories and freight', async ({ page }) => {
    await page.goto('/quotations/v2-quote');
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('combobox')).toHaveCount(6, { timeout: 10000 });

    // Fill main product specs
    await selectOption(page, 1, '上疏下密');
    await selectOption(page, 2, '2.5x2.0');
    await selectOption(page, 3, '15mm');
    await selectOption(page, 4, '1.5m');
    await selectOption(page, 5, '50m');
    await page.locator('input[type="number"]').first().fill('50');

    // Add accessory: 立柱
    await page.getByRole('button', { name: /添加配件/i }).click();
    await page.waitForTimeout(300);

    // Set accessory quantity
    await page.locator('input[type="number"]').nth(1).fill('30');

    // Enter province
    await page.getByPlaceholder('如：广东省').fill('广东省');

    await page.getByRole('button', { name: '获取报价' }).click();

    // Verify matched with accessories + freight
    await expect(page.locator('span').filter({ hasText: '已匹配' }).first()).toBeVisible({ timeout: 10000 });
    // Use role='heading' to avoid matching form labels / column headers
    await expect(page.getByRole('heading', { name: '配件' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '运费' })).toBeVisible();
    await expect(page.getByText(/广东省/).first()).toBeVisible();
    await expect(page.getByText(/可复制话术/).first()).toBeVisible();
  });
});
