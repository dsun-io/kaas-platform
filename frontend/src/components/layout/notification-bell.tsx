"use client";

/**
 * 顶部通知铃铛 + 通知抽屉（设计 §6.2 / §9.5，D-10/D-12）。
 *
 * 行为契约：
 *  - 未读角标 = `GET /notifications/unread-count` 的 `{unread}`；60s 轮询，
 *    **`refetchIntervalInBackground: true` 显式打开**（QueryProvider 默认 false：
 *    后台标签页不轮询，用户切走就再也看不到"新待批"）；
 *  - 抽屉：列表 + 单条已读 + 全部已读；点条目先标已读再深链
 *    （审批 → /approvals，订单 → 后端给的 /orders/... 链接）；
 *  - 窄屏不溢出：按钮固定 size-7 + shrink-0，角标绝对定位在按钮内，
 *    抽屉在手机上占满宽度（sm 起 max-w-sm）。
 *
 * 数据层在 `lib/approvals/use-notifications.ts`（轮询参数集中一处，避免散落）。
 */
import { useState } from "react";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { AlertCircle, Bell, CheckCheck, Inbox } from "lucide-react";
import { toast } from "sonner";

import { EmptyState } from "@/components/shared/empty-state";
import { StatusBadge } from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDateTime } from "@/lib/approvals/format";
import {
  formatUnreadBadge,
  notificationMeta,
  resolveNotificationLink,
} from "@/lib/approvals/notification";
import {
  useMarkAllNotificationsRead,
  useMarkNotificationRead,
  useNotifications,
  useUnreadNotificationCount,
} from "@/lib/approvals/use-notifications";
import type { AppNotification } from "@/lib/approvals/types";

export function NotificationBell() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const unread = useUnreadNotificationCount();
  // 抽屉打开后才拉列表；打开期间同样 60s 轮询
  const list = useNotifications(open);
  const markRead = useMarkNotificationRead();
  const markAll = useMarkAllNotificationsRead();

  const unreadCount = unread.data?.unread ?? 0;
  const badge = formatUnreadBadge(unreadCount);
  const items = list.data?.items ?? [];
  const hasUnread = items.some((item) => !item.read_at) || unreadCount > 0;

  const openNotification = async (notification: AppNotification) => {
    const href = resolveNotificationLink(notification);
    if (!notification.read_at) {
      try {
        await markRead.mutateAsync(notification.id);
      } catch {
        // 已读失败不挡跳转：通知内容仍可查看，下轮轮询会纠正角标
      }
    }
    setOpen(false);
    // 后端 link 是运行时字符串（typedRoutes 无法静态校验）⇒ 显式 as Route；
    // resolveNotificationLink 已保证只可能是站内相对路径
    router.push(href as Route);
  };

  const markAllRead = async () => {
    try {
      const result = await markAll.mutateAsync();
      if (result.marked > 0) {
        toast.success(`已把 ${result.marked} 条通知标为已读`);
      } else {
        toast.info("没有未读通知");
      }
    } catch {
      toast.error("全部已读失败，请稍后重试");
    }
  };

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            className="relative shrink-0"
            aria-label={badge ? `通知（${badge} 条未读）` : "通知"}
            title="通知"
          >
            <Bell className="size-4" />
            {badge ? (
              <span
                aria-hidden
                className="absolute -right-1 -top-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold leading-none text-destructive-foreground"
              >
                {badge}
              </span>
            ) : null}
          </Button>
        }
      />
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 p-0 sm:max-w-sm"
      >
        <SheetHeader className="gap-2 border-b px-4 py-3">
          <div className="flex items-center justify-between gap-2">
            <SheetTitle>通知</SheetTitle>
            <Button
              variant="outline"
              size="xs"
              disabled={!hasUnread || markAll.isPending}
              onClick={() => void markAllRead()}
            >
              <CheckCheck className="mr-1 size-3" />
              全部已读
            </Button>
          </div>
          <SheetDescription>
            审批相关通知，点击条目跳转；每 60 秒自动刷新，窗口回到前台也会刷新。
          </SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {list.isLoading ? (
            <div
              className="space-y-2 p-4"
              aria-busy="true"
              aria-label="通知加载中"
            >
              {Array.from({ length: 4 }).map((_, index) => (
                <Skeleton key={index} className="h-16 w-full rounded-lg" />
              ))}
            </div>
          ) : list.isError ? (
            <div className="space-y-3 p-4 text-sm">
              <p className="flex items-center gap-2 text-destructive">
                <AlertCircle className="size-4 shrink-0" />
                通知读取失败，请稍后重试。
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void list.refetch()}
              >
                重新加载
              </Button>
            </div>
          ) : items.length === 0 ? (
            <div className="p-4">
              <EmptyState
                icon={Inbox}
                title="没有通知"
                description="审批申请、批准与拒绝的结果会出现在这里。"
              />
            </div>
          ) : (
            <ul className="divide-y">
              {items.map((notification) => {
                const meta = notificationMeta(notification.type);
                const isUnread = !notification.read_at;
                return (
                  <li key={notification.id}>
                    <button
                      type="button"
                      onClick={() => void openNotification(notification)}
                      className={
                        "flex w-full flex-col gap-1.5 px-4 py-3 text-left transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 " +
                        (isUnread ? "bg-primary/[0.04]" : "")
                      }
                    >
                      <span className="flex items-start gap-2">
                        <span className="line-clamp-2 flex-1 text-sm font-medium">
                          {notification.title}
                        </span>
                        {isUnread ? (
                          <span
                            className="mt-1 inline-flex shrink-0 items-center gap-1 text-[10px] font-medium text-primary"
                            aria-label="未读"
                          >
                            <span
                              aria-hidden
                              className="size-1.5 rounded-full bg-primary"
                            />
                            未读
                          </span>
                        ) : null}
                      </span>
                      {notification.body ? (
                        <span className="line-clamp-2 text-xs text-muted-foreground">
                          {notification.body}
                        </span>
                      ) : null}
                      <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <StatusBadge tone={meta.tone} dot={false}>
                          {meta.label}
                        </StatusBadge>
                        <span title={notification.created_at ?? undefined}>
                          {formatDateTime(notification.created_at)}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
