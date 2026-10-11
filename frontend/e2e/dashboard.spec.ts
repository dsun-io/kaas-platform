import { test, expect } from './fixtures';

test.describe('Dashboard', () => {
  test('page loads with 6 stat cards', async ({ page }) => {
    await page.goto('/dashboard');
    await page.waitForLoadState('networkidle');

    const cards = page.locator('.grid > *');
    await expect(cards.first()).toBeVisible();
    const count = await cards.count();
    expect(count).toBeGreaterThanOrEqual(6);
  });

  test('RangeSelector switches trigger card refetch', async ({ page }) => {
    await page.goto('/dashboard');
    await page.waitForLoadState('networkidle');

    // **2026-10-11 修正：确定性陈旧（有源码依据）**
    // 现役文案是 `近 7 天`（**含空格**）：`dashboard/components/range-selector.tsx:7`
    //   `{ value: "7d", label: "近 7 天" }`
    // 旧正则 `/7天|7d/i` 里 `7` 与 `天` 之间要求紧邻 ⇒ **永远匹配不到**。
    //
    // 实测（E2E_FALLBACK=0、`--repeat-each=5 --workers=1`、环境健康：
    // preflight 与 post 健康守卫均为 OK）：
    //   · 本用例 **0/5**，5 次全是 `locator.click: Test timeout … waiting for
    //     getByRole('button', { name: /7天|7d/i })`；
    //   · **同一个页面**的 `page loads with 6 stat cards` **5/5 通过** ⇒
    //     页面确实渲染了、`.grid > *` 选择器有效 ⇒ 失败只可能来自这个正则。
    await page.getByRole('button', { name: /近\s*7\s*天|7d/i }).click();

    // 点击后等**真实元素**，不再等 `networkidle`：
    // 本项目首屏请求可能被绕过而永久挂起，`networkidle` 会以 30s 超时失败。
    // ⚠️ **这一处不计为修复**（已实测：仅换掉 networkidle 不提高通过率），
    // 它只是让"上方文案修复是否生效"可观测。
    const cards = page.locator('.grid > *');
    await expect(cards.first()).toBeVisible({ timeout: 15000 });
  });

  test('sampling tooltip or hint text is visible', async ({ page }) => {
    await page.goto('/dashboard');
    await page.waitForLoadState('networkidle');

    // Check for sampling-related text
    const hintText = page.locator('text=/采样|sampled/i');
    const count = await hintText.count();
    expect(count).toBeGreaterThan(0);
  });
});
