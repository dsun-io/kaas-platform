"use client";

/**
 * 多产品报价工作台 —— 「一个询盘 → 多个产品 → 一张报价单 → 整套单证」。
 *
 * 与旧的单产品视图的关键区别：
 *   旧：一次只算一个产品的一组规格，算完只是屏幕上的数字（**不落库**）。
 *   新：整单承载 N 个产品行；每行独立规格/数量/利润覆盖；汇总展示；
 *       一行动作即可**存成一张报价单**，并由它生成整套单证（PI / 报价单 / 合同…）。
 *
 * 三条不变的口径（改动前请先读）：
 *  1. **共享参数放顶部、行内参数放行内**。币种/汇率/日期/税率/整批费用整单只有一份，
 *     放进行里会诱导用户"每行各填一次"，从而真填出不一致的值。
 *  2. **行小计 = 卷数 × 单卷外币价**（精确相乘），汇总 = Σ 行小计；
 *     单证 TOTAL 行也是逐行求和 —— 三处同源，才不会出现"报价工位 12,345.67、
 *     单证 12,345.66"这种查不出来的差分（见 lib/line-to-item.ts）。
 *  3. **试算不落库、草稿不落账**：算价只在内存里；台账只在"签发报价单"时写一条
 *     （后端 draft→sent 时入账）。
 *
 * 组件拆分（2026-10-23，行为不变；本文件只留布局编排）：
 *  · `use-quote-workbench`        —— 控制器：组合状态层与动作层
 *    · `use-workbench-state`       —— 表单状态 / 参考数据查询 / 派生金额
 *    · `use-workbench-actions`     —— 保存 / 签发回调 / 生成单证
 *  · `workbench-toolbar`          —— 顶部工具条（单条报价 + 批量导入入口）
 *  · `workbench-params-section`   —— 摘要行 + 整单参数卡（含询盘创建入口）
 *  · `workbench-product-section`  —— 产品行拖拽排序 + 添加产品
 *  · `workbench-product-add-dialog` —— 添加产品弹窗
 *  · `workbench-summary-panel`    —— 右侧整单汇总（≥xl）
 *  · `workbench-sticky-actions`   —— <xl 吸底动作条
 */
import { useQuoteWorkbench } from "./use-quote-workbench";
import { WorkbenchParamsSection } from "./workbench-params-section";
import { WorkbenchProductSection } from "./workbench-product-section";
import { WorkbenchStickyActions } from "./workbench-sticky-actions";
import { WorkbenchSummaryPanel } from "./workbench-summary-panel";
import { WorkbenchToolbar } from "./workbench-toolbar";

export function QuoteWorkbenchView() {
  const wb = useQuoteWorkbench();

  return (
    <>
      <WorkbenchToolbar />

      <div className="grid gap-5 pb-24 xl:grid-cols-[minmax(0,1fr)_380px] xl:pb-0">
        <div className="min-w-0 space-y-5">
          <WorkbenchParamsSection wb={wb} />
          <WorkbenchProductSection wb={wb} />
        </div>
        <WorkbenchSummaryPanel wb={wb} />
      </div>

      {/* <xl：底部吸底动作条，避免保存/签发按钮被长表单推到很远 */}
      <WorkbenchStickyActions wb={wb} />
    </>
  );
}
