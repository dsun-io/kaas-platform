'use client';

import {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbSeparator,
  BreadcrumbPage,
} from '@/components/ui/breadcrumb';
import { Separator } from '@/components/ui/separator';
import { usePathname } from 'next/navigation';

const labelMap: Record<string, string> = {
  dashboard: '仪表盘',
  events: '事件审计',
  settings: '系统设置',
};

export function Header() {
  const pathname = usePathname();
  const segments = pathname.split('/').filter(Boolean);

  return (
    <header className="flex h-12 items-center gap-3 border-b px-4">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink href="/">首页</BreadcrumbLink>
          </BreadcrumbItem>
          {segments.map((seg, i) => {
            const href = `/${segments.slice(0, i + 1).join('/')}`;
            const label = labelMap[seg] ?? seg;
            const isLast = i === segments.length - 1;
            return (
              <BreadcrumbItem key={href}>
                <BreadcrumbSeparator />
                {isLast ? (
                  <BreadcrumbPage>{label}</BreadcrumbPage>
                ) : (
                  <BreadcrumbLink href={href}>{label}</BreadcrumbLink>
                )}
              </BreadcrumbItem>
            );
          })}
        </BreadcrumbList>
      </Breadcrumb>
      <div className="ml-auto" />
      <Separator orientation="vertical" className="h-6" />
      {/* Placeholder for user menu */}
    </header>
  );
}
