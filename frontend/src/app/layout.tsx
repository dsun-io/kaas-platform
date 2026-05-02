import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Kaas — 联凯五金 AI 报价平台',
  description: 'Kaas v2 — 牛栏网智能报价系统',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
