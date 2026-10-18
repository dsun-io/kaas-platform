"use client";

/**
 * 编号修改确认弹窗（询盘号 / 报价单号 / 单证号共用）。
 *
 * 用户口径（2026-10-18）：
 *  - 编号默认由系统自动生成并在生成时带出；
 *  - 下游单据/报价生成之前可以手动改，但**必须二次确认**；
 *  - 下游已生成后编号锁定（后端返回 409，弹窗不关闭并展示原因）。
 */
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function NumberEditDialog({
  open,
  onOpenChange,
  title,
  label,
  currentValue,
  description,
  warning = "修改后请确认：一旦生成了后续单证/报价，本编号将自动锁定，不能再改。",
  onConfirm,
  pending = false,
  error = null,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  label: string;
  currentValue: string;
  description?: string;
  warning?: string;
  onConfirm: (value: string) => void;
  pending?: boolean;
  error?: string | null;
}) {
  const [value, setValue] = useState(currentValue);

  useEffect(() => {
    if (open) setValue(currentValue);
  }, [open, currentValue]);

  const trimmed = value.trim();
  const canSubmit = trimmed.length > 0 && trimmed !== currentValue && !pending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {description ?? "编号由系统自动生成；如需调整请在这里修改。"}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <Label htmlFor="number-edit-input">{label}</Label>
          <Input
            id="number-edit-input"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoFocus
            disabled={pending}
            className="font-mono"
          />
          <p className="text-xs text-amber-700">{warning}</p>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            取消
          </Button>
          <Button
            type="button"
            onClick={() => onConfirm(trimmed)}
            disabled={!canSubmit}
          >
            {pending ? "保存中…" : "确认修改"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
