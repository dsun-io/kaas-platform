import { test, expect } from './fixtures';

/**
 * 仪表盘（2026-10-21 改为占位，C31）。
 *
 * 契约 `shared/contracts/workstations.ts` 对 dashboard 的 status 是 `placeholder`
 * ——「现有实现只展示系统运行指标（Token/延迟/采样率），对业务无用 → 改『更新中』」。
 * 旧的 3 条用例（6 张 StatCard / RangeSelector 刷新 / 采样 hint）测的是**已被移除**的
 * 旧实现，故一并替换；不要为了"少改测试"而把旧断言留着——那会要求把无数据的 0
 * 重新渲染出来，与契约相反。
 */
test.describe('Dashboard', () => {
  test('页面呈现「改版中」占位而不是无意义的 0 指标', async ({ page }) => {
    await page.goto('/dashboard');

    await expect(page.getByText('仪表盘改版中')).toBeVisible({ timeout: 15000 });
    await expect(page.getByText(/原有指标（Token 消耗、P95 延迟、采样覆盖率）/)).toBeVisible();
    // 旧实现的指标卡不应再出现（否则又会把"没有数据"渲染成 0）
    await expect(page.getByTestId('stat-card')).toHaveCount(0);
  });

  test('占位页仍可正常路由与访问（外壳不崩）', async ({ page }) => {
    await page.goto('/dashboard');

    await expect(page.getByRole('heading', { name: '仪表盘' })).toBeVisible({
      timeout: 15000,
    });
    // 面包屑也会渲染同名 "仪表盘" 的 span[role=link]（aria-disabled）⇒ 严格模式必须限定侧栏
    await expect(
      page.getByRole('complementary').getByRole('link', { name: '仪表盘' }),
    ).toBeVisible();
  });
});
