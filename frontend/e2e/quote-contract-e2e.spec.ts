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
    // 品类选择器是搜索输入框（非下拉）。选品类（牛栏网）后，
    // 6 个规格下拉（产品类型/丝径/高度/网宽/网孔/卷长）才级联渲染。
    await page.getByPlaceholder('搜索或选择品类（支持拼音）').click();
    await page.getByText('牛栏网', { exact: true }).first().click();
    // 牛栏网 mock 数据的"网孔规格"无选项 → 该字段不渲染，实际 5 个下拉，
    // 恰好对应 5 个必填规格。选满必填值，提交时才能通过前端校验发出请求。
    const combos = page.getByRole('combobox');
    await expect(combos).toHaveCount(5, { timeout: 10000 });
    await combos.nth(0).selectOption('拧编型上疏下密');
    await combos.nth(1).selectOption('2.0x2.0');
    await combos.nth(2).selectOption('1.5');
    await combos.nth(3).selectOption('15');
    await combos.nth(4).selectOption('50');
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
