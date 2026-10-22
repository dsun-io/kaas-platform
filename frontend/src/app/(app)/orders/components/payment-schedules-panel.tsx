"use client";

/**
 * 订单「收款计划 + 实收记录」面板（C36 下期 #6/#10/#20 → §13.3 扩展）。
 *
 * 覆盖四件事：
 * - 计划列表：`GET /orders/{id}/payment-schedules`（14 键 + received_amount）；
 * - 新建/修改计划：`POST /orders/{id}/payment-schedules` / `PATCH /payment-schedules/{id}`；
 * - **实收登记**：`POST /orders/{id}/receipts`（同一期可多次、可指定/不指定期次），
 *   到账截图走 `POST /payment-receipts/{id}/files`；
 * - 差异展示：该期 实收 − 应收（不静默改计划金额）；未指定期次的收款单独列在
 *   「未分配收款」区，供财务核对。
 *
 * 兼容历史：已标记 paid 但没有 receipts 的旧计划展示为「历史收款（无截图）」，
 * 实收金额取该期 amount，不强制补录；新登记才写 receipts。
 * 「标记收款」保留给没有 receipts 的旧计划（PATCH status=paid，走汇兑损益口径），
 * 新流程一律用「登记收款」。
 */
import { useState } from "react";
import { Plus, Receipt, Upload } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge } from "@/components/shared/status-badge";
import apiClient from "@/lib/api/client";
import { validateReceiptFile, RECEIPT_IMAGE_ACCEPT } from "@/lib/orders/order-attachments";
import {
  formatOrderDate,
  formatOrderMoney,
} from "@/lib/orders/order-detail";
import {
  effectiveScheduleStatus,
  isHistoricalPaidNoReceipt,
  receiptErrorText,
  receiptsForSchedule,
  receivedAmountForSchedule,
  scheduleDifference,
  scheduleErrorText,
  SCHEDULE_STATUS_LABEL,
  SCHEDULE_STATUS_TONE,
  SCHEDULE_TYPES,
  SCHEDULE_TYPE_LABEL,
  summarizeReceipts,
  summarizeSchedules,
  unallocatedReceipts,
  type PaymentReceipt,
  type PaymentSchedule,
} from "@/lib/orders/payment-schedules";

import {
  useCreateSchedule,
  useOrderSchedules,
  useUpdateSchedule,
} from "../hooks/use-order-schedules";
import {
  useCreateReceipt,
  useOrderReceipts,
  useUploadReceiptFile,
} from "../hooks/use-order-receipts";
import { MarkPaidDialog, type MarkPaidValues } from "./mark-paid-dialog";
import {
  RegisterReceiptDialog,
  type ReceiptFormValues,
} from "./register-receipt-dialog";
import {
  ScheduleEditDialog,
  type ScheduleEditValues,
} from "./schedule-edit-dialog";

function pct(value: number | null): string {
  if (value === null || value === undefined) return "—";
  return `${Number((value * 100).toFixed(2))}%`;
}

function diffText(diff: number | null, currency: string | null): string {
  if (diff === null) return "—";
  if (Math.abs(diff) < 0.005) return formatOrderMoney(0, currency);
  return `${diff > 0 ? "+" : ""}${formatOrderMoney(diff, currency)}`;
}

export function PaymentSchedulesPanel({
  orderId,
  currency,
}: {
  orderId: number;
  currency: string | null;
}) {
  const list = useOrderSchedules(orderId);
  const receiptsQuery = useOrderReceipts(orderId);
  const create = useCreateSchedule(orderId);
  const update = useUpdateSchedule(orderId);
  const createReceipt = useCreateReceipt(orderId);
  const uploadReceiptFile = useUploadReceiptFile(orderId);

  const [showCreate, setShowCreate] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [draft, setDraft] = useState({
    schedule_type: "deposit",
    ratio: "",
    amount: "",
    due_date: "",
    notes: "",
  });
  const [editSchedule, setEditSchedule] = useState<PaymentSchedule | null>(
    null,
  );
  const [editError, setEditError] = useState<string | null>(null);
  const [paySchedule, setPaySchedule] = useState<PaymentSchedule | null>(null);
  const [payError, setPayError] = useState<string | null>(null);
  const [registerTarget, setRegisterTarget] = useState<{
    schedule: PaymentSchedule | null;
  } | null>(null);
  const [registerError, setRegisterError] = useState<string | null>(null);

  const items = list.data?.items ?? [];
  const receipts = receiptsQuery.data?.items ?? [];
  const summary = summarizeSchedules(items, receipts);
  const receiptSummary = summarizeReceipts(receipts);
  const unallocated = unallocatedReceipts(receipts);
  const hasReceipts = receipts.length > 0;

  const submitCreate = async () => {
    setCreateError(null);
    try {
      await create.mutateAsync(draft);
      setShowCreate(false);
      setDraft({
        schedule_type: "deposit",
        ratio: "",
        amount: "",
        due_date: "",
        notes: "",
      });
    } catch (err) {
      setCreateError(scheduleErrorText(err));
    }
  };

  const submitEdit = async (values: ScheduleEditValues) => {
    if (!editSchedule) return;
    setEditError(null);
    try {
      await update.mutateAsync({
        scheduleId: editSchedule.id,
        input: {
          amount: String(values.amount),
          ...(values.due_date ? { due_date: values.due_date } : {}),
          ...(values.notes ? { notes: values.notes } : {}),
        },
      });
      setEditSchedule(null);
    } catch (err) {
      setEditError(scheduleErrorText(err));
    }
  };

  const submitPaid = async (values: MarkPaidValues) => {
    if (!paySchedule) return;
    setPayError(null);
    try {
      await update.mutateAsync({
        scheduleId: paySchedule.id,
        input: {
          status: "paid",
          actual_date: values.actual_date,
          ...(values.fx_rate !== undefined
            ? { fx_rate: String(values.fx_rate) }
            : {}),
        },
      });
      setPaySchedule(null);
    } catch (err) {
      setPayError(scheduleErrorText(err));
    }
  };

  const submitReceipt = async (values: ReceiptFormValues) => {
    if (!registerTarget) return;
    setRegisterError(null);
    try {
      const receipt = await createReceipt.mutateAsync({
        schedule_id: registerTarget.schedule?.id ?? null,
        amount: String(values.amount),
        received_date: values.received_date,
        ...(values.fx_rate !== undefined
          ? { fx_rate: String(values.fx_rate) }
          : {}),
        notes: values.notes ?? "",
      });
      if (values.file) {
        try {
          await uploadReceiptFile.mutateAsync({
            receiptId: receipt.id,
            file: values.file,
          });
        } catch {
          toast.warning(
            "收款已登记，但到账截图上传失败。可在下方「实收记录」里补传。",
          );
        }
      }
      toast.success("已登记收款，应收台账已同步");
      setRegisterTarget(null);
    } catch (err) {
      setRegisterError(receiptErrorText(err));
    }
  };

  const uploadScreenshot = async (receiptId: number, file: File) => {
    const reason = validateReceiptFile(file);
    if (reason) {
      toast.error(reason);
      return;
    }
    try {
      await uploadReceiptFile.mutateAsync({ receiptId, file });
      toast.success("到账截图已上传");
    } catch {
      toast.error("到账截图上传失败，请重试");
    }
  };

  const openScreenshot = async (fileId: number) => {
    try {
      const res = await apiClient.get(`/file-objects/${fileId}/content`, {
        responseType: "blob",
      });
      const url = URL.createObjectURL(res.data as Blob);
      window.open(url, "_blank", "noopener");
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch {
      toast.error("打开到账截图失败，请稍后重试");
    }
  };

  const scheduleLabel = (receipt: PaymentReceipt): string => {
    if (receipt.schedule_id === null) return "未分配";
    const index = items.findIndex((item) => item.id === receipt.schedule_id);
    if (index < 0) return `#${receipt.schedule_id}`;
    const item = items[index];
    return `第 ${index + 1} 期（${
      item ? SCHEDULE_TYPE_LABEL[item.schedule_type] ?? item.schedule_type : ""
    }）`;
  };

  const receiptDiff = (receipt: PaymentReceipt): number | null => {
    if (receipt.schedule_id === null) return null;
    const schedule = items.find((item) => item.id === receipt.schedule_id);
    if (!schedule || typeof schedule.amount !== "number") return null;
    return Math.round((receipt.amount - schedule.amount) * 100) / 100;
  };

  const busy =
    createReceipt.isPending || uploadReceiptFile.isPending || update.isPending;

  return (
    <SectionCard
      title="收款计划与实收"
      description="定金/尾款/全额分期；应收按计划金额，实收按实际到账登记（支持同一期多次、金额与应收不一致），差异只展示不自动改计划。"
      action={
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setRegisterError(null);
              setRegisterTarget({ schedule: null });
            }}
          >
            <Receipt className="mr-1 h-4 w-4" />
            登记收款
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setShowCreate((v) => !v)}
          >
            <Plus className="mr-1 h-4 w-4" />
            {showCreate ? "收起" : "新增收款计划"}
          </Button>
        </div>
      }
    >
      {showCreate && (
        <div className="mb-4 grid gap-3 rounded-lg border p-3 sm:grid-cols-2 lg:grid-cols-5">
          <label className="space-y-1">
            <span className="text-sm font-medium">类型 *</span>
            <select
              aria-label="收款类型"
              className="h-9 w-full rounded-lg border border-input bg-background px-2 text-sm"
              value={draft.schedule_type}
              onChange={(e) =>
                setDraft((prev) => ({ ...prev, schedule_type: e.target.value }))
              }
            >
              {SCHEDULE_TYPES.map((type) => (
                <option key={type} value={type}>
                  {SCHEDULE_TYPE_LABEL[type]}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1">
            <span className="text-sm font-medium">比例（0~1）</span>
            <Input
              aria-label="比例"
              value={draft.ratio}
              inputMode="decimal"
              placeholder="如 0.3"
              onChange={(e) =>
                setDraft((prev) => ({ ...prev, ratio: e.target.value }))
              }
            />
          </label>
          <label className="space-y-1">
            <span className="text-sm font-medium">金额</span>
            <Input
              aria-label="金额"
              value={draft.amount}
              inputMode="decimal"
              placeholder="留空 = 按比例 × 订单总额"
              onChange={(e) =>
                setDraft((prev) => ({ ...prev, amount: e.target.value }))
              }
            />
          </label>
          <label className="space-y-1">
            <span className="text-sm font-medium">到期日</span>
            <Input
              aria-label="到期日"
              type="date"
              value={draft.due_date}
              onChange={(e) =>
                setDraft((prev) => ({ ...prev, due_date: e.target.value }))
              }
            />
          </label>
          <label className="space-y-1">
            <span className="text-sm font-medium">备注</span>
            <Input
              aria-label="备注"
              value={draft.notes}
              onChange={(e) =>
                setDraft((prev) => ({ ...prev, notes: e.target.value }))
              }
            />
          </label>
          <div className="sm:col-span-2 lg:col-span-5">
            <Button
              size="sm"
              onClick={() => void submitCreate()}
              disabled={create.isPending}
            >
              {create.isPending ? "创建中…" : "创建收款计划"}
            </Button>
            {createError ? (
              <p role="alert" className="mt-2 text-xs text-destructive">
                {createError}
              </p>
            ) : null}
            <p className="mt-2 text-xs text-muted-foreground">
              后端以「金额优先、否则比例×订单总额」补算金额；比例与金额至少填一个（前端先拦）。
            </p>
          </div>
        </div>
      )}

      {list.isLoading ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          正在读取收款计划…
        </p>
      ) : list.isError ? (
        <p className="py-6 text-center text-sm text-destructive">
          收款计划读取失败：{scheduleErrorText(list.error)}
        </p>
      ) : items.length === 0 ? (
        <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
          <Receipt className="h-4 w-4" />
          还没有收款计划。点右上「新增收款计划」建第一条，或直接「登记收款」。
        </div>
      ) : (
        <>
          <div className="mb-2 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
            <span>共 {summary.count} 期</span>
            <span>应收合计 {formatOrderMoney(summary.totalAmount, currency)}</span>
            <span className="text-success">
              已收 {formatOrderMoney(summary.paidAmount, currency)}（
              {summary.paidCount} 期已收清
              {summary.partialCount > 0
                ? ` / ${summary.partialCount} 期部分收款`
                : ""}
              ）
            </span>
            <span className="text-warning-muted-foreground">
              待收 {formatOrderMoney(Math.max(0, summary.pendingAmount), currency)}
            </span>
            <span>
              实收登记 {receiptSummary.count} 笔 ·{" "}
              {formatOrderMoney(receiptSummary.totalAmount, currency)}
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th scope="col" className="p-2">
                    期次
                  </th>
                  <th scope="col" className="p-2">
                    类型
                  </th>
                  <th scope="col" className="p-2">
                    比例
                  </th>
                  <th scope="col" className="p-2">
                    应收金额
                  </th>
                  <th scope="col" className="p-2">
                    已收
                  </th>
                  <th scope="col" className="p-2">
                    差异
                  </th>
                  <th scope="col" className="p-2">
                    到期日
                  </th>
                  <th scope="col" className="p-2">
                    状态
                  </th>
                  <th scope="col" className="p-2">
                    操作
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((item, index) => {
                  const received = receivedAmountForSchedule(item, receipts);
                  const diff = scheduleDifference(item, receipts);
                  const status = effectiveScheduleStatus(item, receipts);
                  const historical = isHistoricalPaidNoReceipt(item, receipts);
                  const ownReceipts = receiptsForSchedule(receipts, item.id);
                  return (
                    <tr key={item.id} className="border-b last:border-0">
                      <td className="p-2">#{index + 1}</td>
                      <td className="p-2">
                        {SCHEDULE_TYPE_LABEL[item.schedule_type] ??
                          item.schedule_type}
                      </td>
                      <td className="p-2">{pct(item.ratio)}</td>
                      <td className="p-2">
                        {formatOrderMoney(
                          typeof item.amount === "number" ? item.amount : null,
                          item.currency ?? currency,
                        )}
                      </td>
                      <td className="p-2">
                        <div className="flex flex-col">
                          <span>
                            {formatOrderMoney(
                              received,
                              item.currency ?? currency,
                            )}
                          </span>
                          {historical && (
                            <span className="text-[11px] text-muted-foreground">
                              历史收款（无截图）
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="p-2">
                        <span
                          className={
                            diff === null || Math.abs(diff) < 0.005
                              ? "text-muted-foreground"
                              : "text-warning"
                          }
                        >
                          {diffText(diff, item.currency ?? currency)}
                        </span>
                      </td>
                      <td className="p-2">{formatOrderDate(item.due_date)}</td>
                      <td className="p-2">
                        <StatusBadge
                          tone={SCHEDULE_STATUS_TONE[status] ?? "default"}
                        >
                          {SCHEDULE_STATUS_LABEL[status] ?? status}
                        </StatusBadge>
                      </td>
                      <td className="p-2">
                        <div className="flex flex-wrap gap-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              setRegisterError(null);
                              setRegisterTarget({ schedule: item });
                            }}
                          >
                            登记收款
                          </Button>
                          {status !== "paid" && ownReceipts.length === 0 && (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => {
                                setPayError(null);
                                setPaySchedule(item);
                              }}
                            >
                              标记收款
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              setEditError(null);
                              setEditSchedule(item);
                            }}
                          >
                            修改
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {hasReceipts && (
        <div className="mt-5 space-y-2">
          <h3 className="text-sm font-medium">实收记录</h3>
          <p className="text-xs text-muted-foreground">
            一次到账一行，支持同一期多次收款；差异 = 实收 − 该期应收，供财务核对。
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th scope="col" className="p-2">
                    收款日期
                  </th>
                  <th scope="col" className="p-2">
                    实收金额
                  </th>
                  <th scope="col" className="p-2">
                    对应期次
                  </th>
                  <th scope="col" className="p-2">
                    差异
                  </th>
                  <th scope="col" className="p-2">
                    汇率
                  </th>
                  <th scope="col" className="p-2">
                    备注
                  </th>
                  <th scope="col" className="p-2">
                    到账截图
                  </th>
                </tr>
              </thead>
              <tbody>
                {receipts.map((receipt) => (
                  <tr key={receipt.id} className="border-b last:border-0">
                    <td className="p-2">
                      {formatOrderDate(receipt.received_date)}
                    </td>
                    <td className="p-2">
                      {formatOrderMoney(
                        receipt.amount,
                        receipt.currency ?? currency,
                      )}
                    </td>
                    <td className="p-2">{scheduleLabel(receipt)}</td>
                    <td className="p-2">
                      {diffText(receiptDiff(receipt), currency)}
                    </td>
                    <td className="p-2">
                      {receipt.fx_rate === null ? "—" : receipt.fx_rate}
                    </td>
                    <td className="p-2 max-w-[220px] truncate" title={receipt.notes ?? ""}>
                      {receipt.notes || "—"}
                    </td>
                    <td className="p-2">
                      {receipt.file_id ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            void openScreenshot(receipt.file_id as number)
                          }
                        >
                          查看到账截图
                        </Button>
                      ) : (
                        <label className="inline-flex cursor-pointer items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-muted/40">
                          <Upload className="size-3" />
                          补传截图
                          <input
                            type="file"
                            className="sr-only"
                            aria-label={`补传到账截图 #${receipt.id}`}
                            accept={RECEIPT_IMAGE_ACCEPT}
                            disabled={busy}
                            onChange={(e) => {
                              const file = e.target.files?.[0] ?? null;
                              e.target.value = "";
                              if (file) {
                                void uploadScreenshot(receipt.id, file);
                              }
                            }}
                          />
                        </label>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {unallocated.length > 0 && (
            <div className="rounded-lg border border-warning/40 bg-warning-muted p-3 text-xs text-warning-muted-foreground">
              <p className="font-medium">
                未分配收款 {unallocated.length} 笔（暂未指定期次）
              </p>
              <ul className="mt-1 space-y-0.5">
                {unallocated.map((receipt) => (
                  <li key={receipt.id}>
                    {formatOrderDate(receipt.received_date)} ·{" "}
                    {formatOrderMoney(
                      receipt.amount,
                      receipt.currency ?? currency,
                    )}
                    {receipt.notes ? ` · ${receipt.notes}` : ""}
                  </li>
                ))}
              </ul>
              <p className="mt-1">
                这些钱没有对应到某一期，页面不会静默摊到计划金额上；请财务与客户核对后调整计划或补指定期次。
              </p>
            </div>
          )}
        </div>
      )}

      {editSchedule && (
        <ScheduleEditDialog
          open
          onOpenChange={(next) => {
            if (!next) setEditSchedule(null);
          }}
          schedule={editSchedule}
          pending={update.isPending}
          error={editError}
          onSubmit={submitEdit}
        />
      )}
      {paySchedule && (
        <MarkPaidDialog
          open
          onOpenChange={(next) => {
            if (!next) setPaySchedule(null);
          }}
          schedule={paySchedule}
          pending={update.isPending}
          error={payError}
          onSubmit={submitPaid}
        />
      )}
      {registerTarget && (
        <RegisterReceiptDialog
          open
          onOpenChange={(next) => {
            if (!next) setRegisterTarget(null);
          }}
          schedule={registerTarget.schedule}
          currency={currency}
          receivedAmount={
            registerTarget.schedule
              ? receivedAmountForSchedule(registerTarget.schedule, receipts)
              : 0
          }
          pending={busy}
          error={registerError}
          onSubmit={(values) => void submitReceipt(values)}
        />
      )}
    </SectionCard>
  );
}
