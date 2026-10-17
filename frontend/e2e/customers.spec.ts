import { test, expect } from './fixtures';

test.describe('Customers', () => {
  test('customer list loads with at least 1 row', async ({ page }) => {
    await page.goto('/customers');

    // **2026-10-12：去掉 `networkidle`** —— 下面 `expect(cards.first()).toBeVisible(...)`
    // 就是在等具体元素（`customers/page.tsx:822-842` 的客户卡片），不需要额外等待。

    // **2026-10-11 修正：确定性陈旧（有源码依据）**
    // 现役 `/customers` 是**卡片列表，没有 `<table>`**：
    //   `customers/page.tsx:822-842` —— `<div className="space-y-2">` 内逐行渲染
    //   `<div className="rounded-lg border bg-card p-4 cursor-pointer …">`。
    // 旧断言 `table tbody tr` 在结构上**不可能**命中。
    //
    // ⚠️ 换成下面的卡片选择器后**这条用例仍会红**，原因**不在断言、在数据层**：
    //   `mocks/handlers.ts:234-236` 的 `/api/v1/customers` 返回**裸数组**
    //   `[{customer_id, customer_name, category_count, updated_at, locale}]`
    //   （`mocks/data/factory.ts:226-237`，旧的"客户=租户"模型），
    //   而页面契约是 `{items: [{id, company_name, stage, …}]}`
    //   （`customers/page.tsx:100-107`）；后端
    //   `backend/orchestrator/app/api/customers.py:215` 也是 `{"items": …, "total": …}`，
    //   且 `kaas_common/workstation/customer_serializers.py:18` 把库列 `name`
    //   映射为 `company_name` ⇒ **页面与后端一致，是 mock/schema 陈旧**。
    //   `listData.items` 恒为 `undefined` ⇒ 永远渲染 0 行卡片。
    //   修 mock（`frontend/src/mocks/**`，不在本任务写入范围）之前不可能变绿。
    //   实测（E2E_FALLBACK=0、`--repeat-each=3`、preflight/post 健康守卫均 OK）：3/3 红。
    const cards = page.getByTestId('customer-card');
    await expect(cards.first()).toBeVisible({ timeout: 15000 });
    const count = await cards.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });

  // **2026-10-11 判定：确定性陈旧 —— `/customers/[id]` 路由不存在 ⇒ 整段空转通过**
  // 现役 UI **没有** `/customers/[id]` 页面：`app/(app)/customers/` 下只有
  // `page.tsx` 与 `components/`（glob 实测无 `[id]/page.tsx`），客户详情是**同页面板**
  // ——`customers/page.tsx:846-851` 渲染 `<CustomerDetailPanel>`。
  // 所以 `a[href*="/customers/"]` 恒不存在，旧用例
  // `if (await customerLink.isVisible())` 恒为假 ⇒ **"通过"但什么都没验证**
  // （实测 3/3 passed，全部空转）。
  // 该覆盖应是：**点击客户卡片 → 出现详情面板（面板标题 = 客户 company_name，
  // `customers/page.tsx:533-541`），并展示「信息 / 联系人 (n) / 询盘 (n) / 历史」
  // 四个 tab（`customers/page.tsx:526-531`）**。定位后重写。
  test.skip('click customer navigates to detail page with capabilities', async () => {
    // 待重写：见上方说明（同页详情面板，不是路由跳转）。
  });

  // **2026-10-11 判定：确定性陈旧 —— 控件不在客户页上 ⇒ 运行时静默 skip**
  // 现役 `customers/page.tsx` 里**没有**「编辑」「保存」按钮（无能力编辑 UI），
  // 且 `/customers/[id]` 路由不存在（同上）⇒ 旧用例每次走到
  // `if (!(await customerLink.isVisible())) { test.skip(); return; }` 就**静默跳过**
  // （实测 3 skipped / 0 passed，从未真正执行过）。
  // 该覆盖应是：在能力配置入口改某条 capability 的 `spec_constraints` → 保存 →
  // 断言出现同步状态（`PATCH /customer/:id/capabilities` 返回 `sync_job_id`，
  // 见 `mocks/handlers.ts:404-408`）。定位后重写。
  test.skip('edit capability saves and shows sync status', async () => {
    // 待重写：见上方说明（能力编辑不在客户页）。
  });
});
