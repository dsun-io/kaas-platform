import { test, expect } from './fixtures';

/**
 * 报价工位（原文件名 quotations.spec.ts，2026-10-11 按现役 UI 重新基线化）。
 *
 * ## 为什么整份要重写
 *
 * 旧版全部用 `page.goto('/quotations')` —— 而**那个路由已经不存在**：
 * `app/(app)/quotations/` 下只有 `components/`、`hooks/`、`v2-quote/`，
 * **没有 `page.tsx`**。Next App Router 里没有 page.tsx 就没有路由，
 * 所以那些用例访问的是 **404 页**，4 条全红（且红得没有信息量）。
 *
 * 现役页面在 **`/quotes`**（`app/(app)/quotes/page.tsx`）：一个工位外壳 +
 * 4 个**平级视图**（产品报价 / 批量报价 / 报价记录 / 成本历史），支持 `?tab=` 深链。
 *
 * ## 这次保留了什么、暂缓了什么
 *
 * 只保留**我逐个核对过源码**的断言（标题、4 个视图入口、深链）。
 * 旧版那三条**功能级**断言（估算行徽章 / `spec_not_supported` 灰色徽章 /
 * 手工录入表单校验）所对应的控件**在 /quotes 的新结构里还没定位到** ——
 * 没有把握就不写断言（**写错的断言比没有断言更糟**），改为**显式 skip
 * 并写清该覆盖什么**，等定位后补。**不静默丢覆盖。**
 */
test.describe('报价工位 /quotes', () => {
  test('工位渲染标题与 4 个平级视图入口', async ({ page }) => {
    await page.goto('/quotes');

    // `quotes/page.tsx` L69
    await expect(page.getByRole('heading', { name: '报价', exact: true })).toBeVisible({
      timeout: 15000,
    });

    // `quotes/page.tsx` L31-40 的 TABS
    for (const label of ['产品报价', '批量报价', '报价记录', '成本历史']) {
      await expect(page.getByRole('tab', { name: label })).toBeVisible();
    }
  });

  test('?tab=records 深链可用且不崩', async ({ page }) => {
    // `quotes/page.tsx` L53 读 `?tab=`，L96 按 tab 渲染 QuotationRecordsView
    await page.goto('/quotes?tab=records');

    await expect(page.getByRole('heading', { name: '报价', exact: true })).toBeVisible({
      timeout: 15000,
    });
    // 深链不应把页面打崩：外壳与入口仍然在
    await expect(page.getByRole('tab', { name: '报价记录' })).toBeVisible();
  });

  test('估算行显示警告徽章', async ({ page }) => {
    // 徽章真源：`quotations/components/quotation-table.tsx:25`（estimated → destructive
    // 「参考价 - 需人工确认」）；mock 种子含 estimated 行（mocks/data/factory.ts）。
    await page.goto('/quotes?tab=records');
    // X7 后旧台账默认收起（主视图只留 quote_orders）⇒ 先展开再断言旧表徽章
    await page.getByRole('button', { name: '展开旧台账' }).click();
    await expect(page.getByText('参考价 - 需人工确认').first()).toBeVisible({
      timeout: 15000,
    });
  });

  test('spec_not_supported 行显示灰色禁用徽章', async ({ page }) => {
    // 真源：`quotation-table.tsx:26`（spec_not_supported → secondary「已废止」）。
    await page.goto('/quotes?tab=records');
    await page.getByRole('button', { name: '展开旧台账' }).click();
    await expect(page.getByText('已废止').first()).toBeVisible({ timeout: 15000 });
  });

  test('手工录入表单对无效输入显示校验错误', async ({ page }) => {
    // 入口：`quotations/components/new-quotation-form.tsx`（records tab 常驻渲染）。
    // 用「数量 = 0」触发 `QuoteRequestSchema.items.quantity` 的 `.positive()`：
    // zod 拦截后不发请求，错误文案渲染在 `p.text-destructive`。
    // 注意：标题「人工录入报价」在 CardHeader 里、不在 `<form>` 内 ⇒ 用提交按钮定位表单。
    await page.goto('/quotes?tab=records');
    // X7 后手工补录改为 Dialog（不在主视图常驻）
    await page.getByRole('button', { name: '手工补录' }).click();
    await expect(
      page.getByRole('heading', { name: '手工补录报价（旧台账）' }),
    ).toBeVisible({ timeout: 15000 });
    const form = page
      .locator('form')
      .filter({ has: page.getByRole('button', { name: '提交报价' }) })
      .first();
    const quantity = form.locator('input[type="number"]').first();
    await quantity.fill('0');
    await form.getByRole('button', { name: '提交报价' }).click();
    await expect(form.locator('p.text-destructive').first()).toBeVisible({
      timeout: 5000,
    });
  });
});
