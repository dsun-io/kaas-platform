"use client";

/**
 * 询盘详情抽屉：基本信息 / 产品行与渠道编辑 / 报价历史 / 关联订单 / 阶段时间线。
 *
 * 数据一次来自 `GET /api/v1/inquiries/{id}`（内核把 quotes / orders / stage_log /
 * counts 都放在同一个响应里，避免逐条点开再打 N 次接口）。
 *
 * 编辑口径（PATCH /inquiries/{id}）：
 *  · 渠道只能**换成另一个枚举值**，不能清空（内核 validate_enum 不收空值）——
 *    前端直接把原因显示出来，而不是发一个必然 422 的请求；
 *  · 产品行整体替换（后端把第一行同步回旧标量字段）；空行丢弃；
 *  · 编号在「已生成报价」后锁定（内核 409 INQUIRY_NO_LOCKED），按钮直接不显示。
 *
 * 关闭/重开走状态机：unquoted/quoted → closed；closed → quoted（有报价）/unquoted。
 * 非法流转后端 409 ILLEGAL_TRANSITION，错误原文透出到确认弹窗里。
 */
import { useState } from "react";
import Link from "next/link";
import type { Route } from "next";
import { AlertCircle, Pencil } from "lucide-react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { DetailDrawer } from "@/components/shared/detail-drawer";
import { LoadingBlock } from "@/components/shared/loading-block";
import { NumberEditDialog } from "@/components/shared/number-edit-dialog";
import { StatusBadge } from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
import { normalizeApiError } from "@/lib/api/api-error";
import {
  buildInquiryUpdatePayload,
  draftFromDetail,
  hasInquiryPatch,
  type InquiryEditDraft,
} from "@/lib/inquiries/edit";
import { inquiryQuoteHref } from "@/lib/inquiries/filters";
import { channelLabel, formatInquiryDateTime } from "@/lib/inquiries/format";
import {
  canCloseInquiry,
  inquiryStatusLabel,
  inquiryStatusTone,
  reopenStatus,
  resolveInquiryStage,
} from "@/lib/inquiries/stage";
import type { InquiryDetail } from "@/lib/inquiries/types";

import { useInquiryDetail, useUpdateInquiry } from "../hooks/use-inquiries";

import { InquiryItemsEditor } from "./inquiry-items-editor";
import { InquiryOrdersPanel } from "./inquiry-orders-panel";
import { InquiryQuoteHistory } from "./inquiry-quote-history";
import { InquiryStageTimeline } from "./inquiry-stage-timeline";

const QUOTE_LINK_CLASS =
  "inline-flex h-8 items-center rounded-lg border border-border bg-white/70 px-3 text-xs font-medium text-primary transition-colors hover:bg-white";

const CHANNEL_OPTIONS: { value: string; label: string }[] = [
  { value: "email", label: "邮件" },
  { value: "whatsapp", label: "WhatsApp" },
  { value: "alibaba", label: "阿里巴巴" },
  { value: "expo", label: "展会" },
  { value: "website", label: "官网" },
  { value: "phone", label: "电话" },
  { value: "referral", label: "转介绍" },
  { value: "other", label: "其他" },
];

export function InquiryDetailDrawer({
  inquiryId,
  onClose,
}: {
  inquiryId: number;
  onClose: () => void;
}) {
  const detail = useInquiryDetail(inquiryId);

  if (detail.isLoading) {
    return (
      <DetailDrawer
        open
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
        title="询盘详情"
      >
        <LoadingBlock rows={6} />
      </DetailDrawer>
    );
  }

  if (detail.isError || !detail.data) {
    return (
      <DetailDrawer
        open
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
        title="询盘详情"
      >
        <p className="flex items-center gap-2 py-4 text-sm text-destructive">
          <AlertCircle className="size-4" />
          询盘详情读取失败。请刷新重试。
        </p>
      </DetailDrawer>
    );
  }

  // key 按 id 重置本地草稿：切到另一条询盘时不会带着上一条的编辑内容
  return (
    <InquiryDetailContent
      key={detail.data.id}
      detail={detail.data}
      onClose={onClose}
    />
  );
}

function InquiryDetailContent({
  detail,
  onClose,
}: {
  detail: InquiryDetail;
  onClose: () => void;
}) {
  const update = useUpdateInquiry();
  const [draft, setDraft] = useState<InquiryEditDraft>(() =>
    draftFromDetail(detail),
  );
  const [formError, setFormError] = useState<string | null>(null);
  const [numberEditOpen, setNumberEditOpen] = useState(false);
  const [numberError, setNumberError] = useState<string | null>(null);
  const [statusAction, setStatusAction] = useState<"close" | "reopen" | null>(
    null,
  );
  const [statusError, setStatusError] = useState<string | null>(null);

  const stage = resolveInquiryStage(detail.stage, detail.status);
  const hasQuotes = detail.quotes.length > 0;
  const canClose = canCloseInquiry(detail.status);
  const reopenTo = reopenStatus(detail.status, hasQuotes);
  const latestQuoteAt = detail.quotes.reduce<string | null>((latest, quote) => {
    if (!quote.created_at) return latest;
    if (!latest) return quote.created_at;
    return quote.created_at > latest ? quote.created_at : latest;
  }, null);

  const plan = buildInquiryUpdatePayload(detail, draft);
  const dirty = plan.error === null && hasInquiryPatch(plan.patch);
  const saveDisabled = update.isPending || !dirty;

  const saveEdit = async () => {
    if (plan.error) {
      setFormError(plan.error);
      return;
    }
    if (!hasInquiryPatch(plan.patch)) return;
    setFormError(null);
    try {
      await update.mutateAsync({ id: detail.id, patch: plan.patch });
      toast.success("询盘已保存（渠道/产品行已更新）");
    } catch (error) {
      setFormError(normalizeApiError(error).message);
    }
  };

  const confirmStatus = async () => {
    const target =
      statusAction === "close"
        ? "closed"
        : statusAction === "reopen"
          ? reopenTo
          : null;
    if (!target) return;
    setStatusError(null);
    try {
      await update.mutateAsync({ id: detail.id, patch: { status: target } });
      toast.success(
        statusAction === "close"
          ? "询盘已关闭（阶段记为「关闭」）"
          : "询盘已重新打开",
      );
      setStatusAction(null);
    } catch (error) {
      setStatusError(normalizeApiError(error).message);
    }
  };

  const saveInquiryNo = async (value: string) => {
    setNumberError(null);
    try {
      await update.mutateAsync({ id: detail.id, patch: { inquiry_no: value } });
      toast.success("询盘编号已更新");
      setNumberEditOpen(false);
    } catch (error) {
      setNumberError(normalizeApiError(error).message);
    }
  };

  return (
    <>
      <DetailDrawer
        open
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
        widthClassName="sm:max-w-3xl"
        title={`询盘 ${detail.inquiry_no ?? `#${detail.id}`}`}
        description={`${detail.company_name ?? "—"} · 创建于 ${formatInquiryDateTime(
          detail.created_at,
        )}`}
        footer={
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <Link
                href={inquiryQuoteHref(detail) as Route}
                className={QUOTE_LINK_CLASS}
                aria-label={`为此询盘 ${detail.inquiry_no ?? detail.id} 报价`}
              >
                {hasQuotes ? "重新报价 →" : "为此询盘报价 →"}
              </Link>
              {canClose ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setStatusError(null);
                    setStatusAction("close");
                  }}
                >
                  关闭询盘
                </Button>
              ) : reopenTo ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setStatusError(null);
                    setStatusAction("reopen");
                  }}
                >
                  重新打开询盘
                </Button>
              ) : null}
            </div>
            <Button size="sm" variant="outline" onClick={onClose}>
              关闭详情
            </Button>
          </div>
        }
      >
        <div className="space-y-6">
          <section aria-labelledby="inquiry-basic-title" className="space-y-3">
            <h4 id="inquiry-basic-title" className="text-sm font-semibold">
              基本信息
            </h4>
            <div className="grid gap-3 text-sm sm:grid-cols-2">
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">阶段</span>
                <StatusBadge tone={stage.tone}>{stage.label}</StatusBadge>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">状态</span>
                <StatusBadge tone={inquiryStatusTone(detail.status)}>
                  {inquiryStatusLabel(detail.status)}
                </StatusBadge>
              </div>
              <div>
                <span className="text-muted-foreground">客户</span>
                <span className="ml-2">{detail.company_name ?? "—"}</span>
              </div>
              <div>
                <span className="text-muted-foreground">渠道</span>
                <span className="ml-2">{channelLabel(detail.channel)}</span>
              </div>
              <div>
                <span className="text-muted-foreground">报价数</span>
                <span className="ml-2 tabular-nums">
                  {detail.counts.quotes}
                </span>
              </div>
              <div>
                <span className="text-muted-foreground">关联订单</span>
                <span className="ml-2 tabular-nums">
                  {detail.counts.orders}（进行中 {detail.counts.open_orders}）
                </span>
              </div>
              <div>
                <span className="text-muted-foreground">最近报价</span>
                <span className="ml-2">
                  {formatInquiryDateTime(latestQuoteAt)}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">询盘编号</span>
                <span className="font-mono text-xs">
                  {detail.inquiry_no ?? "—"}
                </span>
                {hasQuotes ? (
                  <span className="text-[11px] text-muted-foreground">
                    （已生成报价，编号锁定）
                  </span>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setNumberError(null);
                      setNumberEditOpen(true);
                    }}
                  >
                    <Pencil className="mr-1 size-3.5" />
                    改编号
                  </Button>
                )}
              </div>
            </div>
          </section>

          <section aria-labelledby="inquiry-edit-title" className="space-y-3">
            <h4 id="inquiry-edit-title" className="text-sm font-semibold">
              渠道与产品行
            </h4>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              渠道
              <select
                aria-label="编辑渠道"
                className="h-9 w-full max-w-[16rem] rounded-md border border-input bg-background px-2 text-sm"
                value={draft.channel}
                disabled={update.isPending}
                onChange={(e) =>
                  setDraft((prev) => ({ ...prev, channel: e.target.value }))
                }
              >
                {!detail.channel ? <option value="">未填写</option> : null}
                {CHANNEL_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <InquiryItemsEditor
              rows={draft.items}
              disabled={update.isPending}
              onChange={(items) => setDraft((prev) => ({ ...prev, items }))}
            />
            {plan.error || formError ? (
              <p role="alert" className="text-xs text-destructive">
                {formError ?? plan.error}
              </p>
            ) : null}
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                disabled={saveDisabled}
                onClick={() => void saveEdit()}
              >
                {update.isPending ? "保存中…" : "保存修改"}
              </Button>
              {!dirty && !plan.error ? (
                <span className="text-xs text-muted-foreground">暂无改动</span>
              ) : null}
            </div>
          </section>

          <section aria-labelledby="inquiry-quotes-title" className="space-y-3">
            <h4 id="inquiry-quotes-title" className="text-sm font-semibold">
              报价历史（{detail.quotes.length}）
            </h4>
            <InquiryQuoteHistory quotes={detail.quotes} />
          </section>

          <section aria-labelledby="inquiry-orders-title" className="space-y-3">
            <h4 id="inquiry-orders-title" className="text-sm font-semibold">
              关联订单（{detail.orders.length}）
            </h4>
            <InquiryOrdersPanel orders={detail.orders} />
          </section>

          <section
            aria-labelledby="inquiry-stage-log-title"
            className="space-y-3"
          >
            <h4 id="inquiry-stage-log-title" className="text-sm font-semibold">
              阶段时间线
            </h4>
            <InquiryStageTimeline logs={detail.stage_log} />
          </section>
        </div>
      </DetailDrawer>

      <NumberEditDialog
        open={numberEditOpen}
        onOpenChange={(open) => {
          if (!open) setNumberEditOpen(false);
        }}
        title="修改询盘编号"
        label="询盘编号"
        currentValue={detail.inquiry_no ?? ""}
        description="询盘编号默认自动生成；生成报价之前可以修改。"
        warning="确认后编号立即生效。一旦生成报价单，该编号将自动锁定。"
        pending={update.isPending}
        error={numberError}
        onConfirm={(value) => void saveInquiryNo(value)}
      />

      <ConfirmDialog
        open={statusAction !== null}
        onOpenChange={(open) => {
          if (!open) setStatusAction(null);
        }}
        title={statusAction === "close" ? "关闭询盘？" : "重新打开询盘？"}
        description={
          statusAction === "close"
            ? "关闭后询盘进入终态：阶段记为「关闭」（会写一条阶段流水），状态流转只能再「重新打开」。"
            : `重新打开后状态回到「${
                reopenTo === "quoted" ? "已报价" : "待报价"
              }」；阶段不会回退（后端重开不回收 stage）。`
        }
        confirmLabel={statusAction === "close" ? "关闭询盘" : "重新打开"}
        pending={update.isPending}
        error={statusError}
        onConfirm={() => void confirmStatus()}
      />
    </>
  );
}
