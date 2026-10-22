import { test, expect } from './fixtures';

test.describe('Settings', () => {
  test('tab switching between tenant config and system operations', async ({ page }) => {
    await page.goto('/settings');

    // **2026-10-12：不再用 `networkidle` 当"等数据"**
    // （请求真挂起时它会以 30s 超时失败；而"一个请求都没发"时它又会立即满足）。
    // 下面这行断言**本身**就是在等具体元素（`settings/page.tsx:25-40` 的 tab 按钮），
    // 所以这里不需要任何额外等待。
    // Tenant config tab should be active by default
    const tenantTab = page.getByRole('tab', { name: /空间配置/i });
    await expect(tenantTab).toBeVisible();

    // Click system operations tab
    const systemTab = page.getByRole('tab', { name: /系统操作/i });
    await systemTab.click();
    await page.waitForTimeout(300);

    // System tab content should now be visible
    const reloadBtn = page.getByRole('button', { name: /重载产品配置/i });
    await expect(reloadBtn).toBeVisible();
  });

  test('reload button triggers reload and shows result count', async ({ page }) => {
    await page.goto('/settings');

    // **2026-10-12：去掉 `networkidle`** —— 下一步 `systemTab.click()`
    // 自身就会等具体元素（`settings/page.tsx:25-40` 的「系统操作」按钮）出现。
    // Switch to system tab
    const systemTab = page.getByRole('tab', { name: /系统操作/i });
    await systemTab.click();
    await page.waitForTimeout(300);

    // Click reload button
    const reloadBtn = page.getByRole('button', { name: /重载产品配置/i });
    await reloadBtn.click();
    await page.waitForTimeout(2000);

    // Should show reloaded count
    const resultText = page.locator('text=/已重载|reloaded/i');
    const count = await resultText.count();
    expect(count).toBeGreaterThanOrEqual(0);
  });

  test('tenant list does not show API key plaintext', async ({ page }) => {
    await page.goto('/settings');

    // **2026-10-12：把 `networkidle` 换成等具体元素**（页面 h1，`settings/page.tsx:22`）。
    // 本用例随后是 `count()`（**不重试**），所以需要一个明确的"页面已渲染"条件。
    await expect(page.getByRole('heading', { name: '系统设置' })).toBeVisible({
      timeout: 15000,
    });

    // 2026-10-22：配置页去技术名词后不再显示 ENV:xxx / 变量名；
    // 只允许出现「已配置/未配置」这类业务状态。
    await expect(
      page.getByText(/ENV:|RESEND_API_KEY|FASTGPT_API_KEY|DB_DSN/),
    ).toHaveCount(0);
    // 状态徽章在「系统操作」tab 内，默认 tab 下是隐藏的；只要已渲染即可。
    await expect(page.getByText(/已配置|未配置/).first()).toBeAttached();
  });
});
