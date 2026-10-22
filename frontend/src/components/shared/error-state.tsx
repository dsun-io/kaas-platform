"use client";

/**
 * 数据区三态之「错误」（P0-C）：role="alert" + 原因 + 重试。
 *
 * 为什么要单独一个组件：旧页面把请求失败渲染成空态（"暂无数据"）、0 或一行裸红字
 * ⇒ 用户以为"真的没有数据"，不会重试（UI 执行方案 P0-B B3）。
 * 这里把"失败"做成显式状态：**看得见、读得懂、点得动**。
 *
 * 口径：
 * - `message` 传后端原文（`normalizeApiError(error).message`），不要吞成"出错了"；
 * - 只有传了 `onRetry` 才渲染重试按钮（有些错误不可重试，例如 403）；
 * - 颜色只用 semantic token（`destructive`），不写死 red。
 */
import { AlertTriangle, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface ErrorStateProps {
  /** 标题，默认「加载失败」 */
  title?: string;
  /** 具体原因（后端 message/detail），不传则只显示标题 */
  message?: string;
  /** 重试回调；不传则不渲染按钮 */
  onRetry?: () => void;
  /** 重试按钮文案，默认「重试」 */
  retryLabel?: string;
  className?: string;
}

export function ErrorState({
  title = "加载失败",
  message,
  onRetry,
  retryLabel = "重试",
  className,
}: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-8 text-center",
        className,
      )}
    >
      <AlertTriangle className="h-5 w-5 text-destructive" aria-hidden="true" />
      <div className="space-y-1">
        <p className="text-sm font-semibold">{title}</p>
        {message ? (
          <p className="max-w-md text-sm text-muted-foreground">{message}</p>
        ) : null}
      </div>
      {onRetry ? (
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          <RotateCcw className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
          {retryLabel}
        </Button>
      ) : null}
    </div>
  );
}
