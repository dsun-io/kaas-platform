"use client";

/**
 * 团队管理侧边栏（2026-10-22 新增）：团队管理员视角的四个管理入口。
 *
 * 为什么用 ?tab= 查询参数而不是嵌套路由：静态导出一个 tab 一个页面会让
 * 「团队管理」散成四个 /team/manage/* 路由；查询参数 + 同一页切换足够，
 * 且 e2e/a11y 路由自动发现不会新增路由（少一层回归面）。
 *
 * 注意：侧边栏链接**不要**加显式 prefetch —— 静态导出下会卡死点击
 * （docs/HANDOVER_2026-10-21_NAV_STUCK.md）。
 */
import Link from "next/link";
import {
  KeyRound,
  ListChecks,
  ShieldCheck,
  UserCog,
  Users,
} from "lucide-react";
import { cn } from "@/lib/utils";

export type TeamManageTab =
  | "subscriptions"
  | "members"
  | "invites"
  | "applications"
  // M2-C：审批设置（指定审批人，D-11/D-14）
  | "approvers";

interface TeamManageNavProps {
  teamId: number;
  active: TeamManageTab;
  pendingApplications: number;
}

const NAV_ITEMS: {
  value: TeamManageTab;
  label: string;
  hint: string;
  icon: typeof Users;
}[] = [
  {
    value: "subscriptions",
    label: "工位开通",
    hint: "团队级工位开关",
    icon: KeyRound,
  },
  { value: "members", label: "成员管理", hint: "查看 / 移除成员", icon: Users },
  { value: "invites", label: "邀请码", hint: "生成 / 撤销邀请", icon: UserCog },
  {
    value: "applications",
    label: "加入申请",
    hint: "审核进入申请",
    icon: ListChecks,
  },
  {
    value: "approvers",
    label: "审批设置",
    hint: "指定审批人",
    icon: ShieldCheck,
  },
];

export function TeamManageNav({
  teamId,
  active,
  pendingApplications,
}: TeamManageNavProps) {
  return (
    <nav aria-label="团队管理" className="space-y-1">
      <p className="px-2 pb-1 text-xs font-medium text-muted-foreground">
        团队管理
      </p>
      {NAV_ITEMS.map((item) => {
        const selected = item.value === active;
        const Icon = item.icon;
        return (
          <Link
            key={item.value}
            href={`/team?tab=${item.value}`}
            aria-current={selected ? "page" : undefined}
            className={cn(
              "flex items-start gap-2 rounded-lg px-2 py-2 text-sm transition-colors",
              selected
                ? "bg-primary/[0.08] font-medium text-foreground"
                : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
            )}
          >
            <Icon className="mt-0.5 size-4 shrink-0" />
            <span className="min-w-0 flex-1">
              <span className="block leading-tight">{item.label}</span>
              <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">
                {item.hint}
              </span>
            </span>
            {item.value === "applications" && pendingApplications > 0 && (
              <span
                className="mt-0.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-destructive px-1.5 text-xs font-medium text-destructive-foreground"
                aria-label={`${pendingApplications} 条待审核`}
              >
                {pendingApplications}
              </span>
            )}
          </Link>
        );
      })}
      <p className="px-2 pt-2 text-xs leading-relaxed text-muted-foreground">
        团队 ID：{teamId}
      </p>
    </nav>
  );
}
