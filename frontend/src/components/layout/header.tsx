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
import { useAuth } from "@/lib/auth/auth-context";
import { LogOut, User, CreditCard } from "lucide-react";
import { StatusBadge } from "@/components/shared";

const labelMap: Record<string, string> = {
  dashboard: "仪表盘",
  events: "事件审计",
  customers: "客户管理",
  quotations: "报价管理",
  "v2-quote": "智能报价",
  "audit-log": "审计日志",
  kb: "知识库",
  admin: "系统管理",
  "gray-release": "灰度发布",
  settings: "系统设置",
  "pricing-data": "报价数据",
  onboarding: "新手引导",
  billing: "升级订阅",
  intel: "商情雷达",
  market: "产品市场对照",
  "spec-config": "规格配置",
  "spec-proposals": "规格提案",
};

export function Header() {
  const pathname = usePathname();
  const segments = pathname.split("/").filter(Boolean);
  const { user, logout } = useAuth();

  const initials =
    user?.display_name?.slice(0, 2) ??
    user?.email?.slice(0, 2).toUpperCase() ??
    "?";

  const isFree = user?.plan === "free";

  return (
    <header className="glass sticky top-0 z-10 flex h-14 items-center gap-3 border-b px-4 md:px-6">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink href="/" className="text-muted-foreground hover:text-foreground">
              首页
            </BreadcrumbLink>
          </BreadcrumbItem>
          {segments.map((seg, i) => {
            const href = `/${segments.slice(0, i + 1).join("/")}`;
            const label =
              labelMap[seg] ?? (/^[0-9a-f-]{20,}$/i.test(seg) ? "详情" : seg);
            const isLast = i === segments.length - 1;
            return (
              <BreadcrumbItem key={href}>
                <BreadcrumbSeparator />
                {isLast ? (
                  <BreadcrumbPage className="font-medium">{label}</BreadcrumbPage>
                ) : (
                  <BreadcrumbLink href={href} className="text-muted-foreground hover:text-foreground">
                    {label}
                  </BreadcrumbLink>
                )}
              </BreadcrumbItem>
            );
          })}
        </BreadcrumbList>
      </Breadcrumb>
      <div className="ml-auto" />
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
                <p className="text-sm font-semibold">{user.display_name || user.email}</p>
                <p className="text-xs text-muted-foreground">{user.email}</p>
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <div className="px-2 py-1.5">
              <StatusBadge tone={user.account_type === "internal" ? "purple" : "default"}>
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
            <DropdownMenuItem onClick={logout} className="cursor-pointer text-red-600 focus:text-red-600">
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
