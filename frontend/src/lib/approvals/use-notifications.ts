"use client";

/**
 * 站内通知数据层（铃铛角标 + 通知抽屉）。
 *
 * 契约真源：内核 `ws_approvals.py:564-637`：
 *  - `GET /notifications?unread=1&page&page_size`（**参数名是 unread，不是 unread_only**）
 *  - `GET /notifications/unread-count` → `{unread}`（**不是 {count}**）
 *  - `POST /notifications/{id}/read` / `POST /notifications/read-all`
 *
 * 轮询（设计 §6.2「60s + 窗口 focus 刷新」）：
 * Provider 把 `refetchIntervalInBackground` 默认设为 **false**（后台标签页不轮询），
 * 通知角标必须**显式 true** —— 否则用户切到别的标签页就永远看不到"新待批"。
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import apiClient from "@/lib/api/client";

import type {
  AppNotification,
  MarkAllReadResponse,
  NotificationListPage,
  UnreadCountResponse,
} from "./types";

export const NOTIFICATION_POLL_INTERVAL = 60_000;
export const NOTIFICATION_PAGE_SIZE = 20;

export const notificationKeys = {
  all: ["notifications"] as const,
  unread: ["notifications", "unread"] as const,
  list: (unreadOnly: boolean) => ["notifications", "list", unreadOnly] as const,
};

/** 铃铛角标：未读数，60 秒轮询（后台也轮询——显式 true）。 */
export function useUnreadNotificationCount() {
  return useQuery({
    queryKey: notificationKeys.unread,
    queryFn: async (): Promise<UnreadCountResponse> => {
      const { data } = await apiClient.get<UnreadCountResponse>(
        "/notifications/unread-count",
        { silent: true },
      );
      const raw = Number(
        (data as unknown as Record<string, unknown> | null)?.["unread"],
      );
      return {
        unread: Number.isFinite(raw) ? Math.max(0, Math.trunc(raw)) : 0,
      };
    },
    refetchInterval: NOTIFICATION_POLL_INTERVAL,
    refetchIntervalInBackground: true,
  });
}

/** 抽屉打开时才请求通知列表；打开期间同样 60 秒轮询。 */
export function useNotifications(enabled: boolean) {
  return useQuery({
    queryKey: notificationKeys.list(false),
    enabled,
    queryFn: async () => {
      const { data } = await apiClient.get<NotificationListPage>(
        "/notifications",
        {
          params: { page: 1, page_size: NOTIFICATION_PAGE_SIZE },
          silent: true,
        },
      );
      return data;
    },
    refetchInterval: enabled ? NOTIFICATION_POLL_INTERVAL : false,
    refetchIntervalInBackground: true,
  });
}

export function useMarkNotificationRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (notificationId: number) => {
      const { data } = await apiClient.post<AppNotification>(
        `/notifications/${notificationId}/read`,
        {},
        { silent: true },
      );
      return data;
    },
    onSuccess: () => {
      // 角标与列表同源：都失效一次，避免"点了已读但角标还是旧数"
      void qc.invalidateQueries({ queryKey: notificationKeys.all });
    },
  });
}

export function useMarkAllNotificationsRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data } = await apiClient.post<MarkAllReadResponse>(
        "/notifications/read-all",
        {},
        { silent: true },
      );
      return data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: notificationKeys.all });
    },
  });
}
