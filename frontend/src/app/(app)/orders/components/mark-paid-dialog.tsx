"use client";

/**
 * 收款计划「标记收款」弹窗（C36 下期 #10 的 paid 分支）。
 *
 * 契约要点（`backend/worker/src/main.py:4024` `update_schedule`）：
 * - `status=paid` 时后端更新 `actual_date`，并**仅在给了 `fx_rate`** 时按
 *   "实收金额 ×（实际汇率 − 锁定汇率）" 记 `exchange_gain_loss`；
 * - 不给实际汇率 ⇒ 只落日期与状态，不记汇兑损益（前端必须说明这一点，不能假装记了）；
 * - `paid → 非 paid` 是 409 `ILLEGAL_TRANSITION`（已收款不可回退）。
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

export interface MarkPaidValues {
  actual_date: string;
  fx_rate?: number;
}

export function MarkPaidDialog({
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
  onSubmit: (values: MarkPaidValues) => void;
}) {
  const [actualDate, setActualDate] = useState(
    schedule?.actual_date?.slice(0, 10) ??
      new Date().toISOString().slice(0, 10),
  );
  const [fxRate, setFxRate] = useState(
    schedule?.fx_rate == null ? "" : String(schedule.fx_rate),
  );
  const [localError, setLocalError] = useState<string | null>(null);

  const submit = () => {
    const rateText = fxRate.trim();
    let rate: number | undefined;
    if (rateText !== "") {
      const num = Number(rateText);
      if (!Number.isFinite(num) || num <= 0) {
        setLocalError("实际汇率必须是大于 0 的数字（留空则不记汇兑损益）");
        return;
      }
      rate = num;
    }
    setLocalError(null);
    onSubmit({
      actual_date: actualDate || new Date().toISOString().slice(0, 10),
      ...(rate !== undefined ? { fx_rate: rate } : {}),
    });
  };

  const shownError = localError ?? error;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>标记收款</DialogTitle>
          <DialogDescription>
            {schedule
              ? `#${schedule.id} · ${schedule.amount ?? "—"} ${
                  schedule.currency ?? ""
                }（收款后不可回退）`
              : ""}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="mark-paid-date">实际收款日期</Label>
            <Input
              id="mark-paid-date"
              type="date"
              value={actualDate}
              disabled={pending}
              onChange={(e) => setActualDate(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="mark-paid-rate">实际汇率（可选）</Label>
            <Input
              id="mark-paid-rate"
              inputMode="decimal"
              value={fxRate}
              placeholder="如 6.7029；留空则不记汇兑损益"
              disabled={pending}
              onChange={(e) => setFxRate(e.target.value)}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            填了实际汇率才按「实收金额 ×（实际汇率 − 锁定汇率）」记汇兑损益；留空只落收款日期与状态。
          </p>
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
            {pending ? "提交中…" : "确认收款"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
