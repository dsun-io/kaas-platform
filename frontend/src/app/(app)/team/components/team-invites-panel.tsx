"use client";

/**
 * 邀请成员面板（仅团队管理员可见）。
 *
 * **两个分支必须分清**（docs/FRONTEND_PRODUCTION_READINESS.md §B2，最容易做错的一处）：
 *   · 邮箱**已注册** → `200 {"joined":true}` → 对方**已直接入队**，提示"已直接加入"，
 *     不需要（也不该）再展示邀请链接 —— 那时根本没有邀请码；
 *   · 邮箱**未注册** / 通用码 → `201 {"joined":false,"token":"…"}` → 展示**可复制**的邀请链接。
 * 判分支只看响应体里的 `joined`，不看状态码：状态码是"有没有创建邀请资源"，
 * 而用户关心的是"人进来了没有"。
 */
import { useState } from "react";
import { toast } from "sonner";
import {
  AlertCircle,
  Copy,
  Mail,
  RefreshCw,
  Send,
  XCircle,
} from "lucide-react";

import apiClient from "@/lib/api/client";
import { teamErrorMessage } from "@/lib/team/team-errors";
import {
  buildInviteLink,
  inviteStateLabel,
  isInviteActionable,
} from "@/lib/team/invites";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge } from "@/components/shared/status-badge";
import { EmptyState } from "@/components/shared/empty-state";

import { useTeamInvites, type TeamInviteRow } from "../hooks/use-team-admin";

interface TeamInvitesPanelProps {
  teamId: number;
}

function formatTime(value: string | null): string {
  if (!value) return "—";
  const ts = Date.parse(value);
  if (Number.isNaN(ts)) return value;
  return new Date(ts).toLocaleString("zh-CN", { hour12: false });
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success("邀请链接已复制，发给同事即可");
  } catch {
    // 剪贴板可能被浏览器策略禁用（非 https / 未授权）→ 提示手动复制，别假装成功
    toast.error("复制失败，请手动选中链接复制");
  }
}

interface InviteResponseBody {
  joined?: unknown;
  token?: unknown;
}

function readInviteBody(data: unknown): InviteResponseBody {
  return typeof data === "object" && data !== null
    ? (data as InviteResponseBody)
    : {};
}

export function TeamInvitesPanel({ teamId }: TeamInvitesPanelProps) {
  const { items, loading, error, reload } = useTeamInvites(teamId, true);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [lastLink, setLastLink] = useState<string | null>(null);
  const [formError, setFormError] = useState("");

  async function createInvite() {
    const target = email.trim();
    setBusy(true);
    setFormError("");
    try {
      const { data } = await apiClient.post<unknown>(
        `/teams/${teamId}/invites`,
        { email: target },
        { silent: true },
      );
      const body = readInviteBody(data);

      if (body.joined === true) {
        toast.success(
          target ? `${target} 已直接加入团队` : "对方已直接加入团队",
        );
        setLastLink(null);
      } else {
        const token = typeof body.token === "string" ? body.token : "";
        if (token === "") {
          setFormError("邀请已创建，但响应里没有邀请码，请刷新邀请列表查看");
        } else {
          setLastLink(buildInviteLink(token));
          toast.success("邀请码已生成，把下面的链接发给同事即可");
        }
      }
      setEmail("");
      reload();
    } catch (err: unknown) {
      setFormError(teamErrorMessage(err, "邀请失败，请稍后重试"));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(invite: TeamInviteRow) {
    try {
      await apiClient.delete(`/teams/${teamId}/invites/${invite.id}`, {
        silent: true,
      });
      toast.success("邀请已撤销");
      reload();
    } catch (err: unknown) {
      toast.error(teamErrorMessage(err, "撤销失败，请稍后重试"));
    }
  }

  return (
    <SectionCard
      title="邀请成员"
      description="填邮箱：对方已注册则直接加入；没注册就生成一条邀请链接（谁拿到谁能用）。邮箱留空 = 通用邀请码。"
      action={
        <Button size="sm" variant="ghost" onClick={reload}>
          <RefreshCw className="mr-1 size-3.5" />
          刷新
        </Button>
      }
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-[220px] flex-1 space-y-1.5">
            <Label htmlFor="invite-email">
              同事邮箱（可留空生成通用邀请码）
            </Label>
            <Input
              id="invite-email"
              placeholder="colleague@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={busy}
            />
          </div>
          <Button disabled={busy} onClick={() => void createInvite()}>
            <Send className="mr-1 size-4" />
            邀请
          </Button>
        </div>

        {formError && <p className="text-sm text-destructive">{formError}</p>}

        {lastLink && (
          <div className="space-y-1.5 rounded-lg border bg-muted/40 p-3">
            <p className="text-xs text-muted-foreground">
              对方未注册，把这条链接发给他（打开后自动进入注册页并带上邀请码）：
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate rounded bg-background px-2 py-1 text-xs">
                {lastLink}
              </code>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void copyText(lastLink)}
              >
                <Copy className="mr-1 size-3.5" />
                复制链接
              </Button>
            </div>
          </div>
        )}

        {loading ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            加载中…
          </p>
        ) : error ? (
          <div className="flex flex-col items-start gap-2 py-2 text-sm">
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
            icon={Mail}
            title="还没有邀请"
            description="上面填邮箱邀请同事，或留空生成一条通用邀请码。"
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="p-2">邀请对象</th>
                  <th className="p-2">状态</th>
                  <th className="p-2">到期时间</th>
                  <th className="p-2">操作</th>
                </tr>
              </thead>
              <tbody>
                {items.map((invite) => {
                  const actionable = isInviteActionable(
                    invite.status,
                    invite.expires_at,
                  );
                  return (
                    <tr
                      key={invite.id}
                      className="border-b last:border-0 hover:bg-muted/40"
                    >
                      <td className="p-2">
                        {invite.email ?? (
                          <span className="text-muted-foreground">
                            通用邀请码
                          </span>
                        )}
                      </td>
                      <td className="p-2">
                        <StatusBadge
                          tone={
                            invite.status === "accepted"
                              ? "success"
                              : inviteStateLabel(
                                    invite.status,
                                    invite.expires_at,
                                  ) === "已过期"
                                ? "warning"
                                : invite.status === "revoked"
                                  ? "danger"
                                  : "info"
                          }
                        >
                          {inviteStateLabel(invite.status, invite.expires_at)}
                        </StatusBadge>
                      </td>
                      <td className="p-2 text-muted-foreground">
                        {formatTime(invite.expires_at)}
                      </td>
                      <td className="p-2">
                        <div className="flex flex-wrap gap-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={!actionable}
                            onClick={() =>
                              void copyText(buildInviteLink(invite.token))
                            }
                          >
                            <Copy className="mr-1 size-3.5" />
                            复制链接
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={!actionable}
                            onClick={() => void revoke(invite)}
                          >
                            <XCircle className="mr-1 size-3.5" />
                            撤销
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
      </div>
    </SectionCard>
  );
}
