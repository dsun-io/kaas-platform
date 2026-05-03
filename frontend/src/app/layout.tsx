import type { Metadata } from 'next';
import './globals.css';
import { Inter } from 'next/font/google';
import { cn } from '@/lib/utils';
import { TooltipProvider } from '@/components/ui/tooltip';
import { QueryProvider } from '@/lib/query/provider';
import { MswProvider } from '@/components/msw-provider';
import { AppLayout } from '@/components/layout/app-layout';
import { Toaster } from '@/components/ui/toaster';

const inter = Inter({ subsets: ['latin'], variable: '--font-sans' });

export const metadata: Metadata = {
  title: 'Kaas — 联凯五金 AI 报价平台',
  description: 'Kaas v2 — 牛栏网智能报价系统',
  icons: { icon: '/favicon.svg' },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN" className={cn('font-sans', inter.variable)}>
      <body>
        <MswProvider>
          <QueryProvider>
            <TooltipProvider>
              <AppLayout>{children}</AppLayout>
              <Toaster />
            </TooltipProvider>
          </QueryProvider>
        </MswProvider>
      </body>
    </html>
  );
}
