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
  test('Scenario 1: 牛栏网 single product', async ({ page }) => {
    await page.goto('/quotations/v2-quote');
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('combobox')).toHaveCount(6, { timeout: 10000 });

    // Fill first product line: 牛栏网 specs
    // combobox 0 = product_category (already 牛栏网)
    await selectOption(page, 1, '上疏下密');
    await selectOption(page, 2, '2.5x2.0');
    await selectOption(page, 3, '1.5m');
    await selectOption(page, 4, '15mm');
    await selectOption(page, 5, '50m');
    await page.locator('input[type="number"]').first().fill('100');
    await page.getByPlaceholder('如：广东省').fill('四川');

    await page.getByRole('button', { name: '获取报价' }).click();

    // Verify matched result
    await expect(page.locator('span').filter({ hasText: '已匹配' }).first()).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(/产品明细/)).toBeVisible();
    await expect(page.getByText(/梯度价格/)).toBeVisible();
    await expect(page.getByText(/报价合计/)).toBeVisible();
    await expect(page.getByText(/可复制话术/).first()).toBeVisible();
  });

  test('Scenario 2: 牛栏网 + 立柱 combined quote', async ({ page }) => {
    await page.goto('/quotations/v2-quote');
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('combobox')).toHaveCount(6, { timeout: 10000 });

    // Fill first product line: 牛栏网
    await selectOption(page, 1, '上疏下密');
    await selectOption(page, 2, '2.5x2.0');
    await selectOption(page, 3, '1.5m');
    await selectOption(page, 4, '15mm');
    await selectOption(page, 5, '50m');
    await page.locator('input[type="number"]').first().fill('50');

    // Add second product line: 立柱
    await page.getByRole('button', { name: /添加产品/i }).click();
    await page.waitForTimeout(500);

    // Select 立柱 category in the second card
    await page.getByRole('combobox').nth(6).click();
    await page.getByRole('option', { name: '立柱' }).click();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(1000); // Wait for 立柱 specs to load

    // Fill 立柱 specs: product type + height
    // combobox 7 = product_type for 立柱
    await selectOption(page, 7, '直边');
    // combobox 8 = height for 立柱
    await selectOption(page, 8, '1.8m');

    await page.locator('input[type="number"]').nth(1).fill('30');

    // Province
    await page.getByPlaceholder('如：广东省').fill('广东省');

    await page.getByRole('button', { name: '获取报价' }).click();

    // Verify matched with products + freight
    await expect(page.locator('span').filter({ hasText: '已匹配' }).first()).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(/产品明细/)).toBeVisible();
    await expect(page.getByText(/梯度价格/)).toBeVisible();
    await expect(page.getByText(/运费/)).toBeVisible();
    await expect(page.getByText(/可复制话术/).first()).toBeVisible();
  });
});
