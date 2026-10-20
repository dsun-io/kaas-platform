import { test, expect } from './fixtures';

test.describe('Events', () => {
  test('events list loads with at least 5 rows', async ({ page }) => {
    await page.goto('/events');

    const rows = page.locator('table tbody tr');
    // **不要用 `waitForLoadState('networkidle')` 当"等数据"的手段。**
    // 实测（2026-10-11，同一条用例重复 5 次）：它让本用例 60% 通过，
    // 失败全是 `page.waitForLoadState: Test timeout of 30000ms exceeded`
    // —— 因为本项目的 `/api/v1/*` 请求可能长期挂起，`networkidle` 永不满足。
    // 等**真实元素**既是更准的断言，也不依赖"网络静下来"。
    await expect(rows.first()).toBeVisible({ timeout: 15000 });
    const count = await rows.count();
    expect(count).toBeGreaterThanOrEqual(5);
  });

  test('event_type dropdown filters the list', async ({ page }) => {
    await page.goto('/events');

    // **2026-10-12：把 `networkidle` 换成等具体元素**（下拉框本身）。
    // 源码：`events/components/event-filters.tsx:45-62` 的 `<SelectTrigger>`（role=combobox）。
    // 用它当"页面已渲染"的条件，也顺带避免下一句 `filter.isVisible()`（**不重试**）
    // 在页面还没渲染时把整段交互静默跳过。
    await expect(page.getByRole('combobox').first()).toBeVisible({
      timeout: 15000,
    });

    // **2026-10-11 修正：确定性陈旧（字符串层，有源码依据）**
    // 事件类型只有两种 —— `events/components/event-filters.tsx:15-18`
    //   `const EVENT_TYPES = ["audit.access", "capability.update"]`
    // 旧正则 `/chat/i` **永远匹配不到任何一个选项** ⇒ 这段交互
    // （点击下拉 → 选择类型）**从未真正执行过**，一直被
    // `if (await option.isVisible())` 静默吞掉。
    //
    // ⚠️ 诚实标注：**这条不计为"已验证的修复"**。本任务的取数环境
    // （`E2E_FALLBACK=0`）下 `/events` 被 RouteGuard 拒绝渲染，连 combobox
    // 都不存在，所以改完无法在此环境验证；其失败原因见下方整表断言（数据层）。
    const filter = page.getByRole('combobox').first();
    if (await filter.isVisible()) {
      await filter.click();
      const option = page.getByRole('option', { name: /audit\.access/i });
      if (await option.isVisible()) {
        await option.click();
        // **2026-10-12：把 `networkidle` 换成等具体元素**（筛选后列表的第一行）。
        // 源码：`events/components/event-table.tsx:120-141`（`events.length > 0` 才渲染行）；
        // mock 按 `event_type` 过滤后仍有 6 行（`mocks/handlers.ts:174-186`）。
        await expect(page.locator('table tbody tr').first()).toBeVisible({
          timeout: 15000,
        });
      }
    }

    // List should still be visible
    await expect(page.locator('table')).toBeVisible();
  });

  test('click a row opens detail sheet with payload', async ({ page }) => {
    await page.goto('/events');

    // **2026-10-12 修正：这条原来是"空转通过"**
    // 旧写法两个问题：
    //   ① 用 `networkidle` 当"等数据"（会因请求挂起而超时，也会因"一个请求都没发"而立即满足）；
    //   ② `getByRole('button').filter({has: svg}).first()` 命中的是**过滤栏的「搜索」按钮**
    //      （`events/components/event-filters.tsx:87-90`，它比表格更早出现在 DOM 里），
    //      点它**不会**打开详情 ⇒ 结尾那句 `expect(table)).toBeVisible()` 恒真
    //      ⇒ "通过"但**什么都没验证**（修前实测 5/5 通过，全是空转）。
    //
    // 真实断言（源码依据）：
    //   · `event-table.tsx:85-89` —— 每行**唯一**的按钮是 `Eye`（`onClick={() => onSelect(event)}`）
    //     ⇒ 取首个 `table tbody tr` **行内**的按钮就是它；
    //   · `event-detail.tsx:34-40, 52-75` —— 点开后打开 Sheet
    //     （`components/ui/sheet.tsx:4` 用 `@base-ui/react/dialog` 的 `Popup` ⇒ `role="dialog"`），
    //     内含静态标签「租户 / 操作人 / 会话 / Trace / 时间」。
    const table = page.locator('table');
    await expect(table).toBeVisible({ timeout: 15000 });

    const firstRow = page.locator('table tbody tr').first();
    await expect(firstRow).toBeVisible({ timeout: 15000 });

    // 行内唯一的按钮 = Eye（打开详情）
    await firstRow.getByRole('button').first().click();

    const sheet = page.getByRole('dialog');
    await expect(sheet).toBeVisible({ timeout: 15000 });
    // 详情里的静态标签（与具体 mock 数据无关）
    await expect(sheet.getByText('操作人')).toBeVisible({ timeout: 15000 });
  });

  test('sampled badge is visible on some rows', async ({ page }) => {
    await page.goto('/events');

    // **2026-10-12 修正：测试侧（"等网络静默" ≠ "等内容"）**
    // 旧写法：`networkidle` 之后**一次性** `count()`；门未放行时"没有请求"
    // ⇒ `networkidle` 立即满足 ⇒ `count()` 得 0 ⇒ 假失败。
    // 本用例修前实测（FALLBACK=0、repeat-each=5、健康守卫 OK）：**0/5**，
    // 报错 `toBeGreaterThanOrEqual Expected: >= 1, Received: 0`。
    //
    // 真实断言（源码依据）：
    //   · `events/components/event-table.tsx:65-71` —— `event.sampled` 为真时渲染
    //     `<Badge variant="secondary">sampled</Badge>`
    //   · `mocks/handlers.ts:25-31` —— 12 条事件里 `sampled: i % 5 === 0` ⇒ 3 条带徽章
    await expect(page.getByText('sampled').first()).toBeVisible({ timeout: 15000 });
  });

  // C33（2026-10-21 修复）：旧版这条是 `test.skip` —— 它的触发条件根本不存在：
  // 页面 `events/page.tsx` 不读 `?error=`，`useEvents()` 只把 filters 拼进 query，
  // 所以请求 URL 从来不带 `error=500`（旧的 body-only 断言还是"假绿"）。
  //
  // 现在用 **test-only override** 强制 `/api/v1/events` 返回 500：
  //   `POST /api/v1/__test/override-events-error`（只存在于 MSW，先例
  //   `__test/override-quote-status`；真实后端没有该端点、生产模式不走 MSW）。
  // ⚠️ override 是模块级状态、`page.reload()` 会清 ⇒ 必须在**页面内** fetch 设置，
  // 再靠**改筛选**触发一次新的 `/events` 请求（不能 goto/reload）。
  // 可观测信号 = 全局 error-handler：500 且无业务码 ⇒ toast「后端忙碌，请稍后重试」
  // （`lib/api/error-handler.ts` 的 `status >= 500` 分支；axios 对 GET 5xx 会先重试
  // 3 次≈5s，之后才弹，故断言超时给 20s）。
  test('events 500 显示后端错误提示（test-only override）', async ({ page }) => {
    await page.goto('/events');
    await expect(page.locator('table tbody tr').first()).toBeVisible({
      timeout: 15000,
    });

    const setOverride = async (status: number) =>
      page.evaluate(async (nextStatus) => {
        const res = await fetch('/api/v1/__test/override-events-error', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: nextStatus }),
        });
        return res.ok;
      }, status);

    try {
      expect(await setOverride(500)).toBe(true);
      // 改 event_type ⇒ queryKey 变化 ⇒ 触发一次新的 /events 请求（同 key 不会重发）
      await page.getByRole('combobox').first().click();
      await page
        .getByRole('option', { name: /capability\.update/i })
        .click();
      await expect(page.getByText('后端忙碌，请稍后重试')).toBeVisible({
        timeout: 20000,
      });
    } finally {
      // 清理 override，避免污染后续用例（即使断言失败也执行）
      await setOverride(0).catch(() => undefined);
    }
  });
});
