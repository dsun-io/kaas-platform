"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import { useState } from "react";

import { queryRetryDelay, shouldRetryQuery } from "@/lib/query/retry";

// devtools 仅本地开发渲染，且懒加载：
// 之前是静态导入 + 无条件渲染，生产包白白带上整个 devtools。
const ReactQueryDevtools = dynamic(
  () =>
    import("@tanstack/react-query-devtools").then((m) => m.ReactQueryDevtools),
  { ssr: false },
);

export function QueryProvider({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            // 2026-10-24（产品页 502 事故）：原来这里是裸 `retry: 1` —— 4xx 也会
            // 立刻重来一次（确定性失败重试纯属放大），5xx 则不退避地连打两轮。
            // 现在统一用 `lib/query/retry` 的口径：只有 4xx 不重试、5xx/网络错误
            // 最多 2 次且带退避（尊重门面的 `Retry-After` 与 `retryable:false`）。
            retry: shouldRetryQuery,
            retryDelay: queryRetryDelay,
            // 回到标签页时刷新：多人协作场景下窗口聚焦≈"我回来了"，此时数据大概率
            // 已被别人改过 —— 用 window focus 换及时性，staleTime 兜住不过度刷新。
            refetchOnWindowFocus: true,
            refetchOnReconnect: true,
            // refetchInterval 只在页面可见时生效，避免后台标签页空转打冷启动慢的接口。
            refetchIntervalInBackground: false,
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      {children}
      {process.env.NODE_ENV === "development" && (
        <ReactQueryDevtools initialIsOpen={false} />
      )}
    </QueryClientProvider>
  );
}
