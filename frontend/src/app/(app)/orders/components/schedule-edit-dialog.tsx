"use client";

/**
 * 收款计划「修改」弹窗（C36 下期 #10）：改金额 / 到期日 / 备注。
 *
 * 契约：`PATCH /payment-schedules/{id}` 只改这三项时走非 paid 分支（金额也被接受）；
 * 状态变更（标记收款）走 `MarkPaidDialog`，因为后端在 paid 分支里要算汇兑损益。
 */
import { useState } from "react";

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
import type { PaymentSchedule } from "@/lib/orders/payment-schedules";

export interface ScheduleEditValues {
  amount: number;
  due_date: string | null;
  notes: string | null;
}

export function ScheduleEditDialog({
  open,
  onOpenChange,
  schedule,
  pending = false,
  error = null,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  schedule: PaymentSchedule | null;
  pending?: boolean;
  error?: string | null;
  onSubmit: (values: ScheduleEditValues) => void;
}) {
  // 调用方在打开时条件挂载 ⇒ 直接用当前值初始化，不需要 effect 同步
  const [amount, setAmount] = useState(
    schedule?.amount == null ? "" : String(schedule.amount),
  );
  const [dueDate, setDueDate] = useState(schedule?.due_date?.slice(0, 10) ?? "");
  const [notes, setNotes] = useState(schedule?.notes ?? "");
  const [localError, setLocalError] = useState<string | null>(null);

  const submit = () => {
    const num = Number(amount.trim());
    if (!Number.isFinite(num) || num <= 0) {
      setLocalError("金额必须是大于 0 的数字");
      return;
    }
    setLocalError(null);
    onSubmit({
      amount: num,
      due_date: dueDate.trim() || null,
      notes: notes.trim() === "" ? null : notes.trim(),
    });
  };

  const shownError = localError ?? error;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>修改收款计划</DialogTitle>
          <DialogDescription>
            {schedule
              ? `#${schedule.id} · ${schedule.schedule_type} · 当前 ${
                  schedule.amount ?? "—"
                } ${schedule.currency ?? ""}`
              : ""}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="schedule-amount">金额 *</Label>
            <Input
              id="schedule-amount"
              type="number"
              min={0}
              step="0.01"
              value={amount}
              disabled={pending}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="schedule-due">到期日</Label>
            <Input
              id="schedule-due"
              type="date"
              value={dueDate}
              disabled={pending}
              onChange={(e) => setDueDate(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="schedule-notes">备注</Label>
            <Input
              id="schedule-notes"
              value={notes}
              disabled={pending}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
          {shownError ? (
            <p role="alert" className="text-xs text-destructive">
              {shownError}
            </p>
          ) : null}
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
          <Button type="button" onClick={submit} disabled={pending}>
            {pending ? "保存中…" : "保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
