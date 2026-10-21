"use client";

/**
 * 订单「收款计划」面板（C36 下期 #6/#10/#20）。
 *
 * 入口：订单页选中订单后，在「贸易条款」下方展示。覆盖三件套：
 * - 列表：`GET /orders/{id}/payment-schedules`（14 键行，按 due_date 升序、空日期在最后）；
 * - 新建：`POST /orders/{id}/payment-schedules`（schedule_type 必填；ratio/amount 至少一个）；
 * - 修改 / 标记收款：`PATCH /payment-schedules/{id}`（paid 分支只在给了实际汇率时算汇兑损益）。
 *
 * 错误一律走 `scheduleErrorText`（嵌套/扁平体都认；409 已收款不可回退给专门文案）。
 */
import { useState } from "react";
import { Plus, Receipt } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge } from "@/components/shared/status-badge";
import {
  SCHEDULE_STATUS_LABEL,
  SCHEDULE_STATUS_TONE,
  SCHEDULE_TYPES,
  SCHEDULE_TYPE_LABEL,
  scheduleErrorText,
  summarizeSchedules,
  type PaymentSchedule,
} from "@/lib/orders/payment-schedules";

import {
  useCreateSchedule,
  useOrderSchedules,
  useUpdateSchedule,
} from "../hooks/use-order-schedules";
import { MarkPaidDialog, type MarkPaidValues } from "./mark-paid-dialog";
import {
  ScheduleEditDialog,
  type ScheduleEditValues,
} from "./schedule-edit-dialog";

function money(value: number | null, currency: string | null): string {
  if (value === null || value === undefined) return "—";
  return `${currency ?? ""} ${value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function pct(value: number | null): string {
  if (value === null || value === undefined) return "—";
  return `${Number((value * 100).toFixed(2))}%`;
}

export function PaymentSchedulesPanel({
  orderId,
  currency,
}: {
  orderId: number;
  currency: string | null;
}) {
  const list = useOrderSchedules(orderId);
  const create = useCreateSchedule(orderId);
  const update = useUpdateSchedule(orderId);

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

  const items = list.data?.items ?? [];
  const summary = summarizeSchedules(items);

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

  return (
    <SectionCard
      title="收款计划"
      description="定金/尾款/全额分期；标记收款时可选填实际汇率以记汇兑损益（不填只落日期，不记损益）。"
      action={
        <Button
          size="sm"
          variant="outline"
          onClick={() => setShowCreate((v) => !v)}
        >
          <Plus className="mr-1 h-4 w-4" />
          {showCreate ? "收起" : "新增收款计划"}
        </Button>
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
              后端以「后端金额优先、否则比例×订单总额」补算金额；比例与金额至少填一个（前端先拦）。
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
          还没有收款计划。点右上「新增收款计划」建第一条。
        </div>
      ) : (
        <>
          <div className="mb-2 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
            <span>共 {summary.count} 期</span>
            <span>应收合计 {money(summary.totalAmount, currency)}</span>
            <span className="text-success">
              已收 {money(summary.paidAmount, currency)}（{summary.paidCount}{" "}
              期）
            </span>
            <span className="text-warning-muted-foreground">
              待收 {money(summary.pendingAmount, currency)}（
              {summary.pendingCount} 期）
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
                    金额
                  </th>
                  <th scope="col" className="p-2">
                    到期日
                  </th>
                  <th scope="col" className="p-2">
                    状态
                  </th>
                  <th scope="col" className="p-2">
                    实收日期
                  </th>
                  <th scope="col" className="p-2">
                    汇兑损益
                  </th>
                  <th scope="col" className="p-2">
                    操作
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((item, index) => (
                  <tr key={item.id} className="border-b last:border-0">
                    <td className="p-2">#{index + 1}</td>
                    <td className="p-2">
                      {SCHEDULE_TYPE_LABEL[item.schedule_type] ??
                        item.schedule_type}
                    </td>
                    <td className="p-2">{pct(item.ratio)}</td>
                    <td className="p-2">
                      {money(item.amount, item.currency ?? currency)}
                    </td>
                    <td className="p-2">
                      {item.due_date?.slice(0, 10) ?? "—"}
                    </td>
                    <td className="p-2">
                      <StatusBadge
                        tone={SCHEDULE_STATUS_TONE[item.status] ?? "default"}
                      >
                        {SCHEDULE_STATUS_LABEL[item.status] ?? item.status}
                      </StatusBadge>
                    </td>
                    <td className="p-2">
                      {item.actual_date?.slice(0, 10) ?? "—"}
                    </td>
                    <td className="p-2">
                      {item.exchange_gain_loss === null ||
                      item.exchange_gain_loss === undefined
                        ? "—"
                        : money(
                            item.exchange_gain_loss,
                            item.currency ?? currency,
                          )}
                    </td>
                    <td className="p-2">
                      <div className="flex gap-1">
                        {item.status !== "paid" && (
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
                ))}
              </tbody>
            </table>
          </div>
        </>
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
    </SectionCard>
  );
}
