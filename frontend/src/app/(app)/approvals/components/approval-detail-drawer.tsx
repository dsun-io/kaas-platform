"use client";

/**
 * 变更申请详情抽屉：新旧明细对比 / 原因 / 受影响单证 / 批准 / 拒绝。
 *
 * 数据来源：`GET /approvals` 的行本身已带**新旧明细**（内核 `_request_dict` 同时回
 * items 与 snapshot）与**受影响单证**（A2 起 `affected_docs` 由聚合接口整页一次查完），
 * 因此详情不再发任何额外请求。`affected_docs` 缺失（旧后端行）时，
 * `useOrderAffectedDocs` 作为兜底改查 `GET /trade-docs?order_id=`。
 *
 * 权限：批准/拒绝按钮只在「待我审批」视图出现（后端再判一次权，前端不猜）；
 * 自批由内核裁决（默认禁、单人团队放行并标注），前端只给提示不隐藏按钮，
 * 否则单人团队管理员会彻底无法处理自己的申请。
 */
import Link from "next/link";
import { useState } from "react";
import { AlertCircle, CheckCheck, XCircle } from "lucide-react";
import { toast } from "sonner";

import { DocChip } from "@/components/doc-chip";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { DetailDrawer } from "@/components/shared/detail-drawer";
import { StatusBadge } from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { normalizeApiError } from "@/lib/api/api-error";
import {
  formatDateTime,
  formatMoney,
  changeStatusMeta,
  orderStatusLabel,
  orderStatusTone,
} from "@/lib/approvals/format";
import {
  useDecideChangeRequest,
  useOrderAffectedDocs,
} from "@/lib/approvals/use-approvals";
import type { AffectedDoc, ApprovalItem } from "@/lib/approvals/types";

import { ChangeDiffTable } from "./change-diff-table";
import { RejectReasonDialog } from "./reject-reason-dialog";

export function ApprovalDetailDrawer({
  item,
  canDecide,
  currentUserId,
  onClose,
}: {
  item: ApprovalItem | null;
  /** true = 当前视图里"我能处理"（待我审批）且申请仍 pending */
  canDecide: boolean;
  currentUserId: number | null;
  onClose: () => void;
}) {
  const decide = useDecideChangeRequest();
  // A2 优先：聚合行内 affected_docs（数组，可能是 []）就是权威答案；
  // 只有字段缺失（Array.isArray === false：旧后端 undefined/null）才回退拉单证。
  const rowAffectedDocs: AffectedDoc[] | null =
    item !== null && Array.isArray(item.affected_docs)
      ? item.affected_docs
      : null;
  const needsFallbackDocs = item !== null && rowAffectedDocs === null;
  const docs = useOrderAffectedDocs(
    needsFallbackDocs ? (item?.order_id ?? null) : null,
  );
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [decisionError, setDecisionError] = useState<string | null>(null);

  if (!item) return null;

  const status = changeStatusMeta(item.status);
  const isPending = item.status === "pending";
  const selfSubmitted =
    currentUserId !== null && item.requested_by === currentUserId;
  const affectedDocs = rowAffectedDocs ?? docs.data ?? [];
  const docsLoading = needsFallbackDocs && docs.isLoading;
  const docsError = needsFallbackDocs && docs.isError;

  const closeAll = () => {
    setConfirmOpen(false);
    setRejectOpen(false);
    setDecisionError(null);
    onClose();
  };

  const approve = async () => {
    setDecisionError(null);
    try {
      const result = await decide.mutateAsync({
        orderId: item.order_id,
        requestId: item.id,
        action: "approve",
      });
      // 批准响应里的 affected_docs 是"批准后真正受影响的单证"（与行内预览可能不同：
      // 审批途中可能又开了新单证）。有就明说张数，提醒复核重开。
      const affectedCount = result.affected_docs.length;
      toast.success(
        affectedCount > 0
          ? `已批准：订单金额更新为 ${formatMoney(result.new_total_amount, item.order_currency)}；${affectedCount} 张已开单证需复核重开`
          : `已批准：订单金额更新为 ${formatMoney(result.new_total_amount, item.order_currency)}`,
      );
      closeAll();
    } catch (error) {
      setDecisionError(normalizeApiError(error).message);
    }
  };

  const reject = async (reason: string) => {
    setDecisionError(null);
    try {
      await decide.mutateAsync({
        orderId: item.order_id,
        requestId: item.id,
        action: "reject",
        reason,
      });
      toast.success("已拒绝该变更申请，并已通知申请人");
      closeAll();
    } catch (error) {
      setDecisionError(normalizeApiError(error).message);
    }
  };

  const confirmDescription = () => {
    const base =
      "批准后立即把新明细应用到订单并重算金额（已收到款的应收金额不会被改写）；此操作会留痕。";
    if (docsLoading) return `${base} 正在读取受影响单证…`;
    if (docsError)
      return `${base} 受影响单证读取失败：可在「单证」工位人工确认。`;
    if (affectedDocs.length === 0) {
      return `${base} 该订单没有已开单证，无需重开。`;
    }
    const list = affectedDocs
      .map((doc) => `${doc.doc_no ?? `#${doc.id}`}（${doc.status ?? "—"}）`)
      .join("、");
    return `${base} 受影响单证需人工复核/重开：${list}`;
  };

  return (
    <>
      <DetailDrawer
        open
        onOpenChange={(next) => {
          if (!next) closeAll();
        }}
        title={`变更申请 #${item.id}`}
        description={
          <span className="inline-flex flex-wrap items-center gap-2">
            <span>{item.order_no ?? `订单 #${item.order_id}`}</span>
            <StatusBadge tone={orderStatusTone(item.order_status)} dot={false}>
              {orderStatusLabel(item.order_status)}
            </StatusBadge>
            <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
          </span>
        }
        widthClassName="sm:max-w-2xl"
        footer={
          isPending && canDecide ? (
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={decide.isPending}
                onClick={() => {
                  setDecisionError(null);
                  setConfirmOpen(true);
                }}
              >
                <CheckCheck className="mr-1 size-4" />
                批准
              </Button>
              <Button
                variant="destructive"
                size="sm"
                disabled={decide.isPending}
                onClick={() => {
                  setDecisionError(null);
                  setRejectOpen(true);
                }}
              >
                <XCircle className="mr-1 size-4" />
                拒绝
              </Button>
            </div>
          ) : isPending ? (
            <p className="text-xs leading-relaxed text-muted-foreground">
              只有该订单的路由审批人（或团队管理员）可以处理；你可以在「我发起的」里跟踪进度。
            </p>
          ) : (
            <p className="text-xs leading-relaxed text-muted-foreground">
              该申请已处理（{status.label}），订单不会再应用这份明细。
            </p>
          )
        }
      >
        <div className="space-y-5">
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-muted-foreground">申请人</dt>
              <dd className="font-medium">
                {item.requester_name ??
                  (item.requested_by !== null ? `#${item.requested_by}` : "—")}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">提交时间</dt>
              <dd className="font-medium" title={item.created_at ?? undefined}>
                {formatDateTime(item.created_at)}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">订单金额（当前）</dt>
              <dd className="font-medium tabular-nums">
                {formatMoney(item.order_total_amount, item.order_currency)}
              </dd>
            </div>
            {!isPending ? (
              <>
                <div>
                  <dt className="text-muted-foreground">处理时间</dt>
                  <dd
                    className="font-medium"
                    title={item.decided_at ?? undefined}
                  >
                    {formatDateTime(item.decided_at)}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">处理人</dt>
                  <dd className="font-medium">
                    {item.decided_by !== null ? `#${item.decided_by}` : "—"}
                  </dd>
                </div>
              </>
            ) : null}
          </dl>

          {selfSubmitted && isPending ? (
            <p className="rounded-lg border border-warning/40 bg-warning-muted px-3 py-2 text-xs leading-relaxed text-warning-muted-foreground">
              这是你提交的申请：默认不能自批（单人团队由内核放行并在审计标注「自批」）。
            </p>
          ) : null}

          <section>
            <h3 className="text-sm font-semibold">变更原因</h3>
            {item.reason ? (
              <p className="mt-1 whitespace-pre-wrap rounded-lg border bg-muted/30 px-3 py-2 text-sm">
                {item.reason}
              </p>
            ) : (
              <p className="mt-1 text-sm text-muted-foreground">
                申请人未填写原因。
              </p>
            )}
          </section>

          {item.decision_reason ? (
            <section>
              <h3 className="text-sm font-semibold">处理意见</h3>
              <p className="mt-1 whitespace-pre-wrap rounded-lg border bg-muted/30 px-3 py-2 text-sm">
                {item.decision_reason}
              </p>
            </section>
          ) : null}

          <section>
            <h3 className="text-sm font-semibold">新旧明细对比</h3>
            <div className="mt-2">
              <ChangeDiffTable before={item.snapshot} after={item.items} />
            </div>
          </section>

          <section>
            <h3 className="text-sm font-semibold">受影响单证</h3>
            <div className="mt-2">
              {docsLoading ? (
                <div
                  className="space-y-1.5"
                  aria-busy="true"
                  aria-label="受影响单证加载中"
                >
                  <Skeleton className="h-6 w-40" />
                  <Skeleton className="h-6 w-56" />
                </div>
              ) : docsError ? (
                <p
                  role="alert"
                  className="flex items-center gap-2 text-sm text-destructive"
                >
                  <AlertCircle className="size-4" />
                  单证清单读取失败；可在「单证」工位确认。该项不阻断审批。
                </p>
              ) : affectedDocs.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  该订单还没有已开单证；批准后无需重开单证。
                </p>
              ) : (
                <>
                  <p className="text-xs text-muted-foreground">
                    批准后这些单证可能与货不对板，需人工复核/重开：
                  </p>
                  <ul className="mt-1.5 flex flex-wrap gap-1.5">
                    {affectedDocs.map((doc) => (
                      <li key={doc.id}>
                        <Link
                          href={`/trade-docs?doc=${doc.id}`}
                          className="inline-flex"
                        >
                          <DocChip
                            docType={doc.doc_type}
                            docNo={doc.doc_no ?? `#${doc.id}`}
                            status={doc.status}
                          />
                        </Link>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          </section>
        </div>
      </DetailDrawer>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={(next) => {
          if (!next) {
            setConfirmOpen(false);
            setDecisionError(null);
          }
        }}
        title="批准这份变更申请？"
        description={confirmDescription()}
        confirmLabel="确认批准"
        danger={false}
        pending={decide.isPending}
        error={decisionError}
        onConfirm={() => void approve()}
      />

      <RejectReasonDialog
        open={rejectOpen}
        onOpenChange={(next) => {
          if (!next) {
            setRejectOpen(false);
            setDecisionError(null);
          }
        }}
        description="拒绝后订单原样不动；理由会随站内通知发给申请人。"
        pending={decide.isPending}
        error={decisionError}
        onSubmit={(reason) => void reject(reason)}
      />
    </>
  );
}
