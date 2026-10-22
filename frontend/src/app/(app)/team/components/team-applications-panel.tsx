"use client";

/**
 * 加入申请审核面板（仅团队管理员可见，2026-10-22 新增）。
 *
 * 与邀请码的分工：邀请码"拿到就能进"；加入申请是"请求进入"，团队管理员在这里
 * 把关 —— 通过才落 users.team_id（团队订阅工位团队级共享，通过即获得），
 * 驳回可重新申请，申请人可自行撤回。
 *
 * 数据流：待审列表由页面级 fetch 一次提供（侧边栏徽标也要用同一个计数，
 * 不各查各的）；「全部」页签按需切到 status=all 查询。
 */
import { useState } from "react";
import { toast } from "sonner";
import { AlertCircle, Check, RefreshCw, UserPlus, XCircle } from "lucide-react";

import { teamErrorMessage } from "@/lib/team/team-errors";
import {
  APPLICATION_STATUS_TEXT,
  type JoinApplicationStatus,
} from "@/lib/team/join-applications";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge } from "@/components/shared/status-badge";
import { EmptyState } from "@/components/shared/empty-state";
import {
  approveJoinApplication,
  rejectJoinApplication,
  useTeamJoinApplications,
  type TeamApplicationRow,
  type TeamListResult,
} from "../hooks/use-team-admin";

interface TeamApplicationsPanelProps {
  teamId: number;
  pending: TeamListResult<TeamApplicationRow>;
}

function formatTime(value: string | null): string {
  if (!value) return "—";
  const ts = Date.parse(value);
  if (Number.isNaN(ts)) return value;
  return new Date(ts).toLocaleString("zh-CN", { hour12: false });
}

function statusTone(
  status: JoinApplicationStatus,
): "success" | "danger" | "warning" | "info" {
  if (status === "approved") return "success";
  if (status === "rejected") return "danger";
  if (status === "canceled") return "warning";
  return "info";
}

export function TeamApplicationsPanel({
  teamId,
  pending,
}: TeamApplicationsPanelProps) {
  const [showAll, setShowAll] = useState(false);
  const all = useTeamJoinApplications(teamId, showAll, "all");
  const view = showAll ? all : pending;
  const [busyId, setBusyId] = useState<number | null>(null);
  const [rejectingId, setRejectingId] = useState<number | null>(null);
  const [rejectReason, setRejectReason] = useState("");

  async function approve(app: TeamApplicationRow) {
    setBusyId(app.id);
    try {
      await approveJoinApplication(teamId, app.id);
      toast.success(`${app.display_name || app.email} 已加入团队`);
      view.reload();
    } catch (err: unknown) {
      toast.error(teamErrorMessage(err, "操作失败，请稍后重试"));
    } finally {
      setBusyId(null);
    }
  }

  async function reject(app: TeamApplicationRow) {
    setBusyId(app.id);
    try {
      await rejectJoinApplication(teamId, app.id, rejectReason.trim() || null);
      toast.success("已驳回该申请");
      setRejectingId(null);
      setRejectReason("");
      view.reload();
    } catch (err: unknown) {
      toast.error(teamErrorMessage(err, "操作失败，请稍后重试"));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <SectionCard
      title="加入申请"
      description="注册时填写了你的团队名、但没有邀请码的用户会出现在这里。通过即入团（自动获得团队已开通工位）；驳回后对方可再次申请。"
      action={
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant={showAll ? "ghost" : "secondary"}
            onClick={() => setShowAll(false)}
          >
            待审核
            {pending.items.length > 0 ? `（${pending.items.length}）` : ""}
          </Button>
          <Button
            size="sm"
            variant={showAll ? "secondary" : "ghost"}
            onClick={() => setShowAll(true)}
          >
            全部
          </Button>
          <Button size="sm" variant="ghost" onClick={view.reload}>
            <RefreshCw className="mr-1 size-3.5" />
            刷新
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        {view.loading ? (
          <div className="space-y-2" aria-busy="true">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full rounded-lg" />
            ))}
          </div>
        ) : view.error ? (
          <div className="flex flex-col items-start gap-2 py-2 text-sm">
            <div className="flex items-center gap-2 text-destructive">
              <AlertCircle className="size-4" />
              {view.error}
            </div>
            <Button size="sm" variant="outline" onClick={view.reload}>
              重试
            </Button>
          </div>
        ) : view.items.length === 0 ? (
          <EmptyState
            icon={UserPlus}
            title={showAll ? "还没有加入申请" : "没有待审核的申请"}
            description="新用户注册时填写你的团队名，即可选择直接发起加入申请。"
          />
        ) : (
          <ul className="space-y-2">
            {view.items.map((app) => (
              <li
                key={app.id}
                className="space-y-2 rounded-lg border bg-card p-3 text-sm"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium">
                      {app.display_name || "（未填姓名）"}
                      <span className="ml-2 font-normal text-muted-foreground">
                        {app.email}
                      </span>
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      申请时间：{formatTime(app.created_at)}
                    </p>
                  </div>
                  <StatusBadge tone={statusTone(app.status)}>
                    {APPLICATION_STATUS_TEXT[app.status] ?? app.status}
                  </StatusBadge>
                </div>

                {app.message && (
                  <p className="rounded-md bg-muted/50 p-2 text-xs leading-relaxed">
                    留言：{app.message}
                  </p>
                )}

                {app.status === "rejected" && app.reject_reason && (
                  <p className="text-xs text-muted-foreground">
                    驳回理由：{app.reject_reason}
                  </p>
                )}

                {app.status === "pending" && (
                  <>
                    {rejectingId === app.id ? (
                      <div className="space-y-2">
                        <textarea
                          className="min-h-[64px] w-full rounded-md border bg-background px-2 py-1.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                          placeholder="驳回理由（选填，≤200 字，申请人可见）"
                          maxLength={200}
                          value={rejectReason}
                          onChange={(e) => setRejectReason(e.target.value)}
                        />
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            variant="destructive"
                            disabled={busyId === app.id}
                            onClick={() => void reject(app)}
                          >
                            确认驳回
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busyId === app.id}
                            onClick={() => {
                              setRejectingId(null);
                              setRejectReason("");
                            }}
                          >
                            取消
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          disabled={busyId === app.id}
                          onClick={() => void approve(app)}
                        >
                          <Check className="mr-1 size-3.5" />
                          通过
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busyId === app.id}
                          onClick={() => {
                            setRejectingId(app.id);
                            setRejectReason("");
                          }}
                        >
                          <XCircle className="mr-1 size-3.5" />
                          驳回
                        </Button>
                      </div>
                    )}
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </SectionCard>
  );
}
