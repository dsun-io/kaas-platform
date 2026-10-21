"use client";

/**
 * 团队成员面板（仅团队管理员可见）。
 *
 * 两个易错点：
 *   ① `is_admin` 是"对这个团队而言的管理权"（= 团队创建者），不是全局角色 ——
 *      团队管理员**不能被移除自己**（后端 409 CANNOT_REMOVE_SELF），所以这里直接禁用；
 *   ② `console_access` 是**官网数据后台**权限（按成员授予/收回），不是工位订阅，
 *      别和下面的工位开通混在一起（一个是"能不能看官网数据"，一个是"能不能用工位"）。
 */
import { useState } from "react";
import { toast } from "sonner";
import { AlertCircle, Crown, RefreshCw, UserMinus, Users } from "lucide-react";

import apiClient from "@/lib/api/client";
import { teamErrorMessage } from "@/lib/team/team-errors";
import { StatusBadge } from "@/components/shared/status-badge";
import { EmptyState } from "@/components/shared/empty-state";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { SectionCard } from "@/components/shared/section-card";

import { useTeamMembers, type TeamMember } from "../hooks/use-team-admin";

interface TeamMembersPanelProps {
  teamId: number;
  /** 登录用户 id：用来标出"我"，避免管理员误删自己 */
  currentUserId: number | null;
}

function memberLabel(member: TeamMember): string {
  return member.display_name || member.email || `#${member.user_id}`;
}

export function TeamMembersPanel({
  teamId,
  currentUserId,
}: TeamMembersPanelProps) {
  const { items, loading, error, reload } = useTeamMembers(teamId, true);
  const [pendingId, setPendingId] = useState<number | null>(null);

  async function setConsoleAccess(member: TeamMember, allowed: boolean) {
    setPendingId(member.user_id);
    try {
      await apiClient.put(
        `/teams/${teamId}/members/${member.user_id}/console-access`,
        { allowed },
        { silent: true },
      );
      toast.success(
        allowed
          ? `已授予 ${memberLabel(member)} 官网数据后台权限`
          : `已收回 ${memberLabel(member)} 的官网数据后台权限`,
      );
      reload();
    } catch (err: unknown) {
      toast.error(teamErrorMessage(err, "设置失败，请稍后重试"));
    } finally {
      setPendingId(null);
    }
  }

  async function removeMember(member: TeamMember) {
    const label = memberLabel(member);
    if (
      typeof window !== "undefined" &&
      !window.confirm(
        `确定把「${label}」移出团队？移除后需要重新凭邀请码加入。`,
      )
    ) {
      return;
    }
    setPendingId(member.user_id);
    try {
      await apiClient.delete(`/teams/${teamId}/members/${member.user_id}`, {
        silent: true,
      });
      toast.success(`已移除「${label}」`);
      reload();
    } catch (err: unknown) {
      toast.error(teamErrorMessage(err, "移除成员失败，请稍后重试"));
    } finally {
      setPendingId(null);
    }
  }

  /**
   * 转让团队管理权。
   *
   * 用户 2026-10-11 裁决：**现任团队管理员也能自己转**（不必再找平台管理员）。
   * 后端两侧都已实现（`POST /teams/{id}/transfer`），授权复用
   * `is_team_admin`（团队创建者或平台管理员）—— 本面板本就"仅团队管理员可见"，
   * 所以这里不再重复判权限。
   *
   * 转让 = 改 `teams.created_by`；**前任留在团队里当普通成员**。
   * 这是**不可逆的自我降权**（自己不再是管理员），所以必须显式确认，
   * 且确认文案要把后果说清楚 —— 不能只问"确定吗"。
   */
  async function transferAdmin(member: TeamMember) {
    const label = memberLabel(member);
    if (
      typeof window !== "undefined" &&
      !window.confirm(
        `把团队管理权转让给「${label}」？\n\n` +
          "转让后你将成为普通成员，不再能管理团队（成员/工位/邀请码）。\n" +
          "要收回只能让对方再转回给你。",
      )
    ) {
      return;
    }
    setPendingId(member.user_id);
    try {
      await apiClient.post(
        `/teams/${teamId}/transfer`,
        { user_id: member.user_id },
        { silent: true },
      );
      toast.success(`已把团队管理权转让给「${label}」`);
      reload();
    } catch (err: unknown) {
      toast.error(teamErrorMessage(err, "转让失败，请稍后重试"));
    } finally {
      setPendingId(null);
    }
  }

  return (
    <SectionCard
      title="团队成员"
      description="成员录入的客户/报价/单证在本团队内互相可见；官网数据后台权限按成员单独授予。"
      action={
        <div className="flex items-center gap-2">
          <StatusBadge tone="default">{items.length} 人</StatusBadge>
          <Button size="sm" variant="ghost" onClick={reload}>
            <RefreshCw className="mr-1 size-3.5" />
            刷新
          </Button>
        </div>
      }
    >
      {loading ? (
        <div className="space-y-2" aria-busy="true">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full rounded-lg" />
          ))}
        </div>
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
          title="还没有其他成员"
          description="在下面的「邀请成员」里填同事邮箱，或生成一条通用邀请码发给他。"
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th scope="col" className="p-2">
                  成员
                </th>
                <th scope="col" className="p-2">
                  角色
                </th>
                <th scope="col" className="p-2">
                  官网数据后台
                </th>
                <th scope="col" className="p-2">
                  操作
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((member) => {
                const isSelf = currentUserId === member.user_id;
                const busy = pendingId === member.user_id;
                return (
                  <tr
                    key={member.user_id}
                    className="border-b last:border-0 hover:bg-muted/40"
                  >
                    <td className="p-2">
                      <div className="font-medium">
                        {memberLabel(member)}
                        {isSelf && (
                          <span className="ml-1 text-xs text-muted-foreground">
                            （我）
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {member.email}
                      </div>
                    </td>
                    <td className="p-2">
                      {member.is_admin ? (
                        <StatusBadge tone="purple">团队管理员</StatusBadge>
                      ) : (
                        <StatusBadge tone="default">成员</StatusBadge>
                      )}
                    </td>
                    <td className="p-2">
                      <label className="flex cursor-pointer items-center gap-1.5 text-xs">
                        <input
                          type="checkbox"
                          checked={member.console_access}
                          disabled={busy}
                          onChange={(e) =>
                            void setConsoleAccess(member, e.target.checked)
                          }
                        />
                        {member.console_access ? "已允许" : "未允许"}
                      </label>
                    </td>
                    <td className="p-2">
                      <div className="flex items-center gap-1">
                        {/* 转让：只对**非管理员成员**显示 —— 转给现任管理员自己没意义 */}
                        {!member.is_admin && (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy}
                            title={`把团队管理权转让给 ${memberLabel(member)}（转让后你成为普通成员）`}
                            onClick={() => void transferAdmin(member)}
                          >
                            <Crown className="mr-1 size-3.5" />
                            转让
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy || member.is_admin}
                          title={
                            member.is_admin
                              ? "不能移除团队管理员本人（可先把管理权转让给其他成员）"
                              : undefined
                          }
                          onClick={() => void removeMember(member)}
                        >
                          <UserMinus className="mr-1 size-3.5" />
                          移除
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
}
