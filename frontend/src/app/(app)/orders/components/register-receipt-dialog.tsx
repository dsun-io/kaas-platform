"use client";

/**
 * 登记收款弹窗（§13.3 核心新能力）。
 *
 * 用户口径：实收金额**默认 = 该期剩余应收，可改成实际到账金额**；
 * 必填实收金额 + 收款日期；选填实际汇率、备注、确认到账截图（PNG/JPG/PDF）。
 *
 * 允许同一期多次收款；也允许`schedule_id`为空（这笔钱暂不指定期次）。
 * 金额与应收不一致**不拦**——差异由面板的"差异"列展示，供财务核对，
 * 绝不静默改计划金额。
 */
import { useState } from "react";
import { Paperclip, X } from "lucide-react";

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
import {
  formatFileSize,
  RECEIPT_IMAGE_ACCEPT,
  validateReceiptFile,
} from "@/lib/orders/order-attachments";
import { formatOrderMoney, formatOrderDate } from "@/lib/orders/order-detail";
import type { PaymentSchedule } from "@/lib/orders/payment-schedules";

export interface ReceiptFormValues {
  amount: number;
  received_date: string;
  fx_rate?: number;
  notes?: string;
  /** 到账截图（先登记收款，成功后再上传到该 receipt） */
  file: File | null;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function RegisterReceiptDialog({
  open,
  onOpenChange,
  schedule,
  schedulePeriod = null,
  currency,
  receivedAmount,
  pending = false,
  error = null,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** null = 未指定期次的收款 */
  schedule: PaymentSchedule | null;
  /**
   * 该期在计划列表里的**期次序号**（1-based，O3）。
   *
   * 不能拿 `schedule.id` 当"第几期"：id 是数据库行号，删过计划/多单并行时会跳号，
   * 与列表「期次」列的序号对不上。缺省回退 id 仅作兜底（正常调用方都会传）。
   */
  schedulePeriod?: number | null;
  currency: string | null;
  /** 该期已收合计（用于默认剩余应收） */
  receivedAmount: number;
  pending?: boolean;
  error?: string | null;
  onSubmit: (values: ReceiptFormValues) => void;
}) {
  const due = typeof schedule?.amount === "number" ? schedule.amount : 0;
  const remaining = Math.round((due - receivedAmount) * 100) / 100;
  const [amount, setAmount] = useState(
    schedule && remaining > 0 ? remaining.toFixed(2) : "",
  );
  const [receivedDate, setReceivedDate] = useState(today());
  const [fxRate, setFxRate] = useState(
    schedule?.fx_rate == null ? "" : String(schedule.fx_rate),
  );
  const [notes, setNotes] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const submit = () => {
    const amountNum = Number(amount);
    if (amount.trim() === "" || !Number.isFinite(amountNum) || amountNum <= 0) {
      setLocalError("请填实收金额（实际到账多少就填多少，必须大于 0）");
      return;
    }
    if (!receivedDate) {
      setLocalError("请选择收款日期");
      return;
    }
    let rate: number | undefined;
    if (fxRate.trim() !== "") {
      const rateNum = Number(fxRate);
      if (!Number.isFinite(rateNum) || rateNum <= 0) {
        setLocalError("实际汇率必须是大于 0 的数字（留空则不记）");
        return;
      }
      rate = rateNum;
    }
    setLocalError(null);
    onSubmit({
      amount: amountNum,
      received_date: receivedDate,
      ...(rate !== undefined ? { fx_rate: rate } : {}),
      ...(notes.trim() ? { notes: notes.trim() } : {}),
      file,
    });
  };

  const shownError = localError ?? error;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>登记收款</DialogTitle>
          <DialogDescription>
            {schedule
              ? `第 ${schedulePeriod ?? schedule.id} 期 · 应收 ${formatOrderMoney(
                  typeof schedule.amount === "number" ? schedule.amount : null,
                  currency,
                )} · 已收 ${formatOrderMoney(receivedAmount, currency)}`
              : "这笔款暂不指定期次（会显示在「未分配收款」里）"}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="receipt-amount">实收金额 *</Label>
            <Input
              id="receipt-amount"
              inputMode="decimal"
              value={amount}
              placeholder="默认 = 剩余应收，可改成实际到账金额"
              disabled={pending}
              onChange={(e) => setAmount(e.target.value)}
            />
            {schedule && (
              <p className="text-[11px] text-muted-foreground">
                剩余应收{" "}
                {formatOrderMoney(remaining > 0 ? remaining : 0, currency)}
                ；实收与应收不一致时，订单详情会显示差异，不会改计划金额。
              </p>
            )}
          </div>
          <div className="space-y-1">
            <Label htmlFor="receipt-date">收款日期 *</Label>
            <Input
              id="receipt-date"
              type="date"
              value={receivedDate}
              disabled={pending}
              onChange={(e) => setReceivedDate(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="receipt-rate">实际汇率（可选）</Label>
            <Input
              id="receipt-rate"
              inputMode="decimal"
              value={fxRate}
              placeholder="如 6.7029"
              disabled={pending}
              onChange={(e) => setFxRate(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="receipt-notes">备注</Label>
            <Input
              id="receipt-notes"
              value={notes}
              placeholder="如：客户分两笔到账，这是第一笔"
              disabled={pending}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label>确认到账截图（可选）</Label>
            {file ? (
              <div className="flex items-center gap-2 rounded-lg border px-2 py-1.5 text-xs">
                <Paperclip className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{file.name}</span>
                <span className="text-muted-foreground">
                  {formatFileSize(file.size)}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label="移除到账截图"
                  disabled={pending}
                  onClick={() => setFile(null)}
                >
                  <X className="size-3.5" />
                </Button>
              </div>
            ) : (
              <Input
                type="file"
                aria-label="到账截图"
                accept={RECEIPT_IMAGE_ACCEPT}
                disabled={pending}
                onChange={(e) => {
                  const next = e.target.files?.[0] ?? null;
                  e.target.value = "";
                  if (!next) {
                    setFile(null);
                    return;
                  }
                  const reason = validateReceiptFile(next);
                  if (reason) {
                    setLocalError(reason);
                    setFile(null);
                    return;
                  }
                  setLocalError(null);
                  setFile(next);
                }}
              />
            )}
            <p className="text-[11px] text-muted-foreground">
              PNG / JPG /
              PDF，≤16MB；上传失败不影响收款登记，可稍后在实收记录里补传。
            </p>
          </div>
          {shownError ? (
            <p role="alert" className="text-xs text-destructive">
              {shownError}
            </p>
          ) : null}
          {schedule?.due_date ? (
            <p className="text-[11px] text-muted-foreground">
              约定到期日 {formatOrderDate(schedule.due_date)}
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
            {pending ? "登记中…" : "确认登记"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
