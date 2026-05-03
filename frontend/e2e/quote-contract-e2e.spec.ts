import { test, expect } from '@playwright/test';

/**
 * V2 Quote page — MSW Contract / Status Override Tests.
 *
 * This file uses MSW's __test/override-quote-status endpoint to force specific
 * response statuses from the quote API. It is NOT a real backend E2E test.
 *
 * The override endpoint (POST /api/v1/__test/override-quote-status) exists ONLY in
 * frontend MSW handlers (src/mocks/handlers.ts) for Playwright and dev contract tests.
 * It is NOT implemented by the real backend and must never be used in production.
 *
 * Real backend E2E scenarios live in quote-real-backend.spec.ts.
 *
 * IMPORTANT: Each test navigates fresh (page.goto), which resets the MSW module-level
 * override variable. No explicit beforeEach/afterEach reset is needed.
 */

async function setOverride(page: any, status: string) {
  await page.evaluate(
    (s: string) => fetch('/api/v1/__test/override-quote-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: s }),
    }),
    status,
  );
}

test.describe('V2 Quote — MSW Contract / Status Override', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/quotations/v2-quote');
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('combobox')).toHaveCount(6, { timeout: 10000 });
  });

  test('unsupported_category — badge and status message shown', async ({ page }) => {
    await setOverride(page, 'unsupported');
    await page.getByRole('button', { name: '获取报价' }).click();

    await expect(page.getByText('暂不支持品类').first()).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(/仅支持牛栏网品类/)).toBeVisible();
  });

  test('no_match — badge and status message shown', async ({ page }) => {
    await setOverride(page, 'no_match');
    await page.getByRole('button', { name: '获取报价' }).click();

    await expect(page.getByText('未匹配').first()).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(/未匹配到报价规则/)).toBeVisible();
  });

  test('cost_pending — badge and status message shown', async ({ page }) => {
    await setOverride(page, 'cost_pending');
    await page.getByRole('button', { name: '获取报价' }).click();

    await expect(page.getByText('成本待处理').first()).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(/成本待维护/)).toBeVisible();
  });

  test('too_many — badge and status message shown', async ({ page }) => {
    await setOverride(page, 'too_many');
    await page.getByRole('button', { name: '获取报价' }).click();

    await expect(page.getByText('匹配过多').first()).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(/匹配到多条记录/)).toBeVisible();
  });
});
