"use client";

import { ErrorState, PageHeader } from "@/components/shared";

/**
 * 段级错误边界（U-P0B5）：页面抛错时**保留页头**（错误分支也必须有唯一 h1），
 * 正文统一用共享 ErrorState（role="alert" + 重试），不再手写 h2 + 裸 button。
 *
 * 口径：`reset` 是 Next 提供的重试（重新渲染该段），比 window.location.reload()
 * 温和；只有重试仍失败才由用户自行刷新。
 */
export default function GrayReleaseError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const detail = error?.message?.trim();
  return (
    <div className="space-y-6">
      <PageHeader
        title="灰度发布"
        description="本页内容加载失败。重试会重新请求数据；若持续失败，请联系管理员。"
      />
      <ErrorState
        title="灰度发布加载失败"
        message={detail || "后端忙碌或网络异常，请稍后重试。"}
        onRetry={reset}
      />
    </div>
  );
}
