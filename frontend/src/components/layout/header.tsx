"use client";

import {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbSeparator,
  BreadcrumbPage,
} from "@/components/ui/breadcrumb";
import { Separator } from "@/components/ui/separator";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { usePathname } from "next/navigation";
import { useMemo } from "react";
import { useAuth } from "@/lib/auth/auth-context";
import { useTeam } from "@/lib/team/team-context";
import { Skeleton } from "@/components/ui/skeleton";
import { LogOut, User, CreditCard, Users } from "lucide-react";
import { StatusBadge } from "@/components/shared";
import {
  NAV_GROUPS,
  SUB_ROUTE_LABELS,
  workstationByRoute,
} from "@contracts/workstations";

interface Crumb {
  label: string;
  href?: string;
}

/**
 * 面包屑（单一来源）。
 * 页面名一律来自工位契约（shared/contracts/workstations.ts），不再维护独立的 labelMap ——
 * 历史问题正是这么产生的：
 *   · /market 面包屑写成「市场调研」，与工位「市场调研」(/research) 重名
 *   · research / leadgen / outreach / ai-providers 漏登记 → 直接显示英文 slug
 */
function useBreadcrumbs(pathname: string): Crumb[] {
  return useMemo(() => {
    const ws = workstationByRoute(pathname);
    if (!ws) return [];

    const crumbs: Crumb[] = [];
    const group = NAV_GROUPS.find((g) => g.key === ws.group);
    if (group?.label) crumbs.push({ label: group.label });

    // 工位之后的子路径（如 /customers/123 的 "123"）
    const rest = pathname.slice(ws.route.length).replace(/^\//, "");
    crumbs.push({ label: ws.name, href: rest ? ws.route : undefined });

    if (rest) {
      const last = rest.split("/").filter(Boolean).pop() ?? "";
      // 已知子路由用契约里的中文名（否则会把 company-profile 这种 slug 露给用户）；
      // 长十六进制串视为资源 ID，统一显示为「详情」
      const label = /^[0-9a-f-]{20,}$/i.test(last)
        ? "详情"
        : (SUB_ROUTE_LABELS[last] ?? last);
      crumbs.push({ label });
    }
    return crumbs;
  }, [pathname]);
}

export function Header() {
  const pathname = usePathname();
  const crumbs = useBreadcrumbs(pathname);
  const { user, logout } = useAuth();
  // 团队名 / 团队管理入口：三层组织（管理员 · 团队 · 成员）里"我在哪个团队"是
  // 用户判断"我能看到哪些数据"的第一线索，必须一眼可见（docs §C）
  const { teamName, snapshot } = useTeam();

  const initials =
    user?.display_name?.slice(0, 2) ??
    user?.email?.slice(0, 2).toUpperCase() ??
    "?";

  const isFree = user?.plan === "free";

  return (
    <header className="glass-bar sticky top-3 z-20 mx-3 flex h-14 items-center gap-3 rounded-2xl px-4 md:px-5">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink
              href="/"
              className="text-muted-foreground hover:text-foreground"
            >
              首页
            </BreadcrumbLink>
          </BreadcrumbItem>
          {crumbs.map((c, i) => {
            const isLast = i === crumbs.length - 1;
            return (
              <BreadcrumbItem key={`${c.label}-${i}`}>
                <BreadcrumbSeparator />
                {isLast || !c.href ? (
                  <BreadcrumbPage className="font-medium">
                    {c.label}
                  </BreadcrumbPage>
                ) : (
                  <BreadcrumbLink
                    href={c.href}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    {c.label}
                  </BreadcrumbLink>
                )}
              </BreadcrumbItem>
            );
          })}
        </BreadcrumbList>
      </Breadcrumb>
      <div className="ml-auto" />
      {!snapshot.loading && teamName && (
        <span className="hidden items-center gap-1.5 rounded-full border border-white/70 bg-white/60 px-2.5 py-1 text-xs text-muted-foreground md:inline-flex">
          <Users className="size-3" />
          {teamName}
        </span>
      )}
      {user ? (
        <DropdownMenu>
          <DropdownMenuTrigger className="cursor-pointer rounded-full transition-shadow hover:shadow-md">
            <Avatar className="size-8">
              <AvatarFallback
                className="text-xs font-semibold text-white"
                style={{ background: "var(--gradient-brand)" }}
              >
                {initials}
              </AvatarFallback>
            </Avatar>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-60">
            <DropdownMenuLabel className="font-normal">
              <div className="flex flex-col gap-1">
                <p className="text-sm font-semibold">
                  {user.display_name || user.email}
                </p>
                <p className="text-xs text-muted-foreground">{user.email}</p>
                <div className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Users className="size-3 shrink-0" />
                  {snapshot.loading ? (
                    <Skeleton className="h-3 w-24" />
                  ) : teamName ? (
                    <span className="truncate">{teamName}</span>
                  ) : (
                    <span>未加入团队</span>
                  )}
                </div>
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="cursor-pointer"
              onClick={() => (window.location.href = "/team")}
            >
              <Users className="mr-2 size-4" />
              团队与工位
            </DropdownMenuItem>
            <div className="px-2 py-1.5">
              <StatusBadge
                tone={user.account_type === "internal" ? "purple" : "default"}
              >
                {user.account_type === "internal" ? "内部账号" : "客户账号"}
              </StatusBadge>
            </div>
            {isFree && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="cursor-pointer"
                  onClick={() => (window.location.href = "/billing")}
                >
                  <CreditCard className="mr-2 size-4" />
                  升级订阅
                </DropdownMenuItem>
              </>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={logout}
              className="cursor-pointer text-destructive focus:text-destructive"
            >
              <LogOut className="mr-2 size-4" />
              退出登录
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <User className="size-4 text-muted-foreground" />
      )}
    </header>
  );
}
