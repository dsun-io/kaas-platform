"use client";

import Link from "next/link";
import type { Route } from "next";
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
  Target,
  Send,
  Sparkles,
  PackageSearch,
  ClipboardList,
  ClipboardCheck,
  Truck,
  Layers,
  Circle,
} from "lucide-react";
import { useState, Fragment } from "react";
import { useAuth } from "@/lib/auth/auth-context";
import { visibleNavGroups, workstationByRoute } from "@contracts/workstations";

/**
 * 图标名 → 组件映射。
 * 契约（shared/contracts/workstations.ts）只存字符串名（不依赖 React），
 * 这里负责解析；名字缺失时回退 Circle，避免整个侧边栏渲染失败。
 */
const STATION_ICONS: Record<
  string,
  React.ComponentType<{ className?: string }>
> = {
  LayoutDashboard,
  PackageSearch,
  Target,
  Send,
  Zap,
  FileText,
  ClipboardList,
  Truck,
  Radar,
  Database,
  BookOpen,
  Users,
  Settings,
  Sparkles,
  CreditCard,
  Compass,
  Layers,
  ClipboardCheck,
  ScrollText,
  History,
  ToggleLeft,
};

// 导航数据来自契约（shared/contracts/workstations.ts），此处不再硬编码：
//   · 分组顺序 = 业务推进顺序
//   · 展示名是侧边栏/面包屑/页面标题的唯一来源
//   · status 控制可见性（planned/hidden 不上侧边栏）
function SidebarNav({ collapsed }: { collapsed: boolean }) {
  const pathname = usePathname();
  const { user } = useAuth();
  const isInternal = user?.account_type === "internal";

  const groups = visibleNavGroups();
  // 当前工位（最长前缀匹配）—— 用它判断高亮，
  // 避免 /settings 与 /settings/ai-providers 同时高亮
  const current = workstationByRoute(pathname);

  return (
    <nav className="flex flex-col px-3">
      {groups.map((group) => {
        if (group.internalOnly && !isInternal) return null;
        const items = group.items.filter((w) => !w.adminOnly || isInternal);
        if (items.length === 0) return null;

        return (
          <Fragment key={group.key}>
            {group.label && (
              <div className="nav-group-label">{group.label}</div>
            )}
            <div className="flex flex-col gap-0.5">
              {items.map((w) => {
                const Icon = STATION_ICONS[w.icon] ?? Circle;
                const active = current?.key === w.key;
                return (
                  <Link
                    key={w.key}
                    href={w.route as Route}
                    prefetch={true}
                    className={cn(
                      "nav-item no-underline",
                      active && "active",
                      collapsed && "flex-col gap-1 px-2 py-2",
                    )}
                  >
                    <Icon
                      className={cn(
                        "shrink-0",
                        collapsed ? "h-5 w-5" : "h-[18px] w-[18px]",
                      )}
                    />
                    {!collapsed && <span className="truncate">{w.name}</span>}
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
        collapsed ? "w-[68px]" : "w-[240px]",
      )}
      style={{ background: "var(--gradient-sidebar)" }}
    >
      <div
        className={cn(
          "flex items-center gap-2.5 px-4 pb-6 pt-5",
          collapsed && "flex-col px-2",
        )}
      >
        {collapsed ? (
          <img
            src="/assets/brand/logo.png"
            alt="PowerVoy"
            className="h-8 w-8 shrink-0 rounded-lg"
          />
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
            !collapsed && "ml-auto",
          )}
          onClick={() => setCollapsed(!collapsed)}
        >
          <ChevronLeft
            className={cn(
              "h-4 w-4 transition-transform",
              collapsed && "rotate-180",
            )}
          />
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto pb-4">
        <SidebarNav collapsed={collapsed} />
      </div>

      {!collapsed && (
        <div className="border-t border-sidebar-border px-4 py-3">
          <p className="text-[10px] text-sidebar-foreground/30">
            PowerVoy Intel Workstation v1.0
          </p>
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
      <SheetContent
        side="left"
        className="w-[260px] p-0"
        style={{ background: "var(--gradient-sidebar)" }}
      >
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
          <img
            src="/assets/brand/logo.png"
            alt="PowerVoy"
            className="h-7 w-7 rounded-md"
          />
          <span className="text-[15px] font-bold">PowerVoy</span>
        </div>
      </div>
    </>
  );
}
