"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
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
  Radar,
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
      { href: "/intel", label: "商情雷达", icon: Radar, adminOnly: true },
      { href: "/market", label: "产品市场对照", icon: BookOpen, adminOnly: true },
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
      { href: "/admin/gray-release", label: "灰度切换", icon: ToggleLeft, adminOnly: true },
      { href: "/kb", label: "知识库", icon: BookOpen, adminOnly: true },
      { href: "/settings", label: "系统设置", icon: Settings, adminOnly: true },
    ],
  },
];

const PUBLIC_GROUP_LABELS = new Set(["业务", "数据", "订阅"]);

function SidebarNav({ collapsed }: { collapsed: boolean }) {
  const pathname = usePathname();
  const { user } = useAuth();
  const isInternal = user?.account_type === "internal";

  return (
    <nav className="flex flex-col px-3">
      {navGroups.map((group) => {
        if (!isInternal && !PUBLIC_GROUP_LABELS.has(group.label)) return null;
        const visibleItems = group.items.filter((i) => !i.adminOnly || isInternal);
        if (visibleItems.length === 0) return null;

        return (
          <Fragment key={group.label}>
            <div className="nav-group-label">{group.label}</div>
            <div className="flex flex-col gap-0.5">
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
                      "nav-item no-underline",
                      active && "active",
                      collapsed && "flex-col gap-1 px-2 py-2"
                    )}
                  >
                    <item.icon className={cn("shrink-0", collapsed ? "h-5 w-5" : "h-[18px] w-[18px]")} />
                    {!collapsed && <span className="truncate">{item.label}</span>}
                  </Link>
                );
              })}
            </div>
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
        "hidden h-screen flex-col text-sidebar-foreground lg:flex",
        "border-r border-sidebar-border",
        collapsed ? "w-[68px]" : "w-[240px]"
      )}
      style={{ background: "var(--gradient-sidebar)" }}
    >
      {/* Brand */}
      <div className={cn("flex items-center gap-2.5 px-4 pb-6 pt-5", collapsed && "flex-col px-2")}>
        {collapsed ? (
          <img src="/assets/brand/logo.png" alt="PowerVoy" className="h-8 w-8 shrink-0 rounded-lg" />
        ) : (
          <img
            src="/assets/brand/logo-lockup-white.png"
            alt="PowerVoy 智能报价平台"
            className="h-8 w-auto shrink-0"
          />
        )}
        <Button
          variant="ghost"
          size="icon"
          className={cn(
            "size-7 text-sidebar-foreground/50 hover:bg-sidebar-accent hover:text-sidebar-foreground",
            !collapsed && "ml-auto"
          )}
          onClick={() => setCollapsed(!collapsed)}
        >
          <ChevronLeft className={cn("h-4 w-4 transition-transform", collapsed && "rotate-180")} />
        </Button>
      </div>

      {/* Nav */}
      <div className="flex-1 overflow-y-auto pb-4">
        <SidebarNav collapsed={collapsed} />
      </div>

      {/* Footer */}
      {!collapsed && (
        <div className="border-t border-sidebar-border px-4 py-3">
          <p className="text-[10px] text-sidebar-foreground/30">PowerVoy Intel Workstation v1.0</p>
        </div>
      )}
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
            <Menu className="h-5 w-5" />
          </Button>
        }
      />
      <SheetContent side="left" className="w-[260px] p-0" style={{ background: "var(--gradient-sidebar)" }}>
        <div className="flex items-center gap-2.5 border-b border-sidebar-border px-4 py-4">
          <img
            src="/assets/brand/logo-lockup-white.png"
            alt="PowerVoy 智能报价平台"
            className="h-8 w-auto"
          />
        </div>
        <div className="py-2">
          <SidebarNav collapsed={false} />
        </div>
      </SheetContent>
    </Sheet>
  );
}

export function Sidebar() {
  return (
    <>
      <DesktopSidebar />
      <div className="flex items-center border-b bg-card px-3 py-2 lg:hidden">
        <MobileSidebar />
        <div className="ml-2 flex items-center gap-2">
          <img src="/assets/brand/logo.png" alt="PowerVoy" className="h-7 w-7 rounded-md" />
          <span className="text-[15px] font-bold">PowerVoy</span>
        </div>
      </div>
    </>
  );
}
