import { test, expect } from './fixtures';

/**
 * 客户管理页（同页面板，不是路由跳转）。
 *
 * 2026-10-18 重写：此前两条用例是 `test.skip`（控件不存在/路由不存在），
 * 本轮补上「编辑档案 / 删除客户 / 手动切换阶段」三个入口后重写为真实用例。
 *
 * 注意：e2e 跑 MSW mock（playwright.config.ts 里 NEXT_PUBLIC_API_MODE=mock），
 * mock store 在**页面刷新后重置**，因此这里只断言「本次会话内写入即可见」；
 * 「刷新后仍在」的持久化由真实后端（Docker + Postgres）在验收脚本里验证。
 */
test.describe('Customers', () => {
  test('customer list loads with at least 1 row', async ({ page }) => {
    await page.goto('/customers');
    const cards = page.getByTestId('customer-card');
    await expect(cards.first()).toBeVisible({ timeout: 15000 });
    expect(await cards.count()).toBeGreaterThanOrEqual(1);
  });

  test('create customer appears in list and opens detail panel', async ({
    page,
  }) => {
    await page.goto('/customers');
    await page.getByRole('button', { name: '新建客户' }).click();

    const company = `e2e 客户 ${Date.now()}`;
    await page.getByPlaceholder('公司名称（与联系人至少填一个）').fill(company);
    await page.getByRole('button', { name: '创建客户' }).click();

    // 新建后：列表卡片出现 + 详情面板打开
    await expect(page.getByTestId('customer-card').filter({ hasText: company }))
      .toBeVisible({ timeout: 10000 });
    await expect(page.getByRole('button', { name: '编辑档案' })).toBeVisible();
  });

  test('edit customer profile saves and reflects in detail panel', async ({
    page,
  }) => {
    await page.goto('/customers');
    await page
      .getByTestId('customer-card')
      .filter({ hasText: '联佳丝网' })
      .click();

    await page.getByRole('button', { name: '编辑档案' }).click();
    await page.getByPlaceholder('国家').fill('DE');
    await page.getByRole('button', { name: '保存档案' }).click();

    // 信息页展示的是 detail 数据；保存后 invalidate 会重新拉取
    await expect(page.getByText('DE')).toBeVisible({ timeout: 10000 });
  });

  test('manual stage change sticks (活跃 / 沉寂)', async ({ page }) => {
    await page.goto('/customers');
    await page
      .getByTestId('customer-card')
      .filter({ hasText: '联佳丝网' })
      .click();

    await page.getByRole('button', { name: '更新阶段' }).click();
    // 2026-10-20：原生 <select> 已换成统一 Select（base-ui），按可访问名操作
    await page.getByRole('combobox', { name: '客户阶段' }).click();
    await page.getByRole('option', { name: '沉寂' }).click();
    await page.getByRole('button', { name: '保存阶段' }).click();

    // 保存后详情面板阶段徽章应为「沉寂」
    await expect(page.getByText('沉寂').first()).toBeVisible({
      timeout: 10000,
    });
  });

  test('delete customer removes it from list', async ({ page }) => {
    await page.goto('/customers');
    await page.getByRole('button', { name: '新建客户' }).click();
    const company = `待删客户 ${Date.now()}`;
    await page.getByPlaceholder('公司名称（与联系人至少填一个）').fill(company);
    await page.getByRole('button', { name: '创建客户' }).click();
    const card = page
      .getByTestId('customer-card')
      .filter({ hasText: company });
    await expect(card).toBeVisible({ timeout: 10000 });

    // 新建后详情面板已打开
    await page.getByRole('button', { name: '删除客户' }).click();
    await page.getByRole('button', { name: '确认删除' }).click();

    await expect(card).toHaveCount(0, { timeout: 10000 });
  });
});
