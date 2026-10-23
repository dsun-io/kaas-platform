"use client";

/**
 * 订单「收款计划 + 实收记录」面板（C36 下期 #6/#10/#20 → §13.3 扩展）。
 *
 * 四件事：计划列表 / 新建与修改计划 / **实收登记**（可指定或不指定期次）/ 差异展示。
 * 兼容历史：已标记 paid 但没有 receipts 的旧计划展示为「历史收款（无截图）」；
 * 「标记收款」只留给这类旧计划（PATCH status=paid，走汇兑损益口径），新流程一律
 * 用「登记收款」。
 *
 * 结构（U-P1D2 拆分，行为不变）：本文件只留**数据 hooks + 状态 + 编排 + 弹窗挂载**，
 * 展示拆到同目录子组件：
 * - `ScheduleCreateForm` 新增计划内联表单；
 * - `ScheduleSummaryBar` 汇总条；
 * - `SchedulesTable` 计划表（O3 期次序号在行内操作里传递）；
 * - `ReceiptsSection` 实收记录 + 未分配收款；
 * - 弹窗 `ScheduleEditDialog` / `MarkPaidDialog` / `RegisterReceiptDialog`（已独立）。
 *
 * O3：登记收款弹窗标题用**列表期次序号**（第 N 期），不用 DB id（删计划会跳号）。
 * O4：计划加载态用共享 `LoadingBlock`（不是纯文本「正在读取…」）。
 */
import { useState } from "react";
import { Plus, Receipt } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { LoadingBlock } from "@/components/shared/loading-block";
import { SectionCard } from "@/components/shared/section-card";
import apiClient from "@/lib/api/client";
import { validateReceiptFile } from "@/lib/orders/order-attachments";
import {
  receiptErrorText,
  receivedAmountForSchedule,
  scheduleErrorText,
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
import { ReceiptsSection } from "./receipts-section";
import {
  ScheduleEditDialog,
  type ScheduleEditValues,
} from "./schedule-edit-dialog";
import {
  EMPTY_SCHEDULE_DRAFT,
  ScheduleCreateForm,
  type ScheduleDraft,
} from "./schedule-create-form";
import { ScheduleSummaryBar } from "./schedule-summary-bar";
import { SchedulesTable } from "./schedules-table";

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
  const [draft, setDraft] = useState<ScheduleDraft>({
    ...EMPTY_SCHEDULE_DRAFT,
  });
  const [editSchedule, setEditSchedule] = useState<PaymentSchedule | null>(
    null,
  );
  const [editError, setEditError] = useState<string | null>(null);
  const [paySchedule, setPaySchedule] = useState<PaymentSchedule | null>(null);
  const [payError, setPayError] = useState<string | null>(null);
  const [registerTarget, setRegisterTarget] = useState<{
    schedule: PaymentSchedule | null;
    /** 该期在列表里的期次序号（1-based）——弹窗标题用它，不用 DB id（O3） */
    period: number | null;
  } | null>(null);
  const [registerError, setRegisterError] = useState<string | null>(null);

  const items = list.data?.items ?? [];
  const receipts = receiptsQuery.data?.items ?? [];
  const hasReceipts = receipts.length > 0;

  const submitCreate = async () => {
    setCreateError(null);
    try {
      await create.mutateAsync(draft);
      setShowCreate(false);
      setDraft({ ...EMPTY_SCHEDULE_DRAFT });
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
              setRegisterTarget({ schedule: null, period: null });
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
        <ScheduleCreateForm
          draft={draft}
          onChange={(patch) => setDraft((prev) => ({ ...prev, ...patch }))}
          onSubmit={() => void submitCreate()}
          pending={create.isPending}
          error={createError}
        />
      )}

      {list.isLoading ? (
        // O4：加载态用共享 LoadingBlock（不再是纯文本「正在读取…」）
        <LoadingBlock rows={3} />
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
          <ScheduleSummaryBar
            items={items}
            receipts={receipts}
            currency={currency}
          />
          <SchedulesTable
            items={items}
            receipts={receipts}
            currency={currency}
            onRegister={(schedule, period) => {
              setRegisterError(null);
              setRegisterTarget({ schedule, period });
            }}
            onMarkPaid={(schedule) => {
              setPayError(null);
              setPaySchedule(schedule);
            }}
            onEdit={(schedule) => {
              setEditError(null);
              setEditSchedule(schedule);
            }}
          />
        </>
      )}

      {hasReceipts && (
        <ReceiptsSection
          items={items}
          receipts={receipts}
          currency={currency}
          busy={busy}
          onOpenScreenshot={(fileId) => void openScreenshot(fileId)}
          onUploadScreenshot={(receiptId, file) =>
            void uploadScreenshot(receiptId, file)
          }
        />
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
          schedulePeriod={registerTarget.period}
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
