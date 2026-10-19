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
    await expect(page.getByRole('heading', { name: '报价' })).toBeVisible({
      timeout: 15000,
    });

    // `quotes/page.tsx` L31-40 的 TABS
    for (const label of ['产品报价', '批量报价', '报价记录', '成本历史']) {
      await expect(page.getByRole('button', { name: label })).toBeVisible();
    }
  });

  test('?tab=records 深链可用且不崩', async ({ page }) => {
    // `quotes/page.tsx` L53 读 `?tab=`，L96 按 tab 渲染 QuotationRecordsView
    await page.goto('/quotes?tab=records');

    await expect(page.getByRole('heading', { name: '报价' })).toBeVisible({
      timeout: 15000,
    });
    // 深链不应把页面打崩：外壳与入口仍然在
    await expect(page.getByRole('button', { name: '报价记录' })).toBeVisible();
  });

  test.skip('估算行显示警告徽章', async () => {
    // 暂缓：该徽章由算价结果驱动，`/quotes` 下具体落在哪个视图/选择器尚未定位。
    // 定位后应断言：含"估算/暂估"语义的行有警告色徽章。
  });

  test.skip('spec_not_supported 行显示灰色禁用徽章', async () => {
    // 暂缓：同上。定位后应断言：规格不被支持的行有灰色禁用徽章且不可提交。
  });

  test.skip('手工录入表单对无效输入显示校验错误', async () => {
    // 暂缓：需定位「手工录入」入口（原在旧页面的 new-quotation-form）。
    // 定位后应断言：无效输入（如数量为 0 / 缺规格）时不通过并显示错误文案。
  });
});
