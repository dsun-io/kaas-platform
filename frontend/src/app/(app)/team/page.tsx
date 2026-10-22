"use client";

/**
 * 团队与工位（`/team`）—— 三层组织里"我这个团队"的唯一入口。
 *
 * 为什么放在顶层 `/team` 而不是塞进 `/settings`：
 *   · 团队管理员是**客户账号**，`/settings` 一系列入口是内部账号专属（adminOnly），
 *     放进去等于团队管理员根本看不到自己的团队页；
 *   · `/team` 不属于任何计费工位，后端也不拦（团队/订阅接口在"永不锁死"清单里）——
 *     所以"未开通工位"的用户永远走得到这里自救。
 *
 * 三种视角（docs §全局优化「权限差异」）：
 *   · 无团队   → 创建 / 加入引导；
 *   · 团队管理员 → 成员、邀请、工位开通；
 *   · 普通成员 → 只读（团队信息 + 我的工位 + 找管理员开通的提示）。
 */
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  AlertCircle,
  Pencil,
  RefreshCw,
  ShieldCheck,
  Users,
} from "lucide-react";

import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge } from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/lib/auth/auth-context";
import { useTeam } from "@/lib/team/team-context";
import {
  isWorkstationEnabled,
  subscribableWorkstationOptions,
} from "@/lib/workstation/visibility";

import { TeamCompanyProfileCard } from "./components/team-company-profile-card";
import { TeamInvitesPanel } from "./components/team-invites-panel";
import { TeamRenameDialog } from "./components/team-rename-dialog";
import { TeamMembersPanel } from "./components/team-members-panel";
import { TeamSetup } from "./components/team-setup";
import { TeamSubscriptionsPanel } from "./components/team-subscriptions-panel";

function TeamPageSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}

export default function TeamPage() {
  const searchParams = useSearchParams();
  const tab = searchParams?.get("tab") ?? null;
  const { user } = useAuth();
  const { snapshot, team, teamName, isTeamAdmin, memberCount, refresh } =
    useTeam();
  const currentUserId = user?.user_id ?? null;
  const subscriptionsRef = useRef<HTMLDivElement | null>(null);
  // C36 #12：团队改名（PATCH /teams/{id}，仅团队管理员）
  const [showRename, setShowRename] = useState(false);

  // 从"该工位未开通"引导页跳过来时，直接滚到工位开通区
  useEffect(() => {
    if (tab !== "subscriptions" || !isTeamAdmin || snapshot.loading) return;
    subscriptionsRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  }, [tab, isTeamAdmin, snapshot.loading]);

  if (snapshot.loading) {
    return (
      <div className="space-y-4">
        <PageHeader title="团队与工位" description="正在读取团队与工位信息…" />
        <TeamPageSkeleton />
      </div>
    );
  }

  // ── 没有团队：创建 / 加入引导（没有团队就没有订阅主体，什么工位都用不了）──
  if (!snapshot.hasTeam) {
    return (
      <div className="space-y-4">
        <PageHeader
          title="团队与工位"
          description="工位订阅挂在团队上。先创建团队（你成为管理员）或凭邀请码加入同事的团队，才能使用各工位。"
        />
        {!snapshot.ok && (
          <div className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm text-muted-foreground">
            <AlertCircle className="size-4 shrink-0" />
            工位信息暂不可用（接口异常，可刷新重试），这不影响你创建 /
            加入团队。
          </div>
        )}
        <TeamSetup
          initialMode={tab === "join" ? "join" : "create"}
          onDone={refresh}
        />
      </div>
    );
  }

  const stationOptions = subscribableWorkstationOptions();
  const enabledStations = stationOptions.filter((s) =>
    isWorkstationEnabled(snapshot, s.key),
  );
  const disabledStations = stationOptions.filter(
    (s) => !isWorkstationEnabled(snapshot, s.key),
  );

  return (
    <div className="space-y-4" id="team">
      <PageHeader
        title={teamName ?? "我的团队"}
        description={`${memberCount} 名成员 · ${isTeamAdmin ? "你是团队管理员" : "你是团队成员"}`}
        actions={
          <Button variant="outline" onClick={() => void refresh()}>
            <RefreshCw className="mr-1 size-4" />
            刷新
          </Button>
        }
      />

      {!snapshot.ok && (
        <div className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm text-muted-foreground">
          <AlertCircle className="size-4 shrink-0" />
          工位信息暂不可用（接口异常，可刷新重试）：入口不会被隐藏，但开通状态暂时无法确认。
        </div>
      )}

      <SectionCard
        title="团队信息"
        description="成员录入的客户/询盘/报价/订单/单证，本团队内互相可见；其他团队不可见。"
        action={
          isTeamAdmin && team ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setShowRename(true)}
            >
              <Pencil className="mr-1 size-4" />
              改名
            </Button>
          ) : undefined
        }
      >
        <dl className="grid gap-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-muted-foreground">团队名称</dt>
            <dd className="font-medium">{team?.name ?? teamName ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">成员数</dt>
            <dd className="font-medium">{memberCount}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">我的角色</dt>
            <dd className="pt-0.5">
              {isTeamAdmin ? (
                <StatusBadge tone="purple">
                  <ShieldCheck className="mr-1 size-3" />
                  团队管理员
                </StatusBadge>
              ) : (
                <StatusBadge tone="default">
                  <Users className="mr-1 size-3" />
                  成员
                </StatusBadge>
              )}
            </dd>
          </div>
          {team?.created_by != null && (
            <div>
              <dt className="text-muted-foreground">团队创建者</dt>
              <dd className="font-medium">#{String(team.created_by)}</dd>
            </div>
          )}
        </dl>
      </SectionCard>

      {/* 企业信息（2026-10-22 用户要求）：团队管理员见「维护企业信息」入口，
          成员只读提示。区块本身不读公章列表（成员会被 403）。 */}
      <TeamCompanyProfileCard />

      {showRename && isTeamAdmin && team ? (
        <TeamRenameDialog
          open
          onOpenChange={(next) => {
            if (!next) setShowRename(false);
          }}
          teamId={team.id}
          currentName={team.name ?? teamName ?? ""}
          onRenamed={() => void refresh()}
        />
      ) : null}

      <SectionCard
        title="我的工位"
        description="团队开通的工位全员可用；未开通的工位接口会返回 404，入口也不会出现在侧边栏。"
      >
        <div className="space-y-3">
          <div className="flex flex-wrap gap-1.5">
            {enabledStations.length === 0 ? (
              <span className="text-sm text-muted-foreground">
                还没有开通任何工位。
              </span>
            ) : (
              enabledStations.map((station) => (
                <StatusBadge key={station.key} tone="success">
                  {station.name}
                </StatusBadge>
              ))
            )}
          </div>
          {disabledStations.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs text-muted-foreground">未开通：</p>
              <div className="flex flex-wrap gap-1.5">
                {disabledStations.map((station) => (
                  <StatusBadge key={station.key} tone="default">
                    {station.name}
                  </StatusBadge>
                ))}
              </div>
            </div>
          )}
          {!isTeamAdmin && disabledStations.length > 0 && (
            <p className="text-xs text-muted-foreground">
              需要用到未开通的工位？把工位名发给团队管理员，在「工位开通」里启用即可。
            </p>
          )}
        </div>
      </SectionCard>

      {isTeamAdmin && team ? (
        <>
          <div
            ref={subscriptionsRef}
            id="subscriptions"
            className="scroll-mt-20"
          >
            <TeamSubscriptionsPanel teamId={team.id} />
          </div>
          <TeamMembersPanel teamId={team.id} currentUserId={currentUserId} />
          <TeamInvitesPanel teamId={team.id} />
        </>
      ) : (
        <SectionCard
          title="团队管理"
          description="成员列表、邀请、工位开通只有团队管理员可以操作。"
        >
          <p className="text-sm text-muted-foreground">
            你不是团队管理员。需要邀请同事或开通工位时，请联系团队创建者（管理员）操作。
          </p>
        </SectionCard>
      )}
    </div>
  );
}
