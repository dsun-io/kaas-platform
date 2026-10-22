"use client";

import Link from "next/link";
import type { Route } from "next";
import { usePathname, useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { toast } from "sonner";
import { normalizeApiError } from "@/lib/api/api-error";
import {
  LayoutDashboard,
  ScrollText,
  Settings,
  Menu,
  ChevronLeft,
  Users,
  LogOut,
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
  Building2,
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
  Building2,
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
                    // 2026-10-22 修复「点侧边栏无响应」：静态导出（output:"export"）下显式
                    // prefetch={true} 会让点击导航永久挂死（linkClicked 已 preventDefault，
                    // 随后等 prefetch 完成而永不 resolve：30s 内零请求、零报错）。
                    // 本机 A/B：true ⇒ 点击无反应；false ⇒ 立即跳转（见 docs/HANDOVER_2026-10-21_NAV_STUCK.md）。
                    prefetch={false}
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

/** 侧栏底部：当前账号 + 个人信息管理（只读资料 / 团队入口 / 退出）。 */
function SidebarUser({ collapsed = false }: { collapsed?: boolean }) {
  const { user, logout, updateProfile, changePassword } = useAuth();
  const { teamName } = useTeam();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  // 个人信息编辑（TODO(TODO:F3)）：显示名可改；密码单独折叠块（必须验旧密码）
  const [displayName, setDisplayName] = useState("");
  const [savingName, setSavingName] = useState(false);
  const [showPwd, setShowPwd] = useState(false);
  const [currentPwd, setCurrentPwd] = useState("");
  const [newPwd, setNewPwd] = useState("");
  const [savingPwd, setSavingPwd] = useState(false);
  if (!user) return null;

  const openProfile = () => {
    setDisplayName(user.display_name || user.email);
    setShowPwd(false);
    setCurrentPwd("");
    setNewPwd("");
    setOpen(true);
  };

  const saveName = async () => {
    const next = displayName.trim();
    if (!next || next === user.display_name) return;
    setSavingName(true);
    try {
      await updateProfile(next);
      toast.success("显示名已更新");
    } catch (err) {
      const { message } = normalizeApiError(err);
      toast.error(message || "保存失败，请重试");
    } finally {
      setSavingName(false);
    }
  };

  const savePassword = async () => {
    setSavingPwd(true);
    try {
      await changePassword(currentPwd, newPwd);
      toast.success("密码已修改，下次登录请使用新密码");
      setCurrentPwd("");
      setNewPwd("");
      setShowPwd(false);
    } catch (err) {
      const { message } = normalizeApiError(err);
      toast.error(message || "修改失败：当前密码可能不正确");
    } finally {
      setSavingPwd(false);
    }
  };

  const name = user.display_name || user.email;
  const initials =
    user.display_name?.slice(0, 2) ??
    user.email?.slice(0, 2).toUpperCase() ??
    "?";

  return (
    <>
      <button
        type="button"
        onClick={openProfile}
        title={collapsed ? "个人信息" : undefined}
        aria-label="个人信息"
        className={cn(
          "flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left transition-colors hover:bg-white/70",
          collapsed && "justify-center px-0",
        )}
      >
        <Avatar className="size-8 shrink-0">
          <AvatarFallback
            className="text-xs font-semibold text-white"
            style={{ background: "var(--gradient-brand)" }}
          >
            {initials}
          </AvatarFallback>
        </Avatar>
        {!collapsed && (
          <div className="min-w-0">
            <p className="truncate text-xs font-medium">{name}</p>
            <p className="truncate text-[11px] text-muted-foreground">
              {user.email}
            </p>
          </div>
        )}
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md rounded-2xl border border-white/60 bg-white/90 backdrop-blur-2xl">
          <DialogHeader>
            <DialogTitle>个人信息</DialogTitle>
            <DialogDescription>
              可修改显示名与密码；邮箱是登录标识，如需更换请联系管理员。
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-3 rounded-xl border border-border/60 bg-white/60 p-3">
            <Avatar className="size-11">
              <AvatarFallback
                className="text-sm font-semibold text-white"
                style={{ background: "var(--gradient-brand)" }}
              >
                {initials}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">{name}</p>
              <p className="truncate text-xs text-muted-foreground">
                {user.email}
              </p>
            </div>
          </div>
          {/* 显示名（可编辑，TODO(TODO:F3)） */}
          <div className="space-y-1.5">
            <label
              className="text-xs font-medium text-muted-foreground"
              htmlFor="profile-display-name"
            >
              显示名
            </label>
            <div className="flex gap-2">
              <Input
                id="profile-display-name"
                value={displayName}
                maxLength={64}
                disabled={savingName}
                onChange={(e) => setDisplayName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void saveName();
                }}
              />
              <Button
                size="sm"
                onClick={() => void saveName()}
                disabled={
                  savingName ||
                  !displayName.trim() ||
                  displayName.trim() === (user.display_name ?? "")
                }
              >
                {savingName ? "保存中…" : "保存"}
              </Button>
            </div>
          </div>

          {/* 修改密码（折叠；必须验旧密码，后端 403 INVALID_CURRENT_PASSWORD） */}
          <div className="rounded-xl border border-border/60 bg-white/40 p-3">
            <button
              type="button"
              className="flex w-full items-center justify-between text-sm font-medium"
              onClick={() => setShowPwd((v) => !v)}
            >
              修改密码
              <span className="text-xs font-normal text-muted-foreground">
                {showPwd ? "收起" : "展开"}
              </span>
            </button>
            {showPwd && (
              <div className="mt-2 space-y-2">
                <Input
                  type="password"
                  placeholder="当前密码"
                  autoComplete="current-password"
                  value={currentPwd}
                  disabled={savingPwd}
                  onChange={(e) => setCurrentPwd(e.target.value)}
                />
                <Input
                  type="password"
                  placeholder="新密码（至少 8 位）"
                  autoComplete="new-password"
                  value={newPwd}
                  disabled={savingPwd}
                  onChange={(e) => setNewPwd(e.target.value)}
                />
                <div className="flex justify-end">
                  <Button
                    size="sm"
                    onClick={() => void savePassword()}
                    disabled={savingPwd || !currentPwd || newPwd.length < 8}
                  >
                    {savingPwd ? "提交中…" : "修改密码"}
                  </Button>
                </div>
              </div>
            )}
          </div>

          <dl className="grid grid-cols-[72px_1fr] gap-x-3 gap-y-2 text-sm">
            <dt className="text-muted-foreground">账号类型</dt>
            <dd>
              {user.account_type === "internal" ? "内部账号" : "客户账号"}
            </dd>
            <dt className="text-muted-foreground">角色</dt>
            <dd>{user.role || "—"}</dd>
            <dt className="text-muted-foreground">团队</dt>
            <dd>{teamName || "未加入团队"}</dd>
            <dt className="text-muted-foreground">套餐</dt>
            <dd>{user.plan || "—"}</dd>
          </dl>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {/* 入口口径（C32）：`shared/contracts/workstations.ts` 里 billing 是
                `adminOnly:false / subscription:null / status:'hidden'`（注释「移入头像菜单」），
                页面自身无 admin 守卫 ⇒ 所有登录用户可见，这里**不加宽权限**。
                页面目前是占位（免费版 + 「订阅升级即将开放，请联系管理员」）⇒ 菜单如实标注。 */}
            <Button
              variant="outline"
              onClick={() => {
                setOpen(false);
                router.push("/billing");
              }}
            >
              <CreditCard className="mr-1.5 size-4" />
              升级订阅（即将上线）
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                router.push("/team");
              }}
            >
              <Users className="mr-1.5 size-4" />
              团队与工位
            </Button>
            {/* 企业信息（2026-10-22 用户要求）：入口原来只藏在报价页的链接里，
                现在侧边栏「账号」组 + 头像菜单双入口。**所有登录用户可见** ——
                页面本身对成员只读（保存要团队管理员，与后端 _require_team_admin 同口径），
                所以这里不按角色隐藏，否则成员连「查看抬头/收款行」都做不到。 */}
            <Button
              variant="outline"
              onClick={() => {
                router.push("/settings/company-profile");
              }}
            >
              <Building2 className="mr-1.5 size-4" />
              企业信息
            </Button>
            <Button
              variant="outline"
              className="text-destructive hover:text-destructive"
              onClick={() => void logout()}
            >
              <LogOut className="mr-1.5 size-4" />
              退出登录
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
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

      <div className="mt-auto border-t border-white/50 px-2 py-2">
        <SidebarUser collapsed={collapsed} />
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
        className="flex w-[268px] flex-col border-0 bg-white/80 p-0 backdrop-blur-2xl"
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
        <div className="mt-auto border-t border-white/50 px-2 py-2">
          <SidebarUser />
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
