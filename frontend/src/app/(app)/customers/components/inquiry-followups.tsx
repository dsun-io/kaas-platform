"use client";

/**
 * 询盘 → 后续单据（报价单 / 订单 / 单证）的紧凑展示。
 *
 * 设计口径（2026-10-20 用户反馈）：
 *  - 「询盘」是数据的起点：每条询盘下要能一眼看到后续走到哪一步；
 *  - 展开后按「报价单 → 订单 → 单证」的包含关系展示，而不是另开一个「往来记录」页签；
 *  - 没有关联到询盘的历史单据（导入/手工新建）不允许消失，统一收在「未关联询盘的单据」里。
 *
 * 状态配色与订单/单证工位保持一致（同一状态不能在不同页面是两种颜色）。
 */
import { StatusBadge, type StatusTone } from "@/components/shared";
import { DocChip } from "@/components/doc-chip";
import { Button } from "@/components/ui/button";
import type {
  RecordDocument,
  RecordOrder,
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

function money(amount: number | null, currency: string | null): string {
  if (amount === null) return "—";
  const value = amount.toLocaleString("en-US", { minimumFractionDigits: 2 });
  return currency ? `${currency} ${value}` : value;
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString("zh-CN");
}

function DocLine({ docs }: { docs: RecordDocument[] }) {
  if (docs.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
      <span className="text-[11px] text-muted-foreground">单证</span>
      {docs.map((doc) => (
        <DocChip
          key={`${doc.id ?? "n"}-${doc.doc_no}`}
          docType={doc.doc_type}
          docNo={doc.doc_no}
          status={doc.status}
        />
      ))}
    </div>
  );
}

function OrderLine({ order }: { order: RecordOrder }) {
  return (
    <div className="rounded-lg border border-border/60 bg-white/60 px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-medium text-muted-foreground">
          订单
        </span>
        <span className="font-mono text-xs">{order.order_no}</span>
        <StatusBadge
          tone={ORDER_STATUS_TONE[order.status ?? ""] ?? "default"}
          className="h-5 px-2 text-[11px]"
        >
          {ORDER_STATUS_LABEL[order.status ?? ""] ?? order.status ?? "—"}
        </StatusBadge>
        <span className="ml-auto text-xs tabular-nums text-muted-foreground">
          {money(order.total_amount, order.currency)} ·{" "}
          {formatDate(order.created_at)}
        </span>
      </div>
      <DocLine docs={order.documents} />
    </div>
  );
}

function QuoteLine({ quote }: { quote: RecordQuote }) {
  return (
    <div className="rounded-xl border border-border/70 bg-white/70 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-medium text-muted-foreground">
          报价单
        </span>
        <span className="font-mono text-xs">{quote.quote_no}</span>
        <StatusBadge
          tone={QUOTE_STATUS_TONE[quote.status ?? ""] ?? "default"}
          className="h-5 px-2 text-[11px]"
        >
          {QUOTE_STATUS_LABEL[quote.status ?? ""] ?? quote.status ?? "—"}
        </StatusBadge>
        <span className="ml-auto text-xs tabular-nums text-muted-foreground">
          {money(quote.total_amount, quote.currency)} ·{" "}
          {formatDate(quote.created_at)}
        </span>
      </div>
      <DocLine docs={quote.documents} />
      {quote.orders.length > 0 && (
        <div className="mt-2 space-y-2 border-l-2 border-primary/15 pl-3">
          {quote.orders.map((order, index) => (
            <OrderLine
              key={order.id ?? `${order.order_no}-${index}`}
              order={order}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function FollowupState({
  loading,
  unavailable,
  onRetry,
  emptyText,
}: {
  loading: boolean;
  unavailable: boolean;
  onRetry?: () => void;
  emptyText?: string;
}) {
  if (loading) {
    return (
      <p className="py-2 text-xs text-muted-foreground">正在读取后续单据…</p>
    );
  }
  if (unavailable) {
    return (
      <div className="flex flex-wrap items-center gap-2 py-2 text-xs text-muted-foreground">
        <span>后续单据暂时读不到，不影响客户信息与询盘。</span>
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
  if (emptyText) {
    return <p className="py-2 text-xs text-muted-foreground">{emptyText}</p>;
  }
  return null;
}

export interface InquiryFollowupProps {
  quotes: RecordQuote[];
  loading: boolean;
  unavailable: boolean;
  onRetry?: () => void;
  /** 未报价时的说明（含"该询盘还没有报价单"） */
  emptyText?: string;
}

/** 单条询盘下的后续单据链。 */
export function InquiryFollowup({
  quotes,
  loading,
  unavailable,
  onRetry,
  emptyText = "该询盘还没有报价单。",
}: InquiryFollowupProps) {
  if (!loading && !unavailable && quotes.length === 0) {
    return (
      <FollowupState
        loading={false}
        unavailable={false}
        emptyText={emptyText}
      />
    );
  }
  if (loading || unavailable) {
    return (
      <FollowupState
        loading={loading}
        unavailable={unavailable}
        onRetry={onRetry}
      />
    );
  }
  return (
    <div className="space-y-2">
      <p className="text-[11px] text-muted-foreground">
        报价单 → 订单 → 单证（按包含关系）
      </p>
      {quotes.map((quote, index) => (
        <QuoteLine
          key={quote.id ?? `${quote.quote_no}-${index}`}
          quote={quote}
        />
      ))}
    </div>
  );
}

/** 未关联询盘的历史单据（导入 / 手工新建），默认折叠，避免占满询盘视图。 */
export function UnlinkedRecords({
  quotes,
  orders,
  documents,
  loading,
  unavailable,
  onRetry,
}: {
  quotes: RecordQuote[];
  orders: RecordOrder[];
  documents: RecordDocument[];
  loading: boolean;
  unavailable: boolean;
  onRetry?: () => void;
}) {
  const total = quotes.length + orders.length + documents.length;
  if (!loading && !unavailable && total === 0) return null;

  return (
    <details className="rounded-xl border border-dashed border-border/80 bg-white/40 px-4 py-3">
      <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
        未关联询盘的报价 / 订单 / 单证
        <span className="ml-2 font-normal">
          {loading ? "读取中…" : unavailable ? "暂时读不到" : `共 ${total} 项`}
        </span>
      </summary>
      <p className="mt-2 text-[11px] text-muted-foreground">
        历史导入或手工新建的单据没有询盘来源，单独放这里，不会丢失。
      </p>
      <div className="mt-3 space-y-2">
        {loading ? (
          <FollowupState loading unavailable={false} />
        ) : unavailable ? (
          <FollowupState loading={false} unavailable onRetry={onRetry} />
        ) : (
          <>
            {quotes.map((quote, index) => (
              <QuoteLine
                key={quote.id ?? `${quote.quote_no}-${index}`}
                quote={quote}
              />
            ))}
            {orders.map((order, index) => (
              <OrderLine
                key={order.id ?? `${order.order_no}-${index}`}
                order={order}
              />
            ))}
            {documents.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border/60 bg-white/60 px-3 py-2">
                <span className="text-[11px] text-muted-foreground">单证</span>
                {documents.map((doc) => (
                  <DocChip
                    key={`${doc.id ?? "n"}-${doc.doc_no}`}
                    docType={doc.doc_type}
                    docNo={doc.doc_no}
                    status={doc.status}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </details>
  );
}
