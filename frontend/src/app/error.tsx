"use client";

import { ErrorState, PageHeader } from "@/components/shared";

/**
 * 根级错误边界（U-P0B5）：登录/公开页等不在 (app) 布局下的页面抛错时兜底。
 * 这里保留页头与 ErrorState 语义；AppLayout 不存在，所以要自带 page-container 内边距。
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const detail = error?.message?.trim();
  return (
    <div className="page-container">
      <PageHeader
        title="页面加载异常"
        description="页面没有加载成功。重试会重新渲染当前页；若持续失败，请稍后再试或返回首页。"
      />
      <ErrorState
        title="页面加载失败"
        message={detail || "后端忙碌或网络异常，请稍后重试。"}
        onRetry={reset}
      />
    </div>
  );
}
