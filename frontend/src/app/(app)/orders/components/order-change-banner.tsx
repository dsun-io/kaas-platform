"use client";

/**
 * 已确认订单的明细变更待批横幅 + 申请历史（设计 §6.1 / §9.2）。
 *
 * 审批规则全在内核（ws_approvals.py）：
 *   · 申请人不能自批，除非可批集合只剩他自己（单人团队，审计标注自批）；
 *   · 指定审批人优先，否则团队管理员；管理员可兜底（审计标注 admin_fallback）；
 *   · 批准后才应用行项替换 + 重算金额，并把受影响单证（PI/CI/PL…）回给前端。
 * 前端只做展示与提交，不自行判权 —— 403 的 detail 原样展示。
 */
import { useState } from "react";
import { AlertCircle, Check, X } from "lucide-react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { StatusBadge } from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { normalizeApiError } from "@/lib/api/api-error";
import { formatOrderMoney } from "@/lib/orders/order-detail";
import {
  changeRequestStatusLabel,
  changeRequestStatusTone,
  diffOrderItems,
  ITEM_DIFF_KIND_LABEL,
  itemDiffProductName,
  itemDiffSummaryText,
  pendingChangeRequest,
  sortChangeRequests,
  type OrderItemChangeRequest,
} from "@/lib/orders/item-change";

import { useDecideItemChangeRequest } from "../hooks/use-order-items";

function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return iso.slice(0, 16).replace("T", " ");
}

function affectedDocsText(
  docs: { doc_type: string; doc_no: string }[] | undefined,
): string {
  if (!docs || docs.length === 0) return "";
  return docs.map((doc) => doc.doc_no || doc.doc_type).join("、");
}

export function OrderChangeBanner({
  orderId,
  currency,
  requests,
}: {
  orderId: number;
  currency: string | null;
  requests: OrderItemChangeRequest[];
}) {
  const decide = useDecideItemChangeRequest(orderId);
  const pending = pendingChangeRequest(requests);
  const history = sortChangeRequests(requests);
  const [approveOpen, setApproveOpen] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (!pending && history.length === 0) return null;

  const rows = pending ? diffOrderItems(pending.snapshot, pending.items) : [];
  const visibleRows = rows.filter((row) => row.kind !== "unchanged");

  const approve = async () => {
    if (!pending) return;
    setError(null);
    try {
      const result = await decide.mutateAsync({
        requestId: pending.id,
        decision: "approve",
      });
      setApproveOpen(false);
      const docs = affectedDocsText(result.affected_docs);
      toast.success(
        docs
          ? `变更已批准并应用；受影响单证需重开/作废：${docs}`
          : "变更已批准并应用，订单金额已重算",
      );
    } catch (err) {
      setError(normalizeApiError(err).message);
    }
  };

  const reject = async () => {
    if (!pending) return;
    if (!rejectReason.trim()) {
      setError("拒绝必须填写理由（申请人要据此修改）");
      return;
    }
    setError(null);
    try {
      await decide.mutateAsync({
        requestId: pending.id,
        decision: "reject",
        reason: rejectReason.trim(),
      });
      setRejecting(false);
      setRejectReason("");
      toast.success("已拒绝该变更申请，订单保持原样");
    } catch (err) {
      setError(normalizeApiError(err).message);
    }
  };

  return (
    <div className="mb-4 space-y-3">
      {pending && (
        <div
          aria-label="待审批的明细变更"
          className="rounded-lg border border-warning/40 bg-warning-muted px-3 py-3 text-sm text-warning-muted-foreground"
        >
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge tone="warning">有变更待批</StatusBadge>
            <span>
              申请 #{pending.id} · 发起人 #{pending.requested_by ?? "—"} ·{" "}
              {fmtTime(pending.created_at)}
            </span>
            <span className="ml-auto text-xs">{itemDiffSummaryText(rows)}</span>
          </div>
          {pending.reason && (
            <p className="mt-1 text-xs">变更原因：{pending.reason}</p>
          )}

          <div className="mt-2 overflow-x-auto rounded-md bg-white/60">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th scope="col" className="p-2">
                    变更
                  </th>
                  <th scope="col" className="p-2">
                    产品
                  </th>
                  <th scope="col" className="p-2">
                    变化（旧 → 新）
                  </th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.length === 0 ? (
                  <tr>
                    <td className="p-2 text-muted-foreground" colSpan={3}>
                      申请的新旧明细完全一致（可能是重复提交），请核实后再批准。
                    </td>
                  </tr>
                ) : (
                  visibleRows.map((row) => (
                    <tr key={row.key} className="border-b last:border-0">
                      <td className="p-2">
                        <StatusBadge
                          tone={
                            row.kind === "added"
                              ? "success"
                              : row.kind === "removed"
                                ? "danger"
                                : "warning"
                          }
                          className="h-5 px-2 text-[11px]"
                        >
                          {ITEM_DIFF_KIND_LABEL[row.kind]}
                        </StatusBadge>
                      </td>
                      <td className="p-2">{itemDiffProductName(row)}</td>
                      <td className="p-2">
                        {row.kind === "added" && (
                          <span>
                            {row.after?.qty ?? "—"} {row.after?.qty_unit ?? ""}{" "}
                            ×{" "}
                            {formatOrderMoney(row.after?.unit_price, currency)}{" "}
                            ={" "}
                            {formatOrderMoney(row.after?.line_amount, currency)}
                          </span>
                        )}
                        {row.kind === "removed" && (
                          <span>
                            移除 {row.before?.qty ?? "—"}{" "}
                            {row.before?.qty_unit ?? ""} ×{" "}
                            {formatOrderMoney(row.before?.unit_price, currency)}
                          </span>
                        )}
                        {row.kind === "changed" && (
                          <ul className="space-y-0.5">
                            {row.changes.map((change) => (
                              <li key={change.field}>
                                {change.label}：{change.before || "—"} →{" "}
                                {change.after || "—"}
                              </li>
                            ))}
                          </ul>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {error && (
            <p
              role="alert"
              className="mt-2 flex items-center gap-1 text-xs text-destructive"
            >
              <AlertCircle className="size-3.5" />
              {error}
            </p>
          )}

          {rejecting ? (
            <div className="mt-2 space-y-2">
              <Textarea
                aria-label="拒绝理由"
                className="min-h-[56px] bg-white text-sm"
                placeholder="拒绝必须填写理由：申请人据此修改后重新提交"
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={decide.isPending}
                  onClick={() => void reject()}
                >
                  提交拒绝
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={decide.isPending}
                  onClick={() => {
                    setRejecting(false);
                    setError(null);
                  }}
                >
                  取消
                </Button>
              </div>
            </div>
          ) : (
            <div className="mt-2 flex flex-wrap gap-2">
              <Button size="sm" onClick={() => setApproveOpen(true)}>
                <Check className="mr-1 size-3.5" />
                批准并应用
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setError(null);
                  setRejecting(true);
                }}
              >
                <X className="mr-1 size-3.5" />
                拒绝
              </Button>
              <span className="self-center text-[11px]">
                仅审批人/管理员可操作；申请人不能自批（单人团队除外，内核会标注）。
              </span>
            </div>
          )}
        </div>
      )}

      {history.length > 0 && (
        <div className="rounded-lg border border-border/70 px-3 py-2">
          <p className="text-xs font-medium text-muted-foreground">
            明细变更历史（{history.length}）
          </p>
          <ul className="mt-1 divide-y divide-border/60">
            {history.map((row) => (
              <li
                key={row.id}
                className="flex flex-wrap items-center gap-2 py-1.5 text-xs"
              >
                <span className="text-muted-foreground">#{row.id}</span>
                <StatusBadge
                  tone={changeRequestStatusTone(row.status)}
                  className="h-5 px-2 text-[11px]"
                >
                  {changeRequestStatusLabel(row.status)}
                </StatusBadge>
                {row.reason && (
                  <span className="truncate">原因：{row.reason}</span>
                )}
                <span className="ml-auto tabular-nums text-muted-foreground">
                  {fmtTime(row.created_at)}
                  {row.decided_at ? ` · 处理 ${fmtTime(row.decided_at)}` : ""}
                  {row.decision_reason
                    ? ` · 审批说明：${row.decision_reason}`
                    : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <ConfirmDialog
        open={approveOpen}
        onOpenChange={setApproveOpen}
        title="批准并应用这份明细变更？"
        description="批准后立即整批替换货物明细并重算订单总额/金额构成。若该订单已开 PI/CI/PL 等单证，相关单证需要重开或作废（后端会在结果里列出受影响单证）。"
        confirmLabel="批准并应用"
        pending={decide.isPending}
        error={error}
        danger={false}
        onConfirm={() => void approve()}
      />
    </div>
  );
}
