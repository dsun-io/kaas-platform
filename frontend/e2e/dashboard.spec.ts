import { test, expect } from './fixtures';

test.describe('Dashboard', () => {
  test('page loads with 6 stat cards', async ({ page }) => {
    await page.goto('/dashboard');

    // **2026-10-12：去掉 `networkidle`** —— 下一行断言就是在等具体元素
    // （`dashboard/page.tsx:32` 的 `.grid` 内 6 张 `<StatCard>`）。
    const cards = page.getByTestId('stat-card');
    await expect(cards.first()).toBeVisible();
    const count = await cards.count();
    expect(count).toBeGreaterThanOrEqual(6);
  });

  test('RangeSelector switches trigger card refetch', async ({ page }) => {
    await page.goto('/dashboard');

    // **2026-10-12：去掉 `networkidle`** —— 下面的 `click()` 自身会等具体元素
    // （`dashboard/components/range-selector.tsx:7` 的「近 7 天」按钮）。

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
    const cards = page.getByTestId('stat-card');
    await expect(cards.first()).toBeVisible({ timeout: 15000 });
  });

  test('sampling tooltip or hint text is visible', async ({ page }) => {
    await page.goto('/dashboard');

    // **2026-10-12 修正：测试侧（"等网络静默" ≠ "等内容"）**
    // 旧写法是 `await page.waitForLoadState('networkidle')` 之后**一次性** `count()`。
    // 而 MSW 门（`MswProvider`）尚未放行时页面**一个请求都没发** ⇒ `networkidle`
    // **立即满足** ⇒ `count()` 得 0 ⇒ 假失败。
    // 证据（task-12）：18 次用例里 4 次正是这个形态，`gate=0 / probe=0` 与失败 **1:1** 对应。
    // 本用例修前实测（FALLBACK=0、repeat-each=5、健康守卫 OK）：**0/5**，报错
    // `expect(received).toBeGreaterThan(expected) Expected: > 0, Received: 0`。
    //
    // 真实断言（源码依据）：
    //   · `dashboard/page.tsx:38-42` ——
    //     `hint={summary ? \`采样 ${summary.quotations_sampled}/${summary.quotations_total}\` : undefined}`
    //   · `components/shared/stat-card.tsx:52` —— `<span className="text-muted-foreground">{hint}</span>`
    //     （是**可见文本**，不是悬停才出现的 tooltip）
    //   ⇒ 数据到位后 DOM 里必然有 `采样 <n>/<m>`（mock：`采样 10/42` 等）。
    //
    // ⚠️ **不能**断言 `text=/采样/i`：第 6 张卡的**静态** label 就叫「采样覆盖率」
    // （`dashboard/page.tsx:83`），那样断言恒真、等于没测。
    await expect(page.getByText(/采样 \d+\/\d+/).first()).toBeVisible({
      timeout: 15000,
    });
  });
});
