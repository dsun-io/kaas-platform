"use client";

/**
 * 调研产品「导出 CSV」动作（从 page.tsx 抽出，行为不变）。
 *
 * R48 口径：导出的是**当前筛选条件下的全部结果**，不是列表当前页 ——
 * 逐页请求（`EXPORT_PAGE_SIZE`=200，后端上限）直到拉满 total，再一次性写 CSV；
 * 失败如实提示（不能点了没反应）；导出量大于当前列表页时额外提示"导出的是全部"。
 */
import { useState } from "react";
import { toast } from "sonner";

import { normalizeApiError } from "@/lib/api/api-error";

import { EXPORT_PAGE_SIZE, RESEARCH_PAGE_SIZE } from "./constants";
import { downloadResearchCsv } from "./export-csv";
import type { ResearchProduct, ResearchProductPage } from "./types";

export function useExportResearch({
  fetchPage,
  listCount,
}: {
  /** 按筛选条件取某一页（列表/导出共用同一份参数构造，口径不漂移） */
  fetchPage: (
    targetPage: number,
    pageSize: number,
  ) => Promise<ResearchProductPage>;
  /** 当前列表已有的条数（用于判断是否需要提示"导出的是全部"） */
  listCount: number;
}) {
  const [exporting, setExporting] = useState(false);

  const exportAll = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const all: ResearchProduct[] = [];
      let targetPage = 1;
      let total = Number.POSITIVE_INFINITY;
      while (all.length < total) {
        const data = await fetchPage(targetPage, EXPORT_PAGE_SIZE);
        total = data.total;
        if (data.items.length === 0) break;
        all.push(...data.items);
        targetPage += 1;
      }
      downloadResearchCsv(all);
      if (all.length > listCount) {
        // 说清"导出的是全部"而不是让人以为只有页面上这些
        toast.success(
          `已导出当前筛选的全部 ${all.length} 条（列表每页 ${RESEARCH_PAGE_SIZE} 条）`,
        );
      }
    } catch (err) {
      toast.error(normalizeApiError(err).message || "导出失败");
    } finally {
      setExporting(false);
    }
  };

  return { exporting, exportAll };
}
