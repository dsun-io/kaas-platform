"use client";

/**
 * 询盘 → 后续单据（报价单 / 订单 / 单证）的**扁平化**展示。
 *
 * 2026-10-20 第二轮用户反馈后的信息设计：
 *  - 询盘条目只放摘要（询盘编号 / 产品 / 状态 / 最新一步），完整询盘信息进展开详情；
 *  - 有订单 = 询盘直接标「已成交」+ 最新订单状态（不再显示过时的「已报价」）；
 *  - 展开后不再画「报价 → 单证 chips → 订单 → 单证 chips」的嵌套树：
 *    报价单/订单只在头部说一次，**单证统一扁平列表**，按生成时间倒序；
 *    每行提取「类型 / 编号 / 状态 / 金额 / 时间」，编号只写一次。
 *  - 单证可点击预览：跳 /trade-docs?doc=<id>（复用单证工位的完整预览）。
 *  - 没有询盘来源的历史单据收在询盘 tab 底部，默认折叠，不会丢。
 */
import { ArrowUpRight } from "lucide-react";
import { useState } from "react";

import { StatusBadge, type StatusTone } from "@/components/shared";
import { docStatusLabel, docTypeMeta } from "@/components/doc-chip";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type {
  CustomerRecordsDirect,
  RecordDocument,
  RecordQuote,
} from "@/lib/customer/customer-records";

const QUOTE_STATUS_LABEL: Record<string, string> = {
  draft: "草稿",
  sent: "已发出",
  accepted: "已接受",
  rejected: "已拒绝",
  expired: "已过期",
  closed: "已关闭",
};

const QUOTE_STATUS_TONE: Record<string, StatusTone> = {
  draft: "default",
  sent: "info",
  accepted: "success",
  rejected: "danger",
  expired: "warning",
  closed: "default",
};

const ORDER_STATUS_LABEL: Record<string, string> = {
  pending: "待确认",
  confirmed: "已确认",
  producing: "生产中",
  shipped: "已出运",
  completed: "已完成",
  cancelled: "已取消",
};

const ORDER_STATUS_TONE: Record<string, StatusTone> = {
  pending: "warning",
  confirmed: "info",
  producing: "info",
  shipped: "success",
  completed: "success",
  cancelled: "danger",
};

const DOC_STATUS_TONE: Record<string, StatusTone> = {
  draft: "default",
  issued: "success",
  void: "danger",
};

function money(amount: number | null, currency: string | null): string {
  if (amount === null) return "—";
  const value = amount.toLocaleString("en-US", { minimumFractionDigits: 2 });
  return currency ? `${currency} ${value}` : value;
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString("zh-CN");
}

function byDateDesc(
  a: { created_at: string | null },
  b: { created_at: string | null },
): number {
  const ta = a.created_at ? new Date(a.created_at).getTime() : 0;
  const tb = b.created_at ? new Date(b.created_at).getTime() : 0;
  return tb - ta;
}

/** 询盘条目上的「最新业务状态」——纯展示推导，不写回后端询盘 status。 */
export interface InquiryStage {
  label: string;
  tone: StatusTone;
  /** 最新一步的补充信息（订单号/报价单号 + 状态） */
  hint: string | null;
}

export function deriveInquiryStage(
  inquiryStatus: string,
  quotes: RecordQuote[],
  loading: boolean,
): InquiryStage {
  if (inquiryStatus === "closed") {
    return { label: "已关闭", tone: "default", hint: null };
  }
  if (loading) {
    return {
      label: inquiryStatus === "quoted" ? "已报价" : "未报价",
      tone: inquiryStatus === "quoted" ? "info" : "default",
      hint: null,
    };
  }
  const orders = quotes.flatMap((quote) => quote.orders).sort(byDateDesc);
  const latestOrder = orders[0];
  if (latestOrder) {
    return {
      label: "已成交",
      tone: "success",
      hint: `订单 ${latestOrder.order_no} · ${
        ORDER_STATUS_LABEL[latestOrder.status ?? ""] ?? latestOrder.status ?? ""
      }`,
    };
  }
  const latestQuote = [...quotes].sort(byDateDesc)[0];
  if (latestQuote) {
    return {
      label: "已报价",
      tone: "info",
      hint: `报价单 ${latestQuote.quote_no}`,
    };
  }
  return { label: "未报价", tone: "default", hint: null };
}

/** 扁平化单证：报价单自带的 + 订单下的，按生成时间倒序。 */
export function collectDocuments(quotes: RecordQuote[]): RecordDocument[] {
  const docs: RecordDocument[] = [];
  for (const quote of quotes) {
    docs.push(...quote.documents);
    for (const order of quote.orders) docs.push(...order.documents);
  }
  return docs.sort(byDateDesc);
}

/** 单证行：类型 / 编号 / 状态 / 金额 / 时间；点击先看信息，再决定是否打开完整单据。 */
function DocRow({
  doc,
  onPreview,
}: {
  doc: RecordDocument;
  onPreview: (doc: RecordDocument) => void;
}) {
  const meta = docTypeMeta(doc.doc_type);
  const Icon = meta.icon;
  const clickable = doc.id !== null;
  const body = (
    <div className="flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-white/70">
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0">
        <p className="text-sm">{meta.label}</p>
        <p className="truncate font-mono text-[11px] text-muted-foreground">
          {doc.doc_no}
        </p>
      </div>
      <StatusBadge
        tone={DOC_STATUS_TONE[doc.status ?? ""] ?? "default"}
        className="ml-1 h-5 shrink-0 px-2 text-[11px]"
      >
        {docStatusLabel(doc.status) || "—"}
      </StatusBadge>
      <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">
        {money(doc.total_amount, doc.currency)}
      </span>
      <span className="w-20 shrink-0 text-right text-[11px] text-muted-foreground">
        {formatDate(doc.created_at)}
      </span>
      {clickable && (
        <ArrowUpRight className="size-3.5 shrink-0 text-muted-foreground" />
      )}
    </div>
  );
  if (!clickable) {
    return (
      <div className="border-b border-border/60 last:border-0">{body}</div>
    );
  }
  return (
    <button
      type="button"
      onClick={() => onPreview(doc)}
      className="block w-full border-b border-border/60 text-left last:border-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/30"
      title={`预览 ${meta.label} ${doc.doc_no}`}
    >
      {body}
    </button>
  );
}

/** 单证信息预览（先给摘要；完整单据在新标签打开单证工位）。 */
function DocPreviewDialog({
  doc,
  onClose,
}: {
  doc: RecordDocument | null;
  onClose: () => void;
}) {
  const meta = doc ? docTypeMeta(doc.doc_type) : null;
  return (
    <Dialog
      open={doc !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-md rounded-2xl border-white/60 bg-white/90 p-0 backdrop-blur-2xl">
        <DialogHeader className="border-b border-border/60 px-5 py-4">
          <DialogTitle className="text-base">
            {meta?.label ?? "单证"} · {doc?.doc_no}
          </DialogTitle>
          <DialogDescription>单证信息</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3 px-5 py-4 text-sm">
          <span className="text-muted-foreground">状态</span>
          <span>
            <StatusBadge
              tone={DOC_STATUS_TONE[doc?.status ?? ""] ?? "default"}
              className="h-5 px-2 text-[11px]"
            >
              {docStatusLabel(doc?.status) || "—"}
            </StatusBadge>
          </span>
          <span className="text-muted-foreground">金额</span>
          <span className="tabular-nums">
            {money(doc?.total_amount ?? null, doc?.currency ?? null)}
          </span>
          <span className="text-muted-foreground">生成时间</span>
          <span className="tabular-nums">{formatDate(doc?.created_at)}</span>
          <span className="text-muted-foreground">编号</span>
          <span className="font-mono text-xs">{doc?.doc_no ?? "—"}</span>
        </div>
        <DialogFooter className="border-t border-border/60 px-5 py-3">
          {doc?.id != null && (
            <a
              href={`/trade-docs?doc=${doc.id}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-8 items-center rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              在单证工位打开完整单据
            </a>
          )}
          <Button size="sm" variant="outline" onClick={onClose}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DocTable({ docs }: { docs: RecordDocument[] }) {
  const [preview, setPreview] = useState<RecordDocument | null>(null);
  return (
    <div className="overflow-hidden rounded-xl border border-border/70 bg-white/55">
      <div className="flex items-center justify-between border-b border-border/60 px-3 py-2">
        <span className="text-[11px] font-medium text-muted-foreground">
          单证 {docs.length} 份
        </span>
        <span className="text-[11px] text-muted-foreground">
          按生成时间倒序 · 点击预览
        </span>
      </div>
      {docs.length === 0 ? (
        <p className="px-3 py-3 text-xs text-muted-foreground">
          还没有生成单证
        </p>
      ) : (
        docs.map((doc) => (
          <DocRow
            key={`${doc.id ?? "n"}-${doc.doc_no}`}
            doc={doc}
            onPreview={setPreview}
          />
        ))
      )}
      <DocPreviewDialog doc={preview} onClose={() => setPreview(null)} />
    </div>
  );
}

export interface InquiryFollowupProps {
  quotes: RecordQuote[];
  loading: boolean;
  unavailable: boolean;
  onRetry?: () => void;
  emptyText?: string;
}

/** 单条询盘展开后的「报价/订单摘要 + 单证倒序表」。 */
export function InquiryFollowup({
  quotes,
  loading,
  unavailable,
  onRetry,
  emptyText = "该询盘还没有报价单。",
}: InquiryFollowupProps) {
  if (loading) {
    return (
      <p className="py-2 text-xs text-muted-foreground">正在读取后续单据…</p>
    );
  }
  if (unavailable) {
    return (
      <div className="flex flex-wrap items-center gap-2 py-2 text-xs text-muted-foreground">
        <span>后续单据暂时读不到，不影响询盘本身。</span>
        {onRetry && (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-xs"
            onClick={onRetry}
          >
            重试
          </Button>
        )}
      </div>
    );
  }
  if (quotes.length === 0) {
    return <p className="py-2 text-xs text-muted-foreground">{emptyText}</p>;
  }

  const orders = quotes.flatMap((quote) => quote.orders).sort(byDateDesc);
  // quotes.length > 0 已在上面返回，这里一定有值
  const latestQuote = [...quotes].sort(byDateDesc)[0]!;
  const latestOrder = orders[0];
  const docs = collectDocuments(quotes);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span className="text-muted-foreground">报价单</span>
        <span className="font-mono">{latestQuote.quote_no}</span>
        <StatusBadge
          tone={QUOTE_STATUS_TONE[latestQuote.status ?? ""] ?? "default"}
          className="h-5 px-2 text-[11px]"
        >
          {QUOTE_STATUS_LABEL[latestQuote.status ?? ""] ??
            latestQuote.status ??
            "—"}
        </StatusBadge>
        {latestOrder && (
          <>
            <span className="text-muted-foreground">订单</span>
            <span className="font-mono">{latestOrder.order_no}</span>
            <StatusBadge
              tone={ORDER_STATUS_TONE[latestOrder.status ?? ""] ?? "default"}
              className="h-5 px-2 text-[11px]"
            >
              {ORDER_STATUS_LABEL[latestOrder.status ?? ""] ??
                latestOrder.status ??
                "—"}
            </StatusBadge>
          </>
        )}
      </div>
      <DocTable docs={docs} />
    </div>
  );
}

/** 未关联询盘的历史单据（导入 / 手工新建），默认折叠。 */
export function UnlinkedRecords({
  quotes,
  direct,
  loading,
  unavailable,
  onRetry,
}: {
  quotes: RecordQuote[];
  direct: CustomerRecordsDirect;
  loading: boolean;
  unavailable: boolean;
  onRetry?: () => void;
}) {
  const orders = [...direct.orders].sort(byDateDesc);
  const docs = [...direct.documents].sort(byDateDesc);
  const total = quotes.length + orders.length + docs.length;
  if (!loading && !unavailable && total === 0) return null;

  return (
    <details className="rounded-xl border border-dashed border-border/80 bg-white/40 px-4 py-3">
      <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
        未关联询盘的单据
        <span className="ml-2 font-normal">
          {loading
            ? "读取中…"
            : unavailable
              ? "暂时读不到"
              : `${quotes.length} 张报价单 · ${orders.length} 个订单 · ${docs.length} 份单证`}
        </span>
      </summary>
      <p className="mt-2 text-[11px] text-muted-foreground">
        历史导入或手工新建的单据没有询盘来源，单独放这里，不会丢失。
      </p>
      <div className="mt-3 space-y-2">
        {loading ? (
          <p className="text-xs text-muted-foreground">正在读取…</p>
        ) : unavailable ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>暂时读不到这些单据。</span>
            {onRetry && (
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-xs"
                onClick={onRetry}
              >
                重试
              </Button>
            )}
          </div>
        ) : (
          <>
            {quotes.map((quote) => (
              <div
                key={`q-${quote.id ?? quote.quote_no}`}
                className="flex flex-wrap items-center gap-2 rounded-lg border border-border/60 bg-white/60 px-3 py-2 text-xs"
              >
                <span className="text-muted-foreground">报价单</span>
                <span className="font-mono">{quote.quote_no}</span>
                <StatusBadge
                  tone={QUOTE_STATUS_TONE[quote.status ?? ""] ?? "default"}
                  className="h-5 px-2 text-[11px]"
                >
                  {QUOTE_STATUS_LABEL[quote.status ?? ""] ??
                    quote.status ??
                    "—"}
                </StatusBadge>
                <span className="ml-auto tabular-nums text-muted-foreground">
                  {money(quote.total_amount, quote.currency)} ·{" "}
                  {formatDate(quote.created_at)}
                </span>
              </div>
            ))}
            {orders.map((order) => (
              <div
                key={`o-${order.id ?? order.order_no}`}
                className="flex flex-wrap items-center gap-2 rounded-lg border border-border/60 bg-white/60 px-3 py-2 text-xs"
              >
                <span className="text-muted-foreground">订单</span>
                <span className="font-mono">{order.order_no}</span>
                <StatusBadge
                  tone={ORDER_STATUS_TONE[order.status ?? ""] ?? "default"}
                  className="h-5 px-2 text-[11px]"
                >
                  {ORDER_STATUS_LABEL[order.status ?? ""] ??
                    order.status ??
                    "—"}
                </StatusBadge>
                <span className="ml-auto tabular-nums text-muted-foreground">
                  {money(order.total_amount, order.currency)} ·{" "}
                  {formatDate(order.created_at)}
                </span>
              </div>
            ))}
            {docs.length > 0 && <DocTable docs={docs} />}
          </>
        )}
      </div>
    </details>
  );
}
