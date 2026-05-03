'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/sheet';
import {
  LayoutDashboard,
  ScrollText,
  Settings,
  Menu,
  ChevronLeft,
  Users,
  FileText,
  ToggleLeft,
  BookOpen,
  History,
} from 'lucide-react';
import { useState } from 'react';

interface NavItem {
  href: `/${string}`;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  adminOnly?: boolean;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

const navGroups: NavGroup[] = [
  {
    label: '业务',
    items: [
      { href: '/dashboard', label: '仪表盘', icon: LayoutDashboard },
      { href: '/customers', label: '客户管理', icon: Users },
      { href: '/quotations', label: '报价历史', icon: FileText },
    ],
  },
  {
    label: '审计',
    items: [
      { href: '/events', label: '事件审计', icon: ScrollText },
      { href: '/audit-log', label: '操作日志', icon: History },
    ],
  },
  {
    label: '管理',
    items: [
      { href: '/admin/gray-release', label: '灰度切换', icon: ToggleLeft, adminOnly: true },
      { href: '/kb', label: '知识库', icon: BookOpen, adminOnly: true },
      { href: '/settings', label: '系统设置', icon: Settings, adminOnly: true },
    ],
  },
];

const isAdmin = true;

function SidebarNav({ collapsed }: { collapsed: boolean }) {
  const pathname = usePathname();

  return (
    <nav className="flex flex-col gap-4 px-2">
      {navGroups.map((group) => {
        const visibleItems = group.items.filter(
          (item) => !item.adminOnly || isAdmin
        );
        if (visibleItems.length === 0) return null;

        return (
          <div key={group.label} className="flex flex-col gap-1">
            {!collapsed && (
              <span className="px-2 text-xs font-medium text-muted-foreground">
                {group.label}
              </span>
            )}
            {visibleItems.map((item) => {
              const active = pathname.startsWith(item.href);
              return (
                <Link key={item.href} href={{ pathname: item.href }}>
                  <Button
                    variant={active ? 'secondary' : 'ghost'}
                    size="default"
                    className={cn(
                      'w-full',
                      collapsed ? 'justify-center px-0' : 'justify-start'
                    )}
                  >
                    <item.icon className="size-4 shrink-0" />
                    {!collapsed && <span className="ml-2">{item.label}</span>}
                  </Button>
                </Link>
              );
            })}
          </div>
        );
      })}
    </nav>
  );
}

function DesktopSidebar() {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <aside
      className={cn(
        'hidden h-screen flex-col border-r bg-sidebar pt-4 transition-all duration-200 lg:flex',
        collapsed ? 'w-16' : 'w-56'
      )}
    >
      <div className="flex items-center px-4 pb-4">
        {!collapsed && (
          <span className="text-lg font-semibold text-sidebar-foreground">
            Kaas
          </span>
        )}
        <Button
          variant="ghost"
          size="icon"
          className={cn('ml-auto size-7', collapsed && 'mx-auto')}
          onClick={() => setCollapsed(!collapsed)}
        >
          <ChevronLeft
            className={cn(
              'size-4 transition-transform',
              collapsed && 'rotate-180'
            )}
          />
        </Button>
      </div>
      <SidebarNav collapsed={collapsed} />
    </aside>
  );
}

function MobileSidebar() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger
        render={
          <Button variant="ghost" size="icon" className="lg:hidden">
            <Menu className="size-5" />
          </Button>
        }
      />
      <SheetContent side="left" className="w-56 p-0">
        <div className="border-b px-4 py-3">
          <span className="text-lg font-semibold">Kaas</span>
        </div>
        <nav className="flex flex-col gap-4 p-2">
          {navGroups.map((group) => {
            const visibleItems = group.items.filter(
              (item) => !item.adminOnly || isAdmin
            );
            if (visibleItems.length === 0) return null;

            return (
              <div key={group.label} className="flex flex-col gap-1">
                <span className="px-2 text-xs font-medium text-muted-foreground">
                  {group.label}
                </span>
                {visibleItems.map((item) => {
                  const active = pathname.startsWith(item.href);
                  return (
                    <Link
                      key={item.href}
                      href={{ pathname: item.href }}
                      onClick={() => setOpen(false)}
                    >
                      <Button
                        variant={active ? 'secondary' : 'ghost'}
                        size="default"
                        className="w-full justify-start"
                      >
                        <item.icon className="size-4" />
                        <span className="ml-2">{item.label}</span>
                      </Button>
                    </Link>
                  );
                })}
              </div>
            );
          })}
        </nav>
      </SheetContent>
    </Sheet>
  );
}

export function Sidebar() {
  return (
    <>
      <DesktopSidebar />
      <div className="flex items-center border-b px-3 py-2 lg:hidden">
        <MobileSidebar />
        <span className="ml-2 text-lg font-semibold">Kaas</span>
      </div>
    </>
  );
}
