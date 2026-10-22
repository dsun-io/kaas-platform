"use client";

/**
 * 单证台账的「URL 筛选 + 分页」状态层。
 *
 * 为什么单独抽成 hook（而不是塞在 page.tsx 里）：
 *  - 台账页组件很重（开单表单/预览/PDF 导出都在同一页），整页测试成本高；
 *  - **筛选入 URL + 切筛选回第 1 页** 是纯状态逻辑，独立 hook 可以被精确定点测试
 *    （分页参数、URL 同步、清空筛选），业务组件测试只保留渲染职责。
 *
 * URL 契约（复用后端参数名，便于排障时直接对照请求）：
 *   `?doc_type=pi&status=draft`
 *  - 用 `useUrlState` 而不是 useSearchParams：静态导出下 useSearchParams 必须
 *    Suspense 包裹（本项目已多次踩过），且它会让整页 bail out；
 *  - 页码**不入 URL**：和 events/orders 列表同口径（刷新回第 1 页），
 *    但切换筛选时通过「派生 page」立刻归 1，不会停在越界页看空列表。
 */
import { useCallback, useState } from "react";

import { useUrlState } from "@/lib/hooks/use-url-state";

import {
  TRADE_DOCS_PAGE_SIZE,
  useTradeDocs,
  type TradeDocFilters,
  type TradeDocRow,
} from "./use-trade-docs";

export interface TradeDocsLedger {
  /** 类型筛选（URL `doc_type`，空串 = 全部） */
  docType: string;
  /** 状态筛选（URL `status`，空串 = 全部） */
  status: string;
  setDocType: (next: string | null) => void;
  setStatus: (next: string | null) => void;
  page: number;
  setPage: (next: number) => void;
  /** 传给 useTradeDocs 的查询参数（分页 + 筛选） */
  filters: TradeDocFilters;
  list: ReturnType<typeof useTradeDocs>;
  rows: TradeDocRow[];
  total: number;
}

export function useTradeDocsLedger(): TradeDocsLedger {
  const [docType, setDocType] = useUrlState("doc_type", "");
  const [status, setStatus] = useUrlState("status", "");

  // 筛选签名：变了就把页码"派生"回 1（不写 effect，避免多一轮渲染与
  // react-hooks/set-state-in-effect 告警；用户点下一页时再用当前签名落 page）。
  const filterKey = `${docType}\u0000${status}`;
  const [pageState, setPageState] = useState<{ key: string; page: number }>({
    key: filterKey,
    page: 1,
  });
  const page = pageState.key === filterKey ? pageState.page : 1;

  const setPage = useCallback(
    (next: number) => {
      setPageState({ key: filterKey, page: Math.max(1, next) });
    },
    [filterKey],
  );

  const filters: TradeDocFilters = {
    doc_type: docType || undefined,
    status: status || undefined,
    page,
    page_size: TRADE_DOCS_PAGE_SIZE,
  };

  const list = useTradeDocs(filters);

  return {
    docType,
    status,
    setDocType,
    setStatus,
    page,
    setPage,
    filters,
    list,
    rows: list.data?.items ?? [],
    total: list.data?.total ?? 0,
  };
}
