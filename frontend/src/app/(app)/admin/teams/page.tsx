"use client";

/**
 * 团队管理（`/admin/teams`）—— 平台管理员的**全量**团队视图。
 *
 * 与 `/team` 的区别：
 *   · `/team` 是"我这个团队"（团队管理员自助：成员 / 邀请 / 工位开通）；
 *   · 本页是**平台视角**：所有团队 + 创建者 + 成员数 + 已开通工位，用于运营排查
 *     "某个客户团队怎么还没开通工位 / 团队里到底有谁"。
 *
 * 权限：`<RouteGuard adminOnly>`（与后端 GET /teams 的 ADMIN_ONLY 闸门同口径）；
 * 前端隐藏不是权限边界，403 时页面照常渲染错误信息 + 重试按钮。
 *
 * 详情弹窗直接复用 `TeamMembersPanel` / `TeamSubscriptionsPanel`（两个组件已按
 * `teamId` 参数化），不重写成员/工位逻辑 —— 否则"团队管理员视角"和"平台视角"
 * 两套行为迟早漂移。
 */
import { useState } from "react";
import { AlertCircle, RefreshCw, Users, X } from "lucide-react";

import { EmptyState, PageHeader } from "@/components/shared";
import { RouteGuard } from "@/components/route-guard";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/lib/auth/auth-context";
import { usePageView } from "@/lib/events/use-page-view";
import { useAdminTeams, type AdminTeam } from "@/lib/team/use-admin-teams";
import { TeamMembersPanel } from "@/app/(app)/team/components/team-members-panel";
import { TeamSubscriptionsPanel } from "@/app/(app)/team/components/team-subscriptions-panel";

/** ISO 时间 → 本地可读时间；坏值原样显示（不吞掉后端给的线索）。 */
function formatDateTime(value: string | null): string {
  if (!value) return "—";
  const ts = Date.parse(value);
  if (Number.isNaN(ts)) return value;
  return new Date(ts).toLocaleString("zh-CN", { hour12: false });
}

/** 创建者主文案：name > email > #id（三者都可能缺，缺了显示占位）。 */
function creatorPrimary(team: AdminTeam): string {
  return (
    team.created_by_name ??
    team.created_by_email ??
    (team.created_by !== null ? `#${team.created_by}` : "—")
  );
}

/** 创建者次文案：主文案之外还能补充的信息（有 name 就补 email，否则补 #id）。 */
function creatorSecondary(team: AdminTeam): string | null {
  if (team.created_by_name && team.created_by_email) {
    return team.created_by_email;
  }
  if (team.created_by !== null && team.created_by_email === null) {
    return `#${team.created_by}`;
  }
  return null;
}

function workstationsHint(team: AdminTeam): string | undefined {
  if (team.workstation_codes.length === 0) return undefined;
  return `已开通：${team.workstation_codes.join("、")}`;
}

/** 团队详情弹窗（玻璃底 + 固定 1080×760，内容区滚动；参考 customers 详情弹窗）。 */
function TeamDetailDialog({
  team,
  currentUserId,
  onClose,
}: {
  team: AdminTeam;
  currentUserId: number | null;
  onClose: () => void;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="flex h-[min(760px,calc(100vh-4rem))] w-[min(1080px,calc(100vw-2rem))] max-w-none flex-col gap-0 overflow-hidden rounded-2xl border border-white/60 bg-white/85 p-0 shadow-[0_30px_80px_-30px_rgba(15,23,42,0.45)] backdrop-blur-2xl sm:max-w-none"
      >
        <div className="flex items-start justify-between gap-4 border-b border-border/70 px-6 py-4">
          <div className="min-w-0">
            <DialogTitle className="truncate text-lg font-semibold">
              {team.name}
            </DialogTitle>
            <DialogDescription className="mt-1 text-xs text-muted-foreground">
              团队详情 · {team.member_count} 名成员 · {team.workstation_count}{" "}
              个已开通工位
            </DialogDescription>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            aria-label="关闭团队详情"
          >
            <X className="size-4" />
          </Button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-4">
          <div className="rounded-xl border border-border/70 bg-white/70 p-4">
            <div className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
              <div>
                <span className="text-muted-foreground">团队名称：</span>
                <span className="ml-1">{team.name}</span>
              </div>
              <div>
                <span className="text-muted-foreground">创建者：</span>
                <span className="ml-1">{creatorPrimary(team)}</span>
                {team.created_by !== null && (
                  <span className="ml-1 text-xs text-muted-foreground">
                    （#{team.created_by}）
                  </span>
                )}
              </div>
              <div>
                <span className="text-muted-foreground">创建时间：</span>
                <span className="ml-1">{formatDateTime(team.created_at)}</span>
              </div>
              <div>
                <span className="text-muted-foreground">成员数：</span>
                <span className="ml-1">{team.member_count} 人</span>
              </div>
              <div>
                <span className="text-muted-foreground">已开通工位：</span>
                <span className="ml-1">{team.workstation_count} 个</span>
              </div>
              {team.workstation_codes.length > 0 && (
                <div className="sm:col-span-2">
                  <span className="text-muted-foreground">工位码：</span>
                  <span className="ml-1 font-mono text-xs">
                    {team.workstation_codes.join("、")}
                  </span>
                </div>
              )}
            </div>
          </div>

          <TeamMembersPanel teamId={team.id} currentUserId={currentUserId} />
          <TeamSubscriptionsPanel teamId={team.id} />
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** 列表加载中的骨架（表格版：一行一条，避免布局跳动）。 */
function TeamsTableSkeleton() {
  return (
    <div className="space-y-2" aria-busy="true">
      {Array.from({ length: 5 }).map((_, i) => (
        <Skeleton key={i} className="h-12 w-full rounded-lg" />
      ))}
    </div>
  );
}

function AdminTeamsContent() {
  const { items, total, loading, error, reload } = useAdminTeams();
  const { user } = useAuth();
  const currentUserId = user?.user_id ?? null;
  const [selected, setSelected] = useState<AdminTeam | null>(null);

  return (
    <div className="space-y-6">
      <PageHeader
        title="团队管理"
        description="查看所有团队、成员与工位开通情况（仅系统管理员）"
      />

      <Card>
        <CardHeader className="pb-3">
          <CardTitle>全部团队</CardTitle>
          <CardAction>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">
                共 {total} 个团队
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={reload}
                disabled={loading}
              >
                <RefreshCw className="mr-1 size-3.5" />
                刷新
              </Button>
            </div>
          </CardAction>
        </CardHeader>
        <CardContent>
          {loading ? (
            <TeamsTableSkeleton />
          ) : error ? (
            <div className="flex flex-col items-start gap-2 py-4 text-sm">
              <div className="flex items-center gap-2 text-destructive">
                <AlertCircle className="size-4" />
                {error}
              </div>
              <Button size="sm" variant="outline" onClick={reload}>
                重试
              </Button>
            </div>
          ) : items.length === 0 ? (
            <EmptyState
              icon={Users}
              title="暂无团队"
              description="平台上还没有任何团队。用户注册后创建团队即可在此查看。"
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="px-4 py-2.5 font-medium">团队</th>
                    <th className="px-4 py-2.5 font-medium">创建者</th>
                    <th className="px-4 py-2.5 font-medium">成员数</th>
                    <th className="px-4 py-2.5 font-medium">已开通工位</th>
                    <th className="px-4 py-2.5 font-medium">创建时间</th>
                    <th className="px-4 py-2.5 text-right font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((team) => (
                    <tr
                      key={team.id}
                      tabIndex={0}
                      aria-label={`查看团队 ${team.name}`}
                      className="cursor-pointer border-b last:border-0 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/30"
                      onClick={() => setSelected(team)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setSelected(team);
                        }
                      }}
                    >
                      <td className="px-4 py-3">
                        <p className="font-medium text-foreground">
                          {team.name}
                        </p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          #{team.id}
                        </p>
                      </td>
                      <td className="px-4 py-3">
                        <p>{creatorPrimary(team)}</p>
                        {creatorSecondary(team) && (
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            {creatorSecondary(team)}
                          </p>
                        )}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {team.member_count} 人
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className="text-muted-foreground"
                          title={workstationsHint(team)}
                        >
                          {team.workstation_count} 个
                        </span>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {formatDateTime(team.created_at)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Button
                          size="sm"
                          variant="outline"
                          aria-label={`查看团队 ${team.name}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelected(team);
                          }}
                        >
                          查看
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {selected && (
        <TeamDetailDialog
          team={selected}
          currentUserId={currentUserId}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

export default function AdminTeamsPage() {
  usePageView({ resource_id: "/admin/teams" });

  return (
    <RouteGuard adminOnly>
      <AdminTeamsContent />
    </RouteGuard>
  );
}
