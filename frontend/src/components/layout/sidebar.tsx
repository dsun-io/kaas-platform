"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { buttonVariants, Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
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
  Zap,
  Database,
  Compass,
  CreditCard,
  Receipt,
} from "lucide-react";
import { useState, Fragment } from "react";
import { useAuth } from "@/lib/auth/auth-context";

interface NavItem {
  href: string;
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
    label: "业务",
    items: [
      { href: "/dashboard", label: "仪表盘", icon: LayoutDashboard },
      { href: "/quotations/v2-quote", label: "智能报价", icon: Zap },
      { href: "/quotations", label: "报价历史", icon: FileText },
    ],
  },
  {
    label: "数据",
    items: [
      { href: "/pricing-data", label: "报价数据", icon: Database },
      { href: "/onboarding", label: "新手引导", icon: Compass },
    ],
  },
  {
    label: "财务",
    items: [
      { href: "/invoice/workstation", label: "开票工位", icon: Receipt },
      { href: "/invoice/headers", label: "抬头管理", icon: FileText },
      {
        href: "/invoice/platforms",
        label: "平台配置",
        icon: Settings,
        adminOnly: true,
      },
      { href: "/invoice/templates", label: "开票模板", icon: BookOpen },
      {
        href: "/invoice/audit",
        label: "开票审计",
        icon: History,
        adminOnly: true,
      },
    ],
  },
  {
    label: "订阅",
    items: [{ href: "/billing", label: "升级订阅", icon: CreditCard }],
  },
  {
    label: "客户",
    items: [{ href: "/customers", label: "客户管理", icon: Users }],
  },
  {
    label: "审计",
    items: [
      { href: "/events", label: "事件审计", icon: ScrollText },
      { href: "/audit-log", label: "操作日志", icon: History },
    ],
  },
  {
    label: "管理",
    items: [
      {
        href: "/admin/gray-release",
        label: "灰度切换",
        icon: ToggleLeft,
        adminOnly: true,
      },
      { href: "/kb", label: "知识库", icon: BookOpen, adminOnly: true },
      { href: "/settings", label: "系统设置", icon: Settings, adminOnly: true },
    ],
  },
];

// Groups accessible to all authenticated users
const PUBLIC_GROUP_LABELS = new Set(["业务", "数据", "订阅"]);

function SidebarNav({ collapsed }: { collapsed: boolean }) {
  const pathname = usePathname();
  const { user } = useAuth();
  const isInternal = user?.account_type === "internal";

  return (
    <nav className="flex flex-col gap-4 px-2">
      {navGroups.map((group, index) => {
        // Hide admin-only groups for free users
        if (!isInternal && !PUBLIC_GROUP_LABELS.has(group.label)) {
          return null;
        }

        const visibleItems = group.items.filter(
          (item) => !item.adminOnly || isInternal,
        );
        if (visibleItems.length === 0) return null;

        return (
          <Fragment key={group.label}>
            <div className="flex flex-col gap-1">
              <span
                className={cn(
                  "px-2 text-xs font-medium text-muted-foreground",
                  collapsed && "text-[10px] truncate",
                )}
              >
                {collapsed ? group.label.slice(0, 4) : group.label}
              </span>
              {visibleItems.map((item) => {
                const active =
                  pathname === item.href ||
                  (item.href !== "/" && pathname.startsWith(item.href + "/"));
                return (
                  <Link
                    key={item.href}
                    // eslint-disable-next-line no-restricted-syntax
                    href={item.href as any}
                    prefetch={true}
                    className={cn(
                      buttonVariants({
                        variant: active ? "secondary" : "ghost",
                        size: "default",
                      }),
                      "w-full inline-flex items-center gap-2 no-underline",
                      collapsed &&
                        "flex-col justify-center gap-0.5 px-0 h-auto py-1.5 [&>svg]:mx-auto",
                    )}
                  >
                    <item.icon className="size-4 shrink-0" />
                    <span
                      className={cn(
                        "truncate",
                        collapsed ? "text-[10px] leading-tight" : "",
                      )}
                    >
                      {collapsed ? item.label.slice(0, 4) : item.label}
                    </span>
                  </Link>
                );
              })}
            </div>
            {index < navGroups.length - 1 && <div className="h-px bg-border" />}
          </Fragment>
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
        "hidden h-screen flex-col border-r bg-sidebar pt-4 transition-all duration-200 lg:flex",
        collapsed ? "w-24" : "w-56",
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
          className={cn("ml-auto size-7", collapsed && "mx-auto")}
          onClick={() => setCollapsed(!collapsed)}
        >
          <ChevronLeft
            className={cn(
              "size-4 transition-transform",
              collapsed && "rotate-180",
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
  const { user } = useAuth();
  const isInternal = user?.account_type === "internal";

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
            if (!isInternal && !PUBLIC_GROUP_LABELS.has(group.label)) {
              return null;
            }

            const visibleItems = group.items.filter(
              (item) => !item.adminOnly || isInternal,
            );
            if (visibleItems.length === 0) return null;

            return (
              <div key={group.label} className="flex flex-col gap-1">
                <span className="px-2 text-xs font-medium text-muted-foreground">
                  {group.label}
                </span>
                {visibleItems.map((item) => {
                  const active =
                    pathname === item.href ||
                    (item.href !== "/" && pathname.startsWith(item.href + "/"));
                  return (
                    <Link
                      key={item.href}
                      // eslint-disable-next-line no-restricted-syntax
                      href={item.href as any}
                      prefetch={true}
                      onClick={() => setOpen(false)}
                      className={cn(
                        buttonVariants({
                          variant: active ? "secondary" : "ghost",
                          size: "default",
                        }),
                        "w-full justify-start gap-2 no-underline",
                      )}
                    >
                      <item.icon className="size-4 shrink-0" />
                      <span className="truncate">{item.label}</span>
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
