"use client";

/**
 * 税档「停用（软删）」按钮 + 二次确认（C36 #1）。
 *
 * 契约（`backend/worker/src/tax_archives.py:295` `delete_tax_archive`）：
 * - `DELETE /api/v1/tax-archives/{id}` → `{id, status:"inactive"}`（**软删**，行仍留档可审计）；
 * - 403 `TEAM_ADMIN_REQUIRED`：不能停用其它团队的档案；404：档案不存在。
 *
 * 为什么单独做成按钮：删除是不可逆动作，必须二次确认并**把后端拒绝原因原样展示**
 * （团队管理员限制 / 已不属于本团队等），不能只弹一句"操作失败"。
 */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { PowerOff } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import apiClient from "@/lib/api/client";
import { normalizeApiError } from "@/lib/api/api-error";
import type { TaxArchive } from "@contracts/export-quote";

export const TAX_ARCHIVES_KEY = ["tax-archives"];

export function TaxArchiveDeactivateButton({
  archive,
  disabled = false,
}: {
  archive: TaxArchive;
  disabled?: boolean;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const deactivate = useMutation({
    mutationFn: async () => {
      const { data } = await apiClient.delete<{ id: number; status: string }>(
        `/tax-archives/${archive.id}`,
        { silent: true },
      );
      return data;
    },
    onSuccess: () => {
      toast.success("税务档案已停用（软删，仍留档可审计）");
      setOpen(false);
      setError(null);
      void qc.invalidateQueries({ queryKey: TAX_ARCHIVES_KEY });
    },
    onError: (err) => {
      // 403/404/网络错误都要让用户看到"为什么没停用"
      setError(normalizeApiError(err).message);
    },
  });

  const submit = () => {
    setError(null);
    deactivate.mutate();
  };

  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        disabled={disabled || deactivate.isPending}
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
      >
        <PowerOff className="mr-1 h-3 w-3" /> 停用
      </Button>

      <ConfirmDialog
        open={open}
        onOpenChange={(next) => {
          if (!deactivate.isPending) {
            setOpen(next);
            if (!next) setError(null);
          }
        }}
        title={`停用税档「${archive.name}」？`}
        description="停用后该税档不再参与报价选档，但记录会保留（软删，可审计）。报价页会自动选中启用中的最新一份。"
        confirmLabel="确认停用"
        pending={deactivate.isPending}
        error={error}
        onConfirm={submit}
      />
    </>
  );
}
