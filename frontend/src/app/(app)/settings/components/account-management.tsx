"use client";

import { useState } from "react";
import { toast } from "sonner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { apiErrorCode } from "@/lib/api/api-error";
import type { AxiosError } from "axios";
import {
  useAccounts,
  useUpdateAccountStatus,
  type AdminAccount,
} from "../hooks/use-accounts";

/**
 * 平台账号管理（仅 system_admin 可见；入口由 settings/page.tsx 按 useRole 控制）。
 *
 * 口径（交接文档 §④，用户已确认）：
 * - 只有「停用 / 恢复」，**没有删除**；
 * - 停用前二次确认：无法登录 / 可随时恢复 / 不删历史数据；
 * - 409 SELF_PROTECT / LAST_ADMIN 给明确文案；403 给无权限。
 */

const ROLE_LABELS: Record<string, string> = {
  system_admin: "系统管理员",
  customer_owner: "团队负责人",
  customer_member: "团队成员",
};

function roleLabel(role: string) {
  return ROLE_LABELS[role] ?? role;
}

function accountTypeLabel(accountType: string) {
  return accountType === "internal" ? "内部" : "客户";
}

function formatDate(iso: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("zh-CN");
}

/** 把后端 409 业务码翻译成用户看得懂的理由；其余错误返回 null（走通用提示）。 */
function conflictMessage(error: unknown): string | null {
  const code = apiErrorCode(error);
  if (code === "SELF_PROTECT")
    return "不能停用当前登录的账号（请先让其他管理员操作）";
  if (code === "LAST_ADMIN") return "平台至少保留一名系统管理员，无法停用";
  return null;
}

export function AccountManagement() {
  const { data, isLoading, error } = useAccounts();
  const updateStatus = useUpdateAccountStatus();
  const [pendingDisable, setPendingDisable] = useState<AdminAccount | null>(
    null,
  );

  const handleRestore = (account: AdminAccount) => {
    updateStatus.mutate(
      { userId: account.id, status: "active" },
      {
        onSuccess: () => toast.success(`已恢复 ${account.email} 的登录`),
        onError: (e) => {
          const msg = conflictMessage(e);
          toast.error(
            msg ??
              ((e as AxiosError)?.response?.status === 403
                ? "无权限执行此操作"
                : "恢复失败，请稍后重试"),
          );
        },
      },
    );
  };

  const confirmDisable = () => {
    if (!pendingDisable) return;
    const account = pendingDisable;
    setPendingDisable(null);
    updateStatus.mutate(
      { userId: account.id, status: "disabled" },
      {
        onSuccess: () => toast.success(`已停用 ${account.email}`),
        onError: (e) => {
          const msg = conflictMessage(e);
          toast.error(
            msg ??
              ((e as AxiosError)?.response?.status === 403
                ? "无权限执行此操作"
                : "停用失败，请稍后重试"),
          );
        },
      },
    );
  };

  if (isLoading) {
    return (
      <div className="space-y-2" aria-busy="true">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full rounded-md" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="py-8 text-center text-sm text-muted-foreground">
        账号列表加载失败，请稍后重试
      </div>
    );
  }

  const accounts = data?.accounts ?? [];

  return (
    <>
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>邮箱</TableHead>
              <TableHead>显示名</TableHead>
              <TableHead>账号类型</TableHead>
              <TableHead>角色</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>团队</TableHead>
              <TableHead>创建时间</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {accounts.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={8}
                  className="py-8 text-center text-sm text-muted-foreground"
                >
                  暂无账号
                </TableCell>
              </TableRow>
            ) : (
              accounts.map((a) => (
                <TableRow key={a.id}>
                  <TableCell className="font-medium">{a.email}</TableCell>
                  <TableCell>{a.display_name ?? "—"}</TableCell>
                  <TableCell className="text-xs">
                    {accountTypeLabel(a.account_type)}
                  </TableCell>
                  <TableCell className="text-xs">{roleLabel(a.role)}</TableCell>
                  <TableCell>
                    <Badge
                      variant={a.status === "active" ? "default" : "secondary"}
                    >
                      {a.status === "active" ? "正常" : "已停用"}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs">
                    {a.team_name ?? "—"}
                  </TableCell>
                  <TableCell className="text-xs">
                    {formatDate(a.created_at)}
                  </TableCell>
                  <TableCell className="text-right">
                    {a.status === "active" ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setPendingDisable(a)}
                      >
                        停用
                      </Button>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleRestore(a)}
                      >
                        恢复
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
      {typeof data?.total === "number" && accounts.length < data.total ? (
        <p className="mt-2 text-xs text-muted-foreground">
          共 {data.total} 个账号，当前显示前 {accounts.length} 个
        </p>
      ) : null}

      <Dialog
        open={pendingDisable !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDisable(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>停用账号 {pendingDisable?.email}？</DialogTitle>
            <DialogDescription>
              该账号将无法登录；可随时恢复；不会删除历史数据。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingDisable(null)}>
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={confirmDisable}
              disabled={updateStatus.isPending}
            >
              {updateStatus.isPending ? "停用中…" : "确认停用"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
