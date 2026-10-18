"use client";

/**
 * 客户「往来记录」树 —— 报价 → 报价单 chip + 订单 → 单证 chips（设计文档 §4）。
 *
 * 三条渲染纪律：
 *  1. **单证不分家**：报价单与 PI/CI/PL/BL 都用同一个 `DocChip`，
 *     贴在各自所属的节点下，只用图标/配色区分 `doc_type`。绝不拆成两个模块。
 *  2. **`direct`（直接挂客户）固定渲染**：手动新建与导入的历史订单/单证是
 *     正规路径，不是脏数据 —— 这一块无论有没有内容都要出现，
 *     否则用户会以为"导入的数据丢了"（设计 §1.6）。
 *  3. **接口没上线也不许崩**：`useCustomerRecords` 已经把失败吞成 `ok:false`，
 *     这里只负责把它渲染成"加载失败 + 重试"的普通区块，不抛错、不白屏。
 *
 * 默认展开遵循业务关注点：含订单的报价展开（最关心"哪些报价成单了"），
 * 纯草稿/未成单折叠。
 */
import { useState } from "react";
import { AlertCircle, ChevronRight, FileText } from "lucide-react";

import { DocChip } from "@/components/doc-chip";
import {
  EmptyState,
  SectionCard,
  StatusBadge,
  type StatusTone,
} from "@/components/shared";
import { Button } from "@/components/ui/button";
import {
  EMPTY_CUSTOMER_RECORDS,
  formatRecordCounts,
  hasAnyRecord,
  defaultQuoteExpanded,
  type RecordDocument,
  type RecordOrder,
  type RecordQuote,
} from "@/lib/customer/customer-records";
import { useCustomerRecords } from "@/lib/customer/use-customer-records";
import { cn } from "@/lib/utils";

// 状态配色与文案与订单/单证工位保持一致（同一状态在不同页面不能是两种颜色）
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

/** 一行"单证 [chip][chip]"，节点下与 direct 分组共用。 */
function DocLine({
  docs,
  emptyText,
}: {
  docs: RecordDocument[];
  emptyText: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-[11px] text-muted-foreground">单证</span>
      {docs.length === 0 ? (
        <span className="text-[11px] text-muted-foreground/70">
          {emptyText}
        </span>
      ) : (
        docs.map((doc) => (
          <DocChip
            key={`${doc.id ?? "n"}-${doc.doc_no}`}
            docType={doc.doc_type}
            docNo={doc.doc_no}
            status={doc.status}
          />
        ))
      )}
    </div>
  );
}

/** 订单节点默认展开：单证是订单的产出，折叠起来等于把结果藏了。 */
const DEFAULT_ORDER_OPEN = true;

function OrderNode({
  order,
  open,
  onToggle,
}: {
  order: RecordOrder;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="rounded-lg border bg-background">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full flex-wrap items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted/40"
      >
        <ChevronRight
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
        />
        <span className="font-medium">{order.order_no}</span>
        <StatusBadge tone={ORDER_STATUS_TONE[order.status ?? ""] ?? "default"}>
          {ORDER_STATUS_LABEL[order.status ?? ""] ?? order.status ?? "未知"}
        </StatusBadge>
        <span className="ml-auto text-xs text-muted-foreground">
          {money(order.total_amount, order.currency)} ·{" "}
          {formatDate(order.created_at)}
        </span>
      </button>
      {open && (
        <div className="border-t px-3 py-2 pl-8">
          <DocLine
            docs={order.documents}
            emptyText="暂无单证（PI / CI / PL / BL）"
          />
        </div>
      )}
    </div>
  );
}

function QuoteNode({
  quote,
  open,
  onToggle,
  orderOpen,
  onToggleOrder,
}: {
  quote: RecordQuote;
  open: boolean;
  onToggle: () => void;
  orderOpen: (order: RecordOrder, index: number) => boolean;
  onToggleOrder: (order: RecordOrder, index: number, fallback: boolean) => void;
}) {
  return (
    <div className="rounded-lg border bg-card">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full flex-wrap items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted/40"
      >
        <ChevronRight
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
        />
        <span className="font-medium">{quote.quote_no}</span>
        <StatusBadge tone={QUOTE_STATUS_TONE[quote.status ?? ""] ?? "default"}>
          {QUOTE_STATUS_LABEL[quote.status ?? ""] ?? quote.status ?? "未知"}
        </StatusBadge>
        <span className="ml-auto text-xs text-muted-foreground">
          {money(quote.total_amount, quote.currency)} ·{" "}
          {formatDate(quote.created_at)}
        </span>
      </button>

      {open && (
        <div className="space-y-2 border-t px-3 py-3">
          <DocLine docs={quote.documents} emptyText="报价单尚未生成" />
          <div className="space-y-2 border-l pl-3">
            {quote.orders.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">（未成单）</p>
            ) : (
              quote.orders.map((order, index) => (
                <OrderNode
                  key={order.id ?? `${order.order_no}-${index}`}
                  order={order}
                  open={orderOpen(order, index)}
                  onToggle={() =>
                    onToggleOrder(order, index, DEFAULT_ORDER_OPEN)
                  }
                />
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

interface CustomerRecordsTreeProps {
  customerId: number | null;
  /** 详情页已知的客户名；接口没返回 customer 时用它兜底标题 */
  customerName?: string | null;
}

export function CustomerRecordsTree({
  customerId,
  customerName = null,
}: CustomerRecordsTreeProps) {
  const query = useCustomerRecords(customerId);
  const result = query.data;
  const records = result?.records ?? EMPTY_CUSTOMER_RECORDS;

  // 展开态用"覆盖表"：用户点过就以用户为准，没点过的走业务默认值。
  // 不用 useEffect 初始化 state —— 接口重取（refetch）后用户的手动展开不会被重置。
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const isOpen = (key: string, fallback: boolean) => overrides[key] ?? fallback;
  const toggle = (key: string, fallback: boolean) =>
    setOverrides((prev) => ({ ...prev, [key]: !(prev[key] ?? fallback) }));

  const unavailable = query.isError || (result !== undefined && !result.ok);
  const loading = query.isLoading;
  const counts = records.counts;
  // direct 分组默认折叠（避免历史数据抢占主视图）；但如果这个客户**只有**
  // 直接挂客户的单据（导入型客户），默认展开 —— 否则整块看起来像空的。
  const directHasContent =
    records.direct.orders.length > 0 || records.direct.documents.length > 0;
  const directDefaultOpen = directHasContent && records.quotes.length === 0;

  return (
    <SectionCard
      title="往来记录"
      description="该客户的报价、订单与单证（按包含关系）"
      action={
        <span className="text-xs text-muted-foreground">
          {formatRecordCounts(counts)}
        </span>
      }
    >
      {loading ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          正在读取往来记录…
        </p>
      ) : unavailable ? (
        // 降级：接口可能还没上线。说清楚"读不到"而不是"没有"，并给重试入口。
        <div className="space-y-2 py-6 text-center">
          <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
            <AlertCircle className="size-4" />
            暂无往来记录 / 加载失败
          </div>
          <p className="text-xs text-muted-foreground">
            「往来记录」接口（GET /customers/{customerId}
            /records）可能尚未上线。 这不影响客户信息、联系人与询盘。
          </p>
          <Button
            size="sm"
            variant="outline"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            重试
          </Button>
        </div>
      ) : !hasAnyRecord(records) ? (
        <EmptyState
          icon={FileText}
          title="还没有报价、订单或单证"
          description="报价是这个客户所有单据的入口：先建报价，再由它转订单、出单证。"
          action={
            <a
              href={`/quotes?tab=product&customer_id=${customerId ?? ""}`}
              className="inline-flex h-8 items-center rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/80"
            >
              新建报价
            </a>
          }
        />
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            客户：{records.customerName ?? customerName ?? `#${customerId}`}
            {counts.quotes > records.quotes.length && (
              <span className="ml-2">
                （报价分页显示最近 {records.quotes.length} / {counts.quotes}{" "}
                条）
              </span>
            )}
          </p>

          {records.quotes.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              该客户还没有报价 —— 它的单据都在下方「直接挂客户」里。
            </p>
          ) : (
            records.quotes.map((quote) => (
              <QuoteNode
                key={quote.id ?? quote.quote_no}
                quote={quote}
                open={isOpen(
                  `quote:${quote.id ?? quote.quote_no}`,
                  defaultQuoteExpanded(quote),
                )}
                onToggle={() =>
                  toggle(
                    `quote:${quote.id ?? quote.quote_no}`,
                    defaultQuoteExpanded(quote),
                  )
                }
                orderOpen={(order, index) =>
                  isOpen(
                    `order:${quote.id ?? quote.quote_no}:${order.id ?? index}`,
                    DEFAULT_ORDER_OPEN,
                  )
                }
                onToggleOrder={(order, index, fallback) =>
                  toggle(
                    `order:${quote.id ?? quote.quote_no}:${order.id ?? index}`,
                    fallback,
                  )
                }
              />
            ))
          )}

          {/* direct 分组：固定渲染（手动新建 / 导入已有数据是正规路径） */}
          <div className="rounded-lg border border-dashed bg-muted/20">
            <button
              type="button"
              aria-expanded={isOpen("direct", directDefaultOpen)}
              onClick={() => toggle("direct", directDefaultOpen)}
              className="flex w-full flex-wrap items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted/40"
            >
              <ChevronRight
                className={cn(
                  "size-4 shrink-0 text-muted-foreground transition-transform",
                  isOpen("direct", directDefaultOpen) && "rotate-90",
                )}
              />
              <span className="font-medium">直接挂客户</span>
              <span className="text-[11px] text-muted-foreground">
                手动新建 / 导入已有数据（没有报价父对象）
              </span>
              <span className="ml-auto text-xs text-muted-foreground">
                {records.direct.orders.length} 订单 ·{" "}
                {records.direct.documents.length} 单证
              </span>
            </button>
            {isOpen("direct", directDefaultOpen) && (
              <div className="space-y-2 border-t px-3 py-3">
                {records.direct.orders.length === 0 &&
                  records.direct.documents.length === 0 && (
                    <p className="text-[11px] text-muted-foreground">
                      暂无直接挂客户的订单或单证。
                    </p>
                  )}
                {records.direct.orders.map((order, index) => (
                  <OrderNode
                    key={order.id ?? `${order.order_no}-direct-${index}`}
                    order={order}
                    open={isOpen(
                      `direct-order:${order.id ?? index}`,
                      DEFAULT_ORDER_OPEN,
                    )}
                    onToggle={() =>
                      toggle(
                        `direct-order:${order.id ?? index}`,
                        DEFAULT_ORDER_OPEN,
                      )
                    }
                  />
                ))}
                {(records.direct.orders.length > 0 ||
                  records.direct.documents.length > 0) && (
                  <DocLine
                    docs={records.direct.documents}
                    emptyText="暂无仅归属客户的单证"
                  />
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </SectionCard>
  );
}
