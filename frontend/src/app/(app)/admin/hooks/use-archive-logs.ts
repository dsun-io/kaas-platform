"use client";

/**
 * 事件归档记录（C30）—— `GET /api/v1/admin/archive-logs`
 *
 * 数据真源：`events_archive_log` 表。`backend/worker/src/ws_cron.py` 每月把**上月**事件
 * 写成 R2 对象（`events-archive/YYYY/MM/DD/v{schema_version}.jsonl.gz`）后插入一行
 * `(tenant_id='*', month='YYYY-MM', minio_path='{bucket}/…', status='archived')`。
 *
 * 契约（`backend/worker/src/main.py:get_archive_logs`）：
 *   `page` / `page_size`（钳位 page>=1、page_size∈[1,100]）/ `month`（`YYYY-MM` 可选）
 *   → `{items:[{id, month, path, status, archived_at}], total, page, page_size}`
 * 注意：是 `path` 而不是表里的 `minio_path`（后端在端点里改名）。
 */
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";

export const ARCHIVE_LOGS_PAGE_SIZE = 20;

export interface ArchiveLogEntry {
  id: string;
  /** 归档月份 `YYYY-MM`（归档的是**上月**事件） */
  month: string;
  /** R2 对象键（含 bucket 前缀），如 `kaas-events-archive/events-archive/2026/09/01/v1.jsonl.gz` */
  path: string;
  /** 写入时恒为 `archived`（失败不会写行） */
  status: string;
  archived_at: string | null;
}

export interface ArchiveLogsPage {
  items: ArchiveLogEntry[];
  total: number;
  page: number;
  page_size: number;
}

export interface ArchiveLogsParams {
  page: number;
  pageSize?: number;
  /** `YYYY-MM` 可选过滤 */
  month?: string;
}

export function useArchiveLogs({
  page,
  pageSize = ARCHIVE_LOGS_PAGE_SIZE,
  month,
}: ArchiveLogsParams) {
  return useQuery({
    queryKey: ["admin", "archiveLogs", { page, pageSize, month: month ?? "" }],
    queryFn: async () => {
      const { data } = await apiClient.get<ArchiveLogsPage>(
        "/admin/archive-logs",
        {
          params: {
            page,
            page_size: pageSize,
            ...(month ? { month } : {}),
          },
        },
      );
      return data;
    },
    // 翻页时保留上一页内容，避免卡片闪成骨架屏
    placeholderData: (previous) => previous,
  });
}
