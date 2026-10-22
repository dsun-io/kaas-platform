import { test, expect } from './fixtures';

/**
 * 仪表盘（M3 落地后的口径）。
 *
 * 2026-10-22 的占位页（「仪表盘改版中」）已被商机漏斗看板取代：
 *  - 漏斗四阶段 + 综合商机分（询盘×1 / 报价×2 / 订单×10）；
 *  - 分渠道转化（按综合分降序）；
 *  - 直接下单单独统计（不进漏斗）；
 *  - 订单应收概览：后端暂无聚合端点 ⇒ 明确「待补后端」空态，不造 0/假数字。
 *
 * 本文件不要再断言旧占位文案或旧 StatCard —— 那会要求把无意义指标重新渲染回来。
 */
test.describe('Dashboard', () => {
  test('落地商机漏斗/分渠道/直接下单，且不再有无意义指标', async ({ page }) => {
    await page.goto('/dashboard');

    await expect(page.getByRole('heading', { name: '仪表盘' })).toBeVisible({
      timeout: 15000,
    });
    // 四个区块（SectionCard 标题；exact 避开 PageHeader 描述里的同名词）
    await expect(page.getByText('商机漏斗', { exact: true })).toBeVisible();
    await expect(page.getByText('分渠道转化', { exact: true })).toBeVisible();
    await expect(page.getByText('直接下单', { exact: true })).toBeVisible();
    await expect(page.getByText('订单应收概览', { exact: true })).toBeVisible();
    // 应收缺口如实标注（不是 0 元假数字）
    await expect(page.getByText('待补后端聚合接口')).toBeVisible();

    // 旧实现/占位页不得回归
    await expect(page.getByText('仪表盘改版中')).toHaveCount(0);
    await expect(page.getByTestId('stat-card')).toHaveCount(0);
  });

  test('时间范围可切到近 90 天，请求真的带 range=90d', async ({ page }) => {
    const funnelRequests: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/api/v1/dashboard/funnel')) {
        funnelRequests.push(request.url());
      }
    });

    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: '仪表盘' })).toBeVisible({
      timeout: 15000,
    });
    await page.getByRole('radio', { name: '近 90 天' }).click();

    await expect
      .poll(() => funnelRequests.some((url) => url.includes('range=90d')), {
        timeout: 15000,
      })
      .toBe(true);
    await expect(page.getByRole('radio', { name: '近 90 天' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  test('外壳与侧边栏正常（面包屑 + 导航入口）', async ({ page }) => {
    await page.goto('/dashboard');

    await expect(page.getByRole('heading', { name: '仪表盘' })).toBeVisible({
      timeout: 15000,
    });
    await expect(
      page.getByRole('complementary').getByRole('link', { name: '仪表盘' }),
    ).toBeVisible();
  });
});
