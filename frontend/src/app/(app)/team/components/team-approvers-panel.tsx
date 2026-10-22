"use client";

/**
 * 团队页「审批设置」面板（设计 §6.2 / §9.5，D-11/D-14；仅团队管理员可编辑）。
 *
 * 规则：从团队成员里多选「指定审批人」；**空名单 = 团队管理员审批**（合法状态，
 * 不是"没配"的错误）。保存是整表替换（内核 PUT 语义），失败把后端中文原因
 * 原样显示（例如把非本团队成员设成审批人 → 422 APPROVER_NOT_IN_TEAM）。
 *
 * 仅团队管理员可编辑：本面板只挂在团队管理（管理员分支）里；普通成员在
 * 团队页看到的是只读说明。真正裁决在内核（非管理员 PUT → 403 NOT_TEAM_ADMIN）。
 */
import { useState } from "react";
import { AlertCircle, CheckCheck, RefreshCw, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

import { EmptyState } from "@/components/shared/empty-state";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge } from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  approverFallbackText,
  isApproverSelectionDirty,
  toggleApproverId,
  validateApproverSelection,
} from "@/lib/approvals/approvers";
import { teamErrorMessage } from "@/lib/team/team-errors";

import { useTeamMembers } from "../hooks/use-team-admin";
import {
  useSaveTeamApprovers,
  useTeamApprovers,
} from "../hooks/use-team-approvers";

export function TeamApproversPanel({ teamId }: { teamId: number }) {
  const members = useTeamMembers(teamId, true);
  const approvers = useTeamApprovers(true);
  const save = useSaveTeamApprovers();

  // null = 还没动过（展示已保存名单）；非 null = 用户当前勾选（含空数组）
  const [selected, setSelected] = useState<number[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const savedIds = approvers.data?.ids ?? [];
  const checked = selected ?? savedIds;
  const dirty = isApproverSelectionDirty(checked, savedIds);
  const memberIds = members.items.map((member) => member.user_id);
  const selectedApprovers = checked
    .map((id) => members.items.find((member) => member.user_id === id))
    .filter((member): member is NonNullable<typeof member> => Boolean(member));

  const toggle = (userId: number) => {
    setError(null);
    setSelected(toggleApproverId(checked, userId));
  };

  const submit = async () => {
    setError(null);
    const validation = validateApproverSelection(checked, memberIds);
    if (validation) {
      setError(validation);
      return;
    }
    try {
      await save.mutateAsync(checked);
      toast.success(
        checked.length === 0
          ? "已清空指定审批人：后续申请由团队管理员审批"
          : `已保存 ${checked.length} 名指定审批人`,
      );
      setSelected(null); // 用保存响应回填的缓存重新展示
    } catch (err: unknown) {
      setError(teamErrorMessage(err, "保存失败，请稍后重试"));
    }
  };

  const loading = members.loading || approvers.isLoading;
  const loadError =
    members.error ??
    (approvers.isError
      ? teamErrorMessage(approvers.error, "审批设置读取失败（可稍后重试）")
      : null);

  return (
    <SectionCard
      title="审批设置"
      description="指定审批人：已确认订单的货物明细变更由谁审批。空名单 = 团队管理员审批。"
      action={
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            approvers.refetch();
            members.reload();
          }}
          disabled={loading}
        >
          <RefreshCw className="mr-1 size-4" />
          刷新
        </Button>
      }
    >
      {loading ? (
        <div className="space-y-2" aria-busy="true" aria-label="审批设置加载中">
          <Skeleton className="h-6 w-64" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : loadError ? (
        <p
          role="alert"
          className="flex items-center gap-2 text-sm text-destructive"
        >
          <AlertCircle className="size-4 shrink-0" />
          {loadError}
        </p>
      ) : (
        <div className="space-y-4">
          <div className="rounded-lg border bg-muted/30 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
            {approverFallbackText(approvers.data?.fallback)}
            路由规则：有指定审批人时审批权与通知都归他们；管理员仍可兜底介入；
            申请人不能自批（单人团队由内核放行并标注「自批」）。
          </div>

          {members.items.length === 0 ? (
            <EmptyState
              icon={AlertCircle}
              title="还没有可指定的团队成员"
              description="先邀请同事加入团队，再把他们设为指定审批人。"
            />
          ) : (
            <>
              <div>
                <p className="mb-2 text-sm font-medium">当前指定审批人</p>
                {checked.length === 0 ? (
                  <StatusBadge tone="info">未指定：团队管理员审批</StatusBadge>
                ) : (
                  <ul className="flex flex-wrap gap-1.5">
                    {selectedApprovers.map((member) => (
                      <li key={member.user_id}>
                        <StatusBadge tone="purple">
                          <ShieldCheck className="mr-1 size-3" />
                          {member.display_name ||
                            member.email ||
                            `用户 #${member.user_id}`}
                        </StatusBadge>
                      </li>
                    ))}
                    {selectedApprovers.length < checked.length ? (
                      <li className="text-xs text-muted-foreground">
                        （另有 {checked.length - selectedApprovers.length}{" "}
                        人不在当前成员列表）
                      </li>
                    ) : null}
                  </ul>
                )}
              </div>

              <fieldset>
                <legend className="mb-2 text-sm font-medium">
                  从团队成员中选择（可多选）
                </legend>
                <ul className="grid gap-2 sm:grid-cols-2">
                  {members.items.map((member) => {
                    const id = member.user_id;
                    const name =
                      member.display_name || member.email || `用户 #${id}`;
                    return (
                      <li key={id}>
                        <label className="flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 text-sm transition-colors hover:bg-muted/50">
                          <input
                            type="checkbox"
                            className="mt-0.5 size-4"
                            checked={checked.includes(id)}
                            onChange={() => toggle(id)}
                            aria-label={`把 ${name} 设为指定审批人`}
                          />
                          <span className="min-w-0">
                            <span className="block font-medium">{name}</span>
                            <span className="block text-xs text-muted-foreground">
                              {member.email || "—"}
                              {member.is_admin ? " · 管理员" : " · 成员"}
                            </span>
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </fieldset>

              {error ? (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              ) : null}

              <div className="flex flex-wrap items-center justify-end gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!dirty || save.isPending}
                  onClick={() => {
                    setSelected(savedIds);
                    setError(null);
                  }}
                >
                  撤销修改
                </Button>
                <Button
                  size="sm"
                  disabled={!dirty || save.isPending}
                  onClick={() => void submit()}
                >
                  <CheckCheck className="mr-1 size-4" />
                  {save.isPending ? "保存中…" : "保存审批设置"}
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </SectionCard>
  );
}
