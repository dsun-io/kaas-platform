import { test, expect } from './fixtures';

/**
 * 知识库（K1 修复后的口径）。
 *
 * 2026-10-22 审计 K1：页面原先渲染一组**硬编码假统计**（知识条目 48 / 产品品类 6 /
 * 最近更新 2 小时前 / 数据源 工位能力网）。它在没有任何接口支撑的情况下"看起来有数据"，
 * 比空白更误导 —— 2026-10-23 已下线，改为明确「尚未接入」。
 *
 * 本用例锁住两件事：
 *  1. 真实空态文案存在（不造假数字）；
 *  2. 假统计不回归（48 / 2 小时前 等不得出现）。
 */
test.describe('Knowledge Base', () => {
  test('page loads with explicit 未接入 empty state and no fake stats', async ({
    page,
  }) => {
    await page.goto('/kb');

    await expect(
      page.getByRole('heading', { name: '知识库管理', exact: true }),
    ).toBeVisible();

    // 明细区：构建中
    await expect(page.getByText('建设中').first()).toBeVisible();
    await expect(page.getByText('知识库统计尚未接入')).toBeVisible();
    await expect(page.getByText('知识库管理功能即将上线')).toBeVisible();

    // K1 回归守卫：假统计不得重新出现
    await expect(page.getByText('知识条目', { exact: true })).toHaveCount(0);
    await expect(page.getByText('48', { exact: true })).toHaveCount(0);
    await expect(page.getByText('2 小时前', { exact: true })).toHaveCount(0);
    await expect(page.getByText('工位能力网')).toHaveCount(0);
  });
});
