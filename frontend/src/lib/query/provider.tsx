'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import dynamic from 'next/dynamic';
import { useState } from 'react';

// devtools 仅本地开发渲染，且懒加载：
// 之前是静态导入 + 无条件渲染，生产包白白带上整个 devtools。
const ReactQueryDevtools = dynamic(
  () =>
    import('@tanstack/react-query-devtools').then(
      (m) => m.ReactQueryDevtools,
    ),
  { ssr: false },
);

export function QueryProvider({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            retry: 1,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      {children}
      {process.env.NODE_ENV === 'development' && (
        <ReactQueryDevtools initialIsOpen={false} />
      )}
    </QueryClientProvider>
  );
}
