"use client";

/**
 * 收款登记面板（A7-3）
 *
 * 核销判定完全在后端（`receipt_rules.classify_receipt_diff`：每币种
 * max(5 美分等值, 金额 × 0.1%)），本面板**不重复实现阈值**，只把 verdict 如实展示：
 * - `fx_rounding` 差额在容差内 → 自动核销（绿）
 * - `short_paid`  超容差 → 挂账告警（红）
 * - `manual`      没给账期金额 → 手工登记（灰，不冒充"已核销"）
 *
 * 金额一律按后端返回的**字符串**显示（`decimal_text` 保留精度），不要 parseFloat
 * 再格式化 —— 那会把 12300.10 显示成 12300.1 甚至 12300.099999。
 */
import { useState } from "react";
import { BadgeDollarSign, Plus } from "lucide-react";
import { toast } from "sonner";

import { LoadingBlock } from "@/components/shared/loading-block";
import { StatusBadge } from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  CURRENCIES,
  SCHEDULE_TYPES,
  receiptMeta,
  receiptTolerance,
} from "@/lib/trade-doc/hardening";

import { useCreateReceipt, useDocReceipts } from "../hooks/use-doc-hardening";

const SCHEDULE_LABEL: Record<string, string> = {
  deposit: "订金",
  balance: "尾款",
  full: "全款",
};

interface Draft {
  schedule_type: string;
  schedule_amount: string;
  received_amount: string;
  currency: string;
  bank_ref: string;
  notes: string;
}

const EMPTY: Draft = {
  schedule_type: "",
  schedule_amount: "",
  received_amount: "",
  currency: "USD",
  bank_ref: "",
  notes: "",
};

export function DocReceiptsPanel({
  docId,
  docCurrency,
}: {
  docId: number;
  docCurrency: string | null;
}) {
  const receipts = useDocReceipts(docId);
  const create = useCreateReceipt(docId);
  const [draft, setDraft] = useState<Draft>({
    ...EMPTY,
    currency: (docCurrency ?? "USD").toUpperCase(),
  });
  const [open, setOpen] = useState(false);

  const items = receipts.data?.items ?? [];
  const scheduleAmount = Number(draft.schedule_amount || "0");
  const toleranceHint =
    scheduleAmount > 0
      ? `容差 ${receiptTolerance(draft.currency, scheduleAmount).toFixed(2)} ${draft.currency}（差额在容差内自动核销）`
      : "不填账期金额 = 手工登记（无从核销，状态为 manual）";

  const submit = async () => {
    if (!draft.received_amount.trim()) {
      toast.error("先填实收金额");
      return;
    }
    try {
      const result = await create.mutateAsync({
        schedule_type: draft.schedule_type || null,
        schedule_amount: draft.schedule_amount.trim() || null,
        received_amount: draft.received_amount.trim(),
        currency: draft.currency,
        bank_ref: draft.bank_ref.trim() || null,
        notes: draft.notes.trim() || null,
      });
      const meta = receiptMeta(result.verdict.diff_reason);
      toast.success(
        `${meta.label}：差额 ${result.verdict.diff} ${draft.currency}（容差 ${result.verdict.tolerance}）`,
      );
      setDraft({ ...EMPTY, currency: draft.currency });
      setOpen(false);
    } catch {
      toast.error("登记失败：金额/币种不合法时后端会明确拒绝");
    }
  };

  if (receipts.isLoading) return <LoadingBlock rows={3} />;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <StatusBadge tone="info" dot={false}>
          共 {items.length} 笔
        </StatusBadge>
        <Button
          size="sm"
          className="ml-auto"
          onClick={() => setOpen((prev) => !prev)}
        >
          <Plus className="mr-1 h-4 w-4" />
          登记收款
        </Button>
      </div>

      {open && (
        <div className="grid gap-2 rounded-md border bg-muted/20 p-3 sm:grid-cols-2">
          <label className="space-y-1 text-xs">
            <span className="font-medium">账期类型</span>
            <select
              className="h-9 w-full rounded-md border bg-background px-2 text-sm"
              value={draft.schedule_type}
              onChange={(e) =>
                setDraft({ ...draft, schedule_type: e.target.value })
              }
            >
              <option value="">（不指定）</option>
              {SCHEDULE_TYPES.map((type) => (
                <option key={type} value={type}>
                  {SCHEDULE_LABEL[type] ?? type}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-xs">
            <span className="font-medium">账期金额</span>
            <Input
              aria-label="账期金额"
              inputMode="decimal"
              value={draft.schedule_amount}
              onChange={(e) =>
                setDraft({ ...draft, schedule_amount: e.target.value })
              }
              placeholder="留空 = 手工登记"
            />
          </label>
          <label className="space-y-1 text-xs">
            <span className="font-medium">实收金额</span>
            <Input
              aria-label="实收金额"
              inputMode="decimal"
              value={draft.received_amount}
              onChange={(e) =>
                setDraft({ ...draft, received_amount: e.target.value })
              }
            />
          </label>
          <label className="space-y-1 text-xs">
            <span className="font-medium">币种</span>
            <select
              className="h-9 w-full rounded-md border bg-background px-2 text-sm"
              value={draft.currency}
              onChange={(e) => setDraft({ ...draft, currency: e.target.value })}
            >
              {CURRENCIES.map((currency) => (
                <option key={currency} value={currency}>
                  {currency}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-xs">
            <span className="font-medium">银行流水号</span>
            <Input
              aria-label="银行流水号"
              value={draft.bank_ref}
              onChange={(e) => setDraft({ ...draft, bank_ref: e.target.value })}
            />
          </label>
          <label className="space-y-1 text-xs">
            <span className="font-medium">备注</span>
            <Input
              aria-label="备注"
              value={draft.notes}
              onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
            />
          </label>
          <p className="text-xs text-muted-foreground sm:col-span-2">
            {toleranceHint}
          </p>
          <div className="flex gap-2 sm:col-span-2">
            <Button size="sm" disabled={create.isPending} onClick={submit}>
              保存并核销
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
              取消
            </Button>
          </div>
        </div>
      )}

      <ul className="divide-y rounded-md border">
        {items.map((receipt) => {
          const meta = receiptMeta(receipt.diff_reason ?? receipt.status);
          return (
            <li key={receipt.id} className="px-3 py-2 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <BadgeDollarSign className="h-4 w-4 text-muted-foreground" />
                <span className="font-medium">
                  {receipt.received_amount} {receipt.currency}
                </span>
                {receipt.schedule_amount && (
                  <span className="text-xs text-muted-foreground">
                    账期 {receipt.schedule_amount}
                    {receipt.schedule_type
                      ? `（${SCHEDULE_LABEL[receipt.schedule_type] ?? receipt.schedule_type}）`
                      : ""}
                  </span>
                )}
                <StatusBadge tone={meta.tone}>{meta.label}</StatusBadge>
                {receipt.diff && receipt.diff !== "0" && (
                  <span className="text-xs text-muted-foreground">
                    差额 {receipt.diff}
                  </span>
                )}
                <span className="ml-auto text-xs text-muted-foreground">
                  {receipt.received_at ?? receipt.created_at ?? "—"}
                </span>
              </div>
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                {receipt.bank_ref && <span>流水：{receipt.bank_ref}</span>}
                {receipt.notes && <span>备注：{receipt.notes}</span>}
                <span>{meta.hint}</span>
              </div>
            </li>
          );
        })}
        {items.length === 0 && (
          <li className="px-3 py-6 text-center text-sm text-muted-foreground">
            还没有收款记录。
          </li>
        )}
      </ul>
    </div>
  );
}
