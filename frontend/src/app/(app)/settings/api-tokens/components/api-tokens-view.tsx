"use client";

/**
 * 设置 → API 令牌（W5 M1）。
 *
 * 数据源：`/api-tokens`（JWT 会话；只列出当前账号创建的令牌）。
 * 交互口径：
 * - 列表显示名称 / 前缀 / 作用域 / 创建时间 / 最后使用 / 状态；
 * - 创建走 `CreateTokenDialog`，明文只显示一次且必须手动关闭；
 * - 撤销走二次确认（`ConfirmDialog`），409 TOKEN_ALREADY_REVOKED 如实展示；
 * - 加载 / 空态 / 错误态都有明确说明与下一步动作。
 */
import { useState } from "react";
import {
  AlertCircle,
  KeyRound,
  Plus,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { EmptyState } from "@/components/shared/empty-state";
import { LoadingBlock } from "@/components/shared/loading-block";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge, type StatusTone } from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { scopeLabel, summarizeScopes } from "@/lib/api-tokens/scopes";
import { formatApiTokenError } from "@/lib/api-tokens/token-errors";
import {
  useApiTokens,
  useRevokeApiToken,
  type ApiToken,
} from "@/lib/api-tokens/use-api-tokens";

import { CreateTokenDialog } from "./create-token-dialog";

type ApiTokenStatus = "active" | "revoked" | "expired";

const STATUS_META: Record<ApiTokenStatus, { label: string; tone: StatusTone }> =
  {
    active: { label: "有效", tone: "success" },
    revoked: { label: "已撤销", tone: "danger" },
    expired: { label: "已过期", tone: "warning" },
  };

function tokenStatus(token: ApiToken, now = Date.now()): ApiTokenStatus {
  if (token.revoked_at) return "revoked";
  if (token.expires_at) {
    const expiresAt = Date.parse(token.expires_at);
    if (!Number.isNaN(expiresAt) && expiresAt <= now) return "expired";
  }
  return "active";
}

/** ISO 时间 → 本地可读时间；坏值原样显示（不吞掉后端给的线索）。 */
function formatDateTime(value: string | null): string {
  if (!value) return "—";
  const ts = Date.parse(value);
  if (Number.isNaN(ts)) return value;
  return new Date(ts).toLocaleString("zh-CN", { hour12: false });
}

export function ApiTokensView() {
  const list = useApiTokens();
  const revoke = useRevokeApiToken();

  const [createOpen, setCreateOpen] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<ApiToken | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  const items = list.data?.items ?? [];
  const total = list.data?.total ?? items.length;

  async function handleRevoke() {
    if (!revokeTarget) return;
    setRevokeError(null);
    try {
      await revoke.mutateAsync(revokeTarget.id);
      toast.success(`已撤销密钥「${revokeTarget.name}」`);
      setRevokeTarget(null);
    } catch (error) {
      setRevokeError(formatApiTokenError(error));
    }
  }

  return (
    <div className="space-y-6">
      <SectionCard
        title="我的系统对接密钥"
        description="用于外部系统或自动化工具对接；只显示你本人创建的密钥。"
        action={
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">共 {total} 个</span>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => void list.refetch()}
              disabled={list.isFetching}
            >
              <RefreshCw className="size-3.5" />
              刷新
            </Button>
            <Button type="button" size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="size-3.5" />
              创建密钥
            </Button>
          </div>
        }
        bodyClassName="p-0"
      >
        {list.isPending ? (
          <div className="p-5">
            <LoadingBlock rows={5} />
          </div>
        ) : list.isError ? (
          <div className="flex flex-col items-start gap-2 p-5 text-sm">
            <div className="flex items-center gap-2 text-destructive">
              <AlertCircle className="size-4" />
              {formatApiTokenError(list.error)}
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void list.refetch()}
              disabled={list.isFetching}
            >
              重试
            </Button>
          </div>
        ) : items.length === 0 ? (
          <div className="p-5">
            <EmptyState
              icon={KeyRound}
              title="还没有系统对接密钥"
              description="创建一个密钥，让外部系统或自动化工具对接平台业务数据。完整密钥只在创建成功后显示一次。"
              action={
                <Button type="button" onClick={() => setCreateOpen(true)}>
                  <Plus className="size-4" />
                  创建第一个密钥
                </Button>
              }
            />
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>名称</TableHead>
                <TableHead>密钥标识</TableHead>
                <TableHead>权限范围</TableHead>
                <TableHead>创建时间</TableHead>
                <TableHead>最后使用</TableHead>
                <TableHead>状态</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((token) => {
                const status = tokenStatus(token);
                const meta = STATUS_META[status];
                return (
                  <TableRow key={token.id}>
                    <TableCell>
                      <p className="font-medium text-foreground">
                        {token.name}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        #{token.id}
                      </p>
                    </TableCell>
                    <TableCell>
                      <code className="font-mono text-xs text-muted-foreground">
                        {token.prefix ? `${token.prefix}…` : "—"}
                      </code>
                    </TableCell>
                    <TableCell>
                      <span
                        className="block max-w-[22rem] truncate text-xs"
                        title={
                          token.scopes.length > 0
                            ? token.scopes
                                .map(
                                  (scope) => `${scopeLabel(scope)}（${scope}）`,
                                )
                                .join("、")
                            : "未选择权限范围"
                        }
                      >
                        {summarizeScopes(token.scopes)}
                      </span>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatDateTime(token.created_at)}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {token.last_used_at
                        ? formatDateTime(token.last_used_at)
                        : "从未使用"}
                    </TableCell>
                    <TableCell>
                      <StatusBadge tone={meta.tone}>{meta.label}</StatusBadge>
                    </TableCell>
                    <TableCell className="text-right">
                      {status === "revoked" ? (
                        <span className="text-xs text-muted-foreground">—</span>
                      ) : (
                        <Button
                          type="button"
                          size="sm"
                          variant="destructive"
                          aria-label={`撤销密钥 ${token.name}`}
                          onClick={() => {
                            setRevokeError(null);
                            setRevokeTarget(token);
                          }}
                        >
                          撤销
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </SectionCard>

      <div className="flex items-start gap-2 rounded-lg border bg-muted/40 px-4 py-3 text-xs text-muted-foreground">
        <ShieldCheck className="mt-0.5 size-4 shrink-0" />
        <p>
          完整密钥只在创建成功后显示一次，平台不保存密钥内容；请勿写入代码或聊天记录。
          怀疑泄露时立即撤销并重新创建。
        </p>
      </div>

      {/* 关闭即卸载：下次打开是全新的表单/明文 state，不会残留上一次的令牌。 */}
      {createOpen ? (
        <CreateTokenDialog open onOpenChange={setCreateOpen} />
      ) : null}

      <ConfirmDialog
        open={revokeTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRevokeTarget(null);
            setRevokeError(null);
          }
        }}
        title="撤销系统对接密钥"
        description={`撤销后使用「${revokeTarget?.name ?? ""}」的外部系统或自动化工具将无法再连接平台，且无法恢复。确定撤销吗？`}
        confirmLabel="确认撤销"
        pending={revoke.isPending}
        error={revokeError}
        onConfirm={() => void handleRevoke()}
      />
    </div>
  );
}
