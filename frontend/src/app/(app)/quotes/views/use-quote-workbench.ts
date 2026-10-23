"use client";

/**
 * 报价工作台 · 控制器（状态 + 动作的组合出口）。
 *
 * 拆分后的调用关系：
 *   quote-workbench-view（只做布局编排）
 *     → use-quote-workbench（本文件：组合下面两层）
 *        → use-workbench-state（表单状态/查询/派生金额）
 *        → use-workbench-actions（保存/签发回调/生成单证）
 *     → workbench-toolbar / params-section / product-section / summary-panel / sticky-actions
 *
 * 之所以把两层分开：状态层不依赖 toast/apiClient 写动作，动作层不持有表单状态，
 * 单测/阅读时能只看需要的那一半。
 */
import {
  useWorkbenchActions,
  type WorkbenchActions,
} from "./use-workbench-actions";
import { useWorkbenchState, type WorkbenchState } from "./use-workbench-state";

export interface QuoteWorkbenchController
  extends WorkbenchState, WorkbenchActions {}

export function useQuoteWorkbench(): QuoteWorkbenchController {
  const state = useWorkbenchState();
  const actions = useWorkbenchActions(state);
  return { ...state, ...actions };
}
