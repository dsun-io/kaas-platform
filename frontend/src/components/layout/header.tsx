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
import { Badge } from "@/components/ui/badge";
import { usePathname } from "next/navigation";
import { useAuth } from "@/lib/auth/auth-context";
import { LogOut, User, CreditCard } from "lucide-react";

const labelMap: Record<string, string> = {
  dashboard: "仪表盘",
  events: "事件审计",
  customers: "客户管理",
  quotations: "报价管理",
  "v2-quote": "V2 报价",
  "audit-log": "审计日志",
  kb: "知识库",
  admin: "系统管理",
  "gray-release": "灰度发布",
  settings: "系统设置",
  "pricing-data": "报价数据",
  onboarding: "新手引导",
  billing: "升级订阅",
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
    <header className="flex h-12 items-center gap-3 border-b px-4">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink href="/">首页</BreadcrumbLink>
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
      {user ? (
        <DropdownMenu>
          <DropdownMenuTrigger>
            <Avatar className="size-7 cursor-pointer">
              <AvatarFallback className="text-xs">{initials}</AvatarFallback>
            </Avatar>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel className="font-normal">
              <div className="flex flex-col gap-1">
                <p className="text-sm font-medium">
                  {user.display_name || user.email}
                </p>
                <p className="text-xs text-muted-foreground">{user.email}</p>
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <div className="px-2 py-1.5">
              <Badge
                variant={
                  user.account_type === "internal" ? "default" : "secondary"
                }
                className="text-xs"
              >
                {user.account_type === "internal" ? "内部账号" : "客户账号"}
              </Badge>
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
            <DropdownMenuItem onClick={logout} className="cursor-pointer">
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
