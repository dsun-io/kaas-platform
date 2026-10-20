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
import { ArrowUpRight, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { StatusBadge, type StatusTone } from "@/components/shared";
import { docStatusLabel, docTypeMeta } from "@/components/doc-chip";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { apiClient } from "@/lib/api/client";
import { useTeam } from "@/lib/team/team-context";
import {
  DocPreview,
  renderMetaOf,
} from "../../trade-docs/components/doc-preview";
import {
  useTradeDocFiles,
  useTradeDocRenderData,
} from "../../trade-docs/hooks/use-trade-docs";
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

/** 产品名拆分：列表只显示产品名，规格参数进详情。 */
export function splitProductName(raw: string | null): {
  name: string;
  spec: string | null;
} {
  if (!raw || raw.trim() === "") return { name: "未填写产品", spec: null };
  const value = raw.trim();
  const specRe =
    /\d+(?:\.\d+)?\s*(?:mm|cm|m2|m²|㎡|目|卷|吨|kg|g|inch|in)\b|\s*[×xX*]\s*\d/i;
  const match = value.match(specRe);
  if (!match || match.index === undefined) return { name: value, spec: null };
  const name = value.slice(0, match.index).replace(/[\s\-–—·]+$/, "");
  const spec = value
    .slice(match.index)
    .replace(/^[\s\-–—×xX*·]+/, "")
    .trim();
  return { name: name || value, spec: spec || null };
}

/** 询盘条目上的「当前阶段」——纯展示推导，不写回后端询盘 status。 */
export interface InquiryStage {
  label: "询盘" | "报价" | "订单" | "发货" | "完结" | "关闭";
  tone: StatusTone;
  /** 最新一步的补充信息（单号 + 状态） */
  hint: string | null;
}

const SHIP_DOC_TYPES = new Set(["pl", "bl"]);
const ORDER_DOC_TYPES = new Set(["contract", "ci"]);

export function deriveInquiryStage(
  inquiryStatus: string,
  quotes: RecordQuote[],
  loading: boolean,
): InquiryStage {
  if (inquiryStatus === "closed") {
    return { label: "关闭", tone: "default", hint: null };
  }
  if (loading) {
    return {
      label: inquiryStatus === "quoted" ? "报价" : "询盘",
      tone: inquiryStatus === "quoted" ? "info" : "default",
      hint: null,
    };
  }

  const orders = quotes.flatMap((quote) => quote.orders).sort(byDateDesc);
  const docs = collectDocuments(quotes);
  const latestOrder = orders[0];
  const latestDoc = docs[0];

  // 完结：订单已完成（业务终态）
  const completedOrder = orders.find((order) => order.status === "completed");
  if (completedOrder) {
    return {
      label: "完结",
      tone: "success",
      hint: `订单 ${completedOrder.order_no} · 已完成`,
    };
  }

  // 发货：有装箱单/提单，或订单已出运
  const shipDoc = docs.find((doc) => SHIP_DOC_TYPES.has(doc.doc_type));
  const shippedOrder = orders.find((order) => order.status === "shipped");
  if (shipDoc || shippedOrder) {
    return {
      label: "发货",
      tone: "success",
      hint: shipDoc
        ? `${docTypeMeta(shipDoc.doc_type).label} ${shipDoc.doc_no} · ${
            docStatusLabel(shipDoc.status) || ""
          }`
        : `订单 ${shippedOrder!.order_no} · 已出运`,
    };
  }

  // 订单：有销售合同/商业发票，或已存在订单
  const orderDoc = docs.find((doc) => ORDER_DOC_TYPES.has(doc.doc_type));
  if (orderDoc || latestOrder) {
    return {
      label: "订单",
      tone: "info",
      hint: orderDoc
        ? `${docTypeMeta(orderDoc.doc_type).label} ${orderDoc.doc_no} · ${
            docStatusLabel(orderDoc.status) || ""
          }`
        : `订单 ${latestOrder!.order_no} · ${
            ORDER_STATUS_LABEL[latestOrder!.status ?? ""] ??
            latestOrder!.status ??
            ""
          }`,
    };
  }

  // 报价：有报价单
  const latestQuote = [...quotes].sort(byDateDesc)[0];
  if (latestQuote || docs.some((doc) => doc.doc_type === "quotation")) {
    return {
      label: "报价",
      tone: "info",
      hint: latestQuote
        ? `报价单 ${latestQuote.quote_no}`
        : `报价单 ${latestDoc?.doc_no ?? ""}`,
    };
  }

  return { label: "询盘", tone: "default", hint: null };
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

/** 归档文件版本（系统 PDF / 盖章回传）：只读展示 + 打开原文件。 */
function ArchivedVersions({ docId }: { docId: number }) {
  const files = useTradeDocFiles(docId);
  const archived = (files.data ?? []).filter(
    (f) => f.role.startsWith("render_pdf") || f.role.startsWith("stamp_scan"),
  );
  if (files.isLoading || archived.length === 0) return null;

  const openFile = async (fileId: number) => {
    try {
      const res = await apiClient.get(`/file-objects/${fileId}/content`, {
        responseType: "blob",
      });
      const url = URL.createObjectURL(res.data as Blob);
      window.open(url, "_blank", "noopener");
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch {
      toast.error("打开归档文件失败，请稍后重试");
    }
  };

  const roleLabel = (role: string) =>
    role.startsWith("render_pdf")
      ? "系统 PDF"
      : role.startsWith("stamp_scan")
        ? "盖章回传"
        : role;

  return (
    <div className="mx-auto mt-4 max-w-[900px] overflow-hidden rounded-xl border border-border/70 bg-white/80">
      <div className="flex items-center justify-between border-b border-border/60 px-3 py-2">
        <span className="text-[11px] font-medium text-muted-foreground">
          归档版本 {archived.length} 个
        </span>
        <span className="text-[11px] text-muted-foreground">
          当前版本在前 · 历史版本留档
        </span>
      </div>
      {archived.map((file) => (
        <button
          key={file.id}
          type="button"
          onClick={() => void openFile(file.id)}
          className="flex w-full items-center gap-3 border-b border-border/60 px-3 py-2 text-left text-xs transition-colors last:border-0 hover:bg-muted/40"
        >
          <span className="text-muted-foreground">{roleLabel(file.role)}</span>
          <span className="font-mono">v{file.version}</span>
          <StatusBadge
            tone={file.is_current ? "success" : "default"}
            className="h-5 px-2 text-[11px]"
          >
            {file.is_current ? "当前" : "历史"}
          </StatusBadge>
          <span className="ml-auto tabular-nums text-muted-foreground">
            {formatDate(file.created_at)}
          </span>
          <ArrowUpRight className="size-3.5 text-muted-foreground" />
        </button>
      ))}
    </div>
  );
}

/** 单证预览：有单证工位权限 → 直接内嵌完整单据；否则只展示信息。 */
function DocPreviewDialog({
  doc,
  onClose,
}: {
  doc: RecordDocument | null;
  onClose: () => void;
}) {
  const { snapshot } = useTeam();
  const meta = doc ? docTypeMeta(doc.doc_type) : null;
  const docId = doc?.id ?? null;
  const renderData = useTradeDocRenderData(docId);
  // 与侧边栏同一口径：快照失败时放行（否则接口未上线会把预览锁死）
  const canPreview =
    !snapshot.ok ||
    snapshot.isPlatformAdmin ||
    snapshot.workstations.includes("trade-docs") ||
    snapshot.codes.includes("full_chain");

  return (
    <Dialog
      open={doc !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="flex h-[min(90vh,920px)] w-[min(1240px,calc(100vw-3rem))] max-w-none flex-col gap-0 overflow-hidden rounded-2xl border border-white/60 bg-white/90 p-0 shadow-[0_30px_80px_-30px_rgba(15,23,42,0.45)] backdrop-blur-2xl sm:max-w-none"
      >
        <div className="flex items-start justify-between gap-4 border-b border-border/70 px-5 py-4">
          <div className="min-w-0">
            <DialogTitle className="truncate text-base">
              {meta?.label ?? "单证"} · {doc?.doc_no}
            </DialogTitle>
            <DialogDescription className="mt-1 flex flex-wrap items-center gap-3 text-xs">
              <StatusBadge
                tone={DOC_STATUS_TONE[doc?.status ?? ""] ?? "default"}
                className="h-5 px-2 text-[11px]"
              >
                {docStatusLabel(doc?.status) || "—"}
              </StatusBadge>
              <span className="tabular-nums">
                {money(doc?.total_amount ?? null, doc?.currency ?? null)}
              </span>
              <span className="tabular-nums">
                {formatDate(doc?.created_at)}
              </span>
            </DialogDescription>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            aria-label="关闭单证预览"
          >
            <X className="size-4" />
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto bg-slate-100/60 p-4">
          {!canPreview ? (
            <div className="mx-auto mt-10 max-w-md rounded-xl border border-dashed border-border bg-white/80 p-6 text-center text-sm text-muted-foreground">
              当前账号没有「单证」工位权限，无法预览单据内容。
              <br />
              可联系管理员开通，或从单证工位查看已有单据。
            </div>
          ) : renderData.isLoading ? (
            <p className="py-16 text-center text-sm text-muted-foreground">
              正在装配单据…
            </p>
          ) : renderData.isError || !renderData.data ? (
            <div className="mx-auto mt-10 max-w-md rounded-xl border border-dashed border-border bg-white/80 p-6 text-center text-sm text-muted-foreground">
              单据数据读取失败（可能是 mock 数据或权限不足）。
            </div>
          ) : (
            <div className="mx-auto max-w-[900px] overflow-hidden rounded-xl bg-white shadow-sm">
              <DocPreview
                docType={renderData.data.doc.doc_type}
                docNo={renderData.data.doc.doc_no}
                data={renderData.data.data}
                docId={renderData.data.doc.id}
                renderMeta={renderMetaOf(renderData.data.doc.raw_payload)}
                companyProfileConfigured={
                  renderData.data.company_profile_configured
                }
              />
            </div>
          )}
          {docId !== null && canPreview && <ArchivedVersions docId={docId} />}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border/70 bg-white/70 px-5 py-3">
          <span className="text-[11px] text-muted-foreground">
            {canPreview ? "预览内容与单证工位一致" : "无单证工位权限"}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={onClose}>
              关闭
            </Button>
            {doc?.id != null && (
              <a
                href={`/trade-docs?doc=${doc.id}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-8 items-center rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
              >
                在单证工位打开
              </a>
            )}
          </div>
        </div>
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
  const docs = collectDocuments(quotes);

  // 单条订单：直接给单证表，不再重复写「报价单/订单」编号那两行；
  // 多条订单（分批发货/多次下单）：按订单分组，组头只写一次订单号。
  if (orders.length <= 1) {
    return <DocTable docs={docs} />;
  }

  const quoteDocs = quotes.flatMap((quote) => quote.documents).sort(byDateDesc);

  return (
    <div className="space-y-4">
      {orders.map((order) => (
        <div key={`order-${order.id ?? order.order_no}`}>
          <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
            <span className="text-muted-foreground">订单</span>
            <span className="font-mono">{order.order_no}</span>
            <StatusBadge
              tone={ORDER_STATUS_TONE[order.status ?? ""] ?? "default"}
              className="h-5 px-2 text-[11px]"
            >
              {ORDER_STATUS_LABEL[order.status ?? ""] ?? order.status ?? "—"}
            </StatusBadge>
            <span className="ml-auto tabular-nums text-muted-foreground">
              {money(order.total_amount, order.currency)} ·{" "}
              {formatDate(order.created_at)}
            </span>
          </div>
          <DocTable docs={[...order.documents].sort(byDateDesc)} />
        </div>
      ))}
      {quoteDocs.length > 0 && (
        <div>
          <div className="mb-2 text-xs text-muted-foreground">
            报价单 / 未挂订单的单证
          </div>
          <DocTable docs={quoteDocs} />
        </div>
      )}
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
