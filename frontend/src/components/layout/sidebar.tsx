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
  ReceiptText,
  PackageSearch,
  Package,
  ClipboardList,
  ClipboardCheck,
  Truck,
  Layers,
  Circle,
} from "lucide-react";
import { useState, useMemo, Fragment } from "react";
import { useAuth } from "@/lib/auth/auth-context";
import { useTeam } from "@/lib/team/team-context";
import { Skeleton } from "@/components/ui/skeleton";
import { visibleNavGroups, workstationByRoute } from "@contracts/workstations";
import { filterNavGroups } from "@/lib/workstation/visibility";

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
  Package,
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
  ReceiptText,
  CreditCard,
  Compass,
  Layers,
  ClipboardCheck,
  ScrollText,
  History,
  ToggleLeft,
};

/**
 * 首屏骨架：团队/工位信息回来之前先占位。
 *
 * 为什么必须有：导航是按"已开通工位"过滤的，如果先渲染全量入口再过滤，
 * 用户会看到入口"闪现后消失"（以为自己点错了）。宁可先给骨架。
 */
function SidebarNavSkeleton({ collapsed }: { collapsed: boolean }) {
  return (
    <div className="flex flex-col gap-4 px-3" aria-hidden="true">
      {[0, 1, 2].map((group) => (
        <div key={group} className="flex flex-col gap-1">
          {!collapsed && <Skeleton className="mb-1 h-3 w-12 bg-slate-300/60" />}
          {[0, 1].map((row) => (
            <div
              key={row}
              className={cn(
                "flex items-center gap-2 px-2 py-2",
                collapsed && "flex-col",
              )}
            >
              <Skeleton className="size-[18px] rounded-md bg-slate-300/60" />
              {!collapsed && (
                <Skeleton className="h-3.5 flex-1 bg-slate-300/60" />
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

// 导航数据来自契约（shared/contracts/workstations.ts），此处不再硬编码：
//   · 分组顺序 = 业务推进顺序
//   · 展示名是侧边栏/面包屑/页面标题的唯一来源
//   · status 控制可见性（planned/hidden 不上侧边栏）
//   · 已开通工位再过滤一层（未开通的工位点了就是 404，入口不该出现）
function SidebarNav({ collapsed }: { collapsed: boolean }) {
  const pathname = usePathname();
  const { user, isLoading: authLoading } = useAuth();
  const { snapshot } = useTeam();
  const isInternal = user?.account_type === "internal";

  const groups = useMemo(
    () => filterNavGroups(visibleNavGroups(), snapshot),
    [snapshot],
  );
  // 当前工位（最长前缀匹配）—— 用它判断高亮，
  // 避免 /settings 与 /settings/ai-providers 同时高亮
  const current = workstationByRoute(pathname);

  // 登录态或工位信息未就绪时先出骨架，避免入口闪现后消失
  if (authLoading || snapshot.loading) {
    return <SidebarNavSkeleton collapsed={collapsed} />;
  }

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
                    aria-current={active ? "page" : undefined}
                    aria-label={collapsed ? w.name : undefined}
                    title={collapsed ? w.name : undefined}
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
        "glass-panel relative my-3 ml-3 hidden h-[calc(100vh-1.5rem)] shrink-0 flex-col overflow-hidden rounded-[22px] text-sidebar-foreground transition-[width] duration-200 lg:flex",
        collapsed ? "w-[76px]" : "w-[236px]",
      )}
    >
      <div
        className={cn(
          "flex items-center gap-2.5 px-4 pb-4 pt-5",
          collapsed && "flex-col gap-2 px-2",
        )}
      >
        {collapsed ? (
          <img
            src="/assets/brand/logo.png"
            alt="PowerVoy"
            className="h-8 w-8 shrink-0 rounded-lg object-contain"
          />
        ) : (
          <img
            src="/assets/brand/logo-lockup.png"
            alt="PowerVoy 智能报价平台"
            className="h-7 w-auto shrink-0"
          />
        )}
        <Button
          variant="ghost"
          size="icon"
          className={cn(
            "size-7 text-muted-foreground hover:bg-white/80 hover:text-foreground",
            !collapsed && "ml-auto",
          )}
          onClick={() => setCollapsed(!collapsed)}
          aria-label={collapsed ? "展开侧栏" : "收起侧栏"}
          aria-expanded={!collapsed}
        >
          <ChevronLeft
            className={cn(
              "h-4 w-4 transition-transform",
              collapsed && "rotate-180",
            )}
          />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        <SidebarNav collapsed={collapsed} />
      </div>
    </aside>
  );
}

function MobileSidebar() {
  const [open, setOpen] = useState(false);
  const { user } = useAuth();
  const isInternal = user?.account_type === "internal";

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            className="lg:hidden"
            aria-label="打开导航"
          >
            <Menu className="h-5 w-5" />
          </Button>
        }
      />
      <SheetContent
        side="left"
        className="w-[268px] border-0 bg-white/80 p-0 backdrop-blur-2xl"
      >
        <div className="flex items-center gap-2.5 border-b border-border/70 px-4 py-4">
          <img
            src="/assets/brand/logo-lockup.png"
            alt="PowerVoy 智能报价平台"
            className="h-7 w-auto"
          />
        </div>
        <div className="py-2">
          <SidebarNav collapsed={false} />
        </div>
        {!isInternal && (
          <div className="px-4 py-3 text-[11px] text-muted-foreground">
            客户账号
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

export function Sidebar() {
  return (
    <>
      <DesktopSidebar />
      <div className="glass-bar mx-3 mt-3 flex items-center gap-2 rounded-2xl px-3 py-2 lg:hidden">
        <MobileSidebar />
        <img
          src="/assets/brand/logo-lockup.png"
          alt="PowerVoy"
          className="ml-1 h-6 w-auto"
        />
      </div>
    </>
  );
}
