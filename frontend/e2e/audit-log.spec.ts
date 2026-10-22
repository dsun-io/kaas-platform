import { test, expect } from './fixtures';

test.describe('Audit Log', () => {
  test('page loads with filter bar and table', async ({ page }) => {
    await page.goto('/audit-log');

    // **2026-10-12：去掉 `networkidle`** —— 下一行断言就是在等具体元素
    // （`audit-log/page.tsx:191` 的 h1「操作日志」），不需要额外等待。
    // Heading should be visible
    await expect(
      page.getByRole('heading', { level: 1, name: '操作日志' }),
    ).toBeVisible({ timeout: 10000 });

    // Filter card should be visible
    await expect(page.getByText('日志筛选')).toBeVisible();

    // Table should have rows (or empty state if MSW not intercepting)
    const hasRows = page.locator('table tbody tr');
    const hasEmpty = page.getByText('暂无操作记录');
    await expect(hasRows.first().or(hasEmpty)).toBeVisible({ timeout: 10000 });
  });

  test('click row expands summary; raw JSON collapses behind 查看详情', async ({ page }) => {
    await page.goto('/audit-log');

    // **2026-10-12：把 `networkidle` 换成等具体元素**（表格首行）。
    // 源码：`audit-log/page.tsx` —— 只有 `items.length > 0` 才渲染 `<Table>`；
    // mock `/admin/audit-log` 有 5+ 条（`mocks/handlers.ts`）。
    const firstRow = page.locator('table tbody tr').first();
    await expect(firstRow).toBeVisible({ timeout: 15000 });

    // Click first table row ⇒ 展开中文摘要
    await firstRow.click();

    // 2026-10-22：原始 JSON 默认折叠（设计稿 §1/§7），先出现的是「查看详情（一般不需要看）」
    const rawToggle = page
      .getByRole('button', { name: '查看详情（一般不需要看）' })
      .first();
    await expect(rawToggle).toBeVisible({ timeout: 10000 });
    expect(await page.getByText(/actor_id|timestamp/i).count()).toBe(0);

    // 点开后原始 JSON 才出现
    await rawToggle.click();
    await expect(page.getByText(/actor_id|timestamp/i).first()).toBeVisible({
      timeout: 10000,
    });
  });
});
