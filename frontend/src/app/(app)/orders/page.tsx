"use client";

/**
 * 订单工位 —— 报价转订单、订单条款维护、收款计划与应收概览。
 *
 * 业务位置：报价谈成 → 转订单 → 建收款计划 → 备货出运 → 按订单开单证。
 * 订单上的**贸易条款**（贸易术语/付款方式/装卸港/唛头/原产国）是单证的核心输入，
 * 所以这里必须能看、能改；否则单证就只能手工重填，极易与合同不一致。
 *
 * 列表「有变更待批」角标（设计 §9.2 / A1 P0-A）：`GET /orders` 每行返回
 * `pending_item_change_count`（门面一次相关子查询取回，无 N+1），>0 显示角标；
 * 详情页另有待批横幅（新旧对比 + 批准/拒绝）。
 *
 * 深链 `/orders?id={order_id}`：通知（内核 A4 起批准/拒绝写该 link）与询盘工位的
 * 「关联订单」都指到这里，挂载后按 id 打开详情；目标单不在当前页时详情仍可单独拉取。
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import type { Route } from "next";
import { AlertCircle, Bell, ChevronRight, Plus, Wallet } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

import { useMutationWithError } from "./hooks/use-mutation-with-error";
import { toast } from "sonner";

import { CopyButton } from "@/components/shared/copy-button";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { PaginationBar } from "@/components/shared/pagination-bar";
import { PopoverPanel } from "@/components/shared/popover-panel";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge } from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import apiClient from "@/lib/api/client";
import { usePageView } from "@/lib/events/use-page-view";
import { usePersistentState } from "@/lib/hooks/use-persistent-state";
import {
  ORDER_CHANNEL_FILTER_OPTIONS,
  ORDER_SOURCE_FILTER_OPTIONS,
  inquiryDeepLink,
  orderSourceLabel,
  orderSourceTone,
  quoteRecordsDeepLink,
} from "@/lib/orders/order-source";
import { cn } from "@/lib/utils";
import {
  useQuoteOptions,
  type OrderOption,
} from "@/lib/workstation/use-upstream";

import { useOrdersList, ORDERS_PAGE_SIZE } from "./hooks/use-orders-list";

import { OrderAttachmentsPanel } from "./components/order-attachments-panel";
import { OrderCreateWizard } from "./components/order-create-wizard";
import { OrderDetailPanel } from "./components/order-detail-panel";
import { OrderExternalDocsPanel } from "./components/order-external-docs-panel";
import { OrderStatusDialog } from "./components/order-status-dialog";
import { PaymentSchedulesPanel } from "./components/payment-schedules-panel";

/** 订单行（与后端 /orders 返回一致） */
type OrderRow = OrderOption;

const STATUS_TONE: Record<
  string,
  "default" | "success" | "warning" | "danger" | "info"
> = {
  pending: "warning",
  confirmed: "info",
  producing: "info",
  shipped: "success",
  completed: "success",
  cancelled: "danger",
};

const STATUS_LABEL: Record<string, string> = {
  pending: "待确认",
  confirmed: "已确认",
  producing: "生产中",
  shipped: "已出运",
  completed: "已完成",
  cancelled: "已取消",
};

const ORDER_COLUMNS = [
  { key: "order_no", label: "订单号" },
  { key: "customer", label: "客户" },
  { key: "status", label: "状态" },
  { key: "source", label: "来源" },
  { key: "links", label: "关联询盘/报价" },
  { key: "amount", label: "金额" },
  { key: "incoterm", label: "贸易术语" },
  { key: "payment_terms", label: "付款方式" },
  { key: "destination", label: "目的港" },
] as const;
type OrderColumnKey = (typeof ORDER_COLUMNS)[number]["key"];

/**
 * 「有变更待批」角标（A1 / P0-A）：仅 `pending_item_change_count > 0` 时出现。
 * aria-label 带**条数**（读屏能听出有几条申请待批），可视文案保持设计稿四字；
 * 颜色不是唯一信号（UI_STANDARDS §2：状态必须同时有文案）。
 */
function PendingChangeBadge({ count }: { count: number | undefined }) {
  if (typeof count !== "number" || !Number.isFinite(count) || count <= 0) {
    return null;
  }
  return (
    <span
      role="note"
      aria-label={`有变更待批 ${count} 条`}
      title={`有 ${count} 条明细变更申请待审批`}
      className="inline-flex items-center"
    >
      <StatusBadge tone="warning" className="h-5 px-2 text-[11px]">
        有变更待批
      </StatusBadge>
    </span>
  );
}

export default function OrdersPage() {
  usePageView({ resource_id: "/orders" });
  const qc = useQueryClient();
  // C25：列表走**分页**查询（下拉选择器仍用 useOrderOptions —— 那个只回 items）
  const [page, setPage] = useState(1);
  // 来源筛选（设计 §8 / §9.2）：状态/来源/渠道/客户。客户筛选仍走客户页
  // （订单列表的客户参数后端支持，但跨客户下拉这里不做——询盘工位才是客户维度入口）。
  const [sourceType, setSourceType] = useState("");
  const [sourceChannel, setSourceChannel] = useState("");
  const list = useOrdersList({ page, sourceType, sourceChannel });
  const orders = list.data?.items ?? [];
  const quotes = useQuoteOptions();
  const [quoteId, setQuoteId] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  // C36 下期 #21：状态流转弹窗（一次只开一个订单）
  const [statusOrder, setStatusOrder] = useState<OrderRow | null>(null);
  const [density, setDensity] = usePersistentState<"cozy" | "compact">(
    "ui:orders:density",
    "cozy",
  );
  // v2：新增「来源」「关联询盘/报价」两列。旧 key 里没有这两个 key，
  // 沿用会让老用户永远看不到新列（分不清"用户隐藏了"与"版本升级新增"）⇒ 换 key。
  const [visibleCols, setVisibleCols] = usePersistentState<OrderColumnKey[]>(
    "ui:orders:columns:v2",
    ORDER_COLUMNS.map((c) => c.key),
  );
  // 深链：通知（`/orders?id=`，内核 A4）与询盘「关联订单」都指到这里。
  // 静态导出下不用 useSearchParams（需要 Suspense 边界，quotes 页已踩过），
  // 挂载后直接读 location.search。
  useEffect(() => {
    const raw = new URLSearchParams(window.location.search).get("id");
    const id = raw === null ? Number.NaN : Number(raw);
    if (Number.isInteger(id) && id > 0) setSelectedId(id);
  }, []);

  const selected = orders.find((o) => o.id === selectedId) ?? null;
  // 深链目标可能在其它页（列表只加载当前页）：详情面板按 id 单独 GET，
  // 列表行只用来补币种等展示信息；找不到就传 null，不阻断详情。
  const detailOrderId = selected?.id ?? selectedId;
  const hasSourceFilter = sourceType !== "" || sourceChannel !== "";

  /** 关闭详情：同时清掉 `?id=`，否则刷新/后退会把已关闭的详情又弹出来。 */
  const closeDetail = () => {
    setSelectedId(null);
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (url.searchParams.has("id")) {
      url.searchParams.delete("id");
      window.history.replaceState(null, "", url.toString());
    }
  };

  const createFromQuote = useMutationWithError({
    mutationFn: async () => {
      const { data } = await apiClient.post<OrderRow>("/orders", {
        quote_order_id: Number(quoteId),
      });
      return data;
    },
    onSuccess: (order) => {
      toast.success(`已由报价生成订单 ${order.order_no}（贸易条款已继承）`);
      setQuoteId("");
      setSelectedId(order.id);
      qc.invalidateQueries({ queryKey: ["upstream", "orders"] });
    },
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="订单"
        description="报价谈成后转订单；订单上的贸易条款会一路传到单证，避免单证与合同不一致。"
        actions={
          // C36 #7：应收台账入口放在订单页 —— 侧栏导航由共享契约 workstations.ts 驱动
          // （R2 与后端共享内核逐条比对），加导航项属契约变更；应收由订单产生，此处进入最顺。
          <Link href="/receivables">
            <Button variant="outline" size="sm">
              <Wallet className="mr-1 h-4 w-4" />
              应收台账
            </Button>
          </Link>
        }
      />

      <SectionCard
        title="新建订单 · 方式一：由报价单转订单"
        description="转化会复制货物行项、币种与贸易条款（贸易术语/付款方式/装卸港/唛头/原产国），来源自动记为该报价的询盘。"
      >
        <div className="flex flex-wrap items-center gap-2">
          <select
            className="h-9 min-w-[320px] rounded-md border border-input bg-background px-2 text-sm"
            value={quoteId}
            onChange={(e) => setQuoteId(e.target.value)}
          >
            <option value="">— 选择报价单 —</option>
            {(quotes.data ?? []).map((q) => (
              <option key={q.id} value={String(q.id)}>
                {q.quote_no} · {q.customer_name ?? "未填客户"} · {q.currency}{" "}
                {q.total_amount ?? "-"}
              </option>
            ))}
          </select>
          <Button
            disabled={!quoteId || createFromQuote.isPending}
            onClick={() => createFromQuote.mutate()}
          >
            <Plus className="mr-1 h-4 w-4" />
            转为订单
          </Button>
          {quotes.data?.length === 0 && (
            <span className="text-xs text-warning">
              还没有报价单 —— 请先在「报价」工位出报价。
            </span>
          )}
        </div>
        {/* U-P0C：转为订单失败的原因落在页内（apiClient 已 toast，不重复） */}
        {createFromQuote.errorMessage && (
          <p role="alert" className="mt-2 text-xs text-destructive">
            转为订单失败：{createFromQuote.errorMessage}
          </p>
        )}
      </SectionCard>

      <SectionCard
        title="新建订单 · 方式二：直接新建订单（五步向导）"
        description="客户与来源 → 订单信息 → 货物与金额 → 收款计划 → 附件。线下电话单/老客户返单也在这里建：客户必选，来源必须明确（询盘转化 / 直接下单），报价可选。"
      >
        <OrderCreateWizard onCreated={(order) => setSelectedId(order.id)} />
      </SectionCard>

      <SectionCard
        title="订单列表"
        action={
          <div className="flex items-center gap-2">
            <div
              className="flex items-center gap-1"
              role="group"
              aria-label="表格密度"
            >
              <Button
                size="sm"
                variant={density === "cozy" ? "secondary" : "ghost"}
                onClick={() => setDensity("cozy")}
                aria-pressed={density === "cozy"}
              >
                舒适
              </Button>
              <Button
                size="sm"
                variant={density === "compact" ? "secondary" : "ghost"}
                onClick={() => setDensity("compact")}
                aria-pressed={density === "compact"}
              >
                紧凑
              </Button>
            </div>
            {/* O5：列配置浮层改用共享 PopoverPanel（Esc/外点/焦点归还由原语统一） */}
            <PopoverPanel
              trigger="列配置"
              ariaLabel="列配置"
              triggerClassName="cursor-pointer"
              panelClassName="w-44"
            >
              <div className="space-y-1">
                {ORDER_COLUMNS.map((c) => {
                  const checked = visibleCols.includes(c.key);
                  // a11y（C26/A4）：只剩最后一列时，该勾选框**保留可聚焦**但取消会清空表格 ⇒
                  // 用 aria-disabled + 真正拦住动作，而不是原生 disabled（原生会丢焦点、
                  // 读屏也只说"不可用"而不说原因）。至少保留一列是产品约束，不是临时状态。
                  const locked = checked && visibleCols.length === 1;
                  return (
                    <label
                      key={c.key}
                      title={locked ? "至少保留一列" : undefined}
                      className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs hover:bg-muted"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        aria-disabled={locked || undefined}
                        className={
                          locked ? "cursor-not-allowed opacity-60" : undefined
                        }
                        onChange={() => {
                          if (locked) return;
                          const next = checked
                            ? visibleCols.filter((k) => k !== c.key)
                            : [...visibleCols, c.key];
                          // 至少保留一列，避免表格变成空壳
                          if (next.length > 0) setVisibleCols(next);
                        }}
                      />
                      {c.label}
                    </label>
                  );
                })}
              </div>
            </PopoverPanel>
          </div>
        }
      >
        <div className="mb-3 flex flex-wrap items-end gap-2">
          <label className="space-y-1">
            <span className="block text-xs text-muted-foreground">来源</span>
            <select
              aria-label="来源筛选"
              className="h-8 rounded-lg border border-input bg-background px-2 text-xs"
              value={sourceType}
              onChange={(e) => {
                setSourceType(e.target.value);
                setPage(1);
              }}
            >
              {ORDER_SOURCE_FILTER_OPTIONS.map((option) => (
                <option key={option.value || "all"} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1">
            <span className="block text-xs text-muted-foreground">渠道</span>
            <select
              aria-label="渠道筛选"
              className="h-8 rounded-lg border border-input bg-background px-2 text-xs"
              value={sourceChannel}
              onChange={(e) => {
                setSourceChannel(e.target.value);
                setPage(1);
              }}
            >
              {ORDER_CHANNEL_FILTER_OPTIONS.map((option) => (
                <option key={option.value || "all"} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          {hasSourceFilter && (
            <button
              type="button"
              className="text-xs text-primary underline-offset-2 hover:underline"
              onClick={() => {
                setSourceType("");
                setSourceChannel("");
                setPage(1);
              }}
            >
              清除来源筛选
            </button>
          )}
          <span className="ml-auto text-xs text-muted-foreground">
            来源与渠道取自订单自身记录；历史单渠道未知时不伪造。
          </span>
        </div>
        {list.isLoading ? (
          <div
            className="space-y-2"
            aria-busy="true"
            aria-label="订单列表加载中"
          >
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full rounded-md" />
            ))}
          </div>
        ) : list.isError ? (
          <div className="flex items-center gap-2 py-8 text-sm text-destructive">
            <AlertCircle className="h-4 w-4" />
            读取订单失败。请确认后端服务已启动。
          </div>
        ) : orders.length === 0 ? (
          <EmptyState
            icon={Bell}
            title={hasSourceFilter ? "当前筛选没有订单" : "还没有订单"}
            description={
              hasSourceFilter
                ? "换一个来源/渠道，或清除筛选看全部订单。"
                : "从上面的报价单转一张订单，或直接新建订单试试。"
            }
          />
        ) : (
          <>
            <div
              className={cn(
                "hidden overflow-x-auto md:block",
                density === "compact" &&
                  "[&_td]:py-1 [&_th]:h-8 [&_tr]:text-xs",
              )}
            >
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    {ORDER_COLUMNS.filter((c) =>
                      visibleCols.includes(c.key),
                    ).map((c) => (
                      <th key={c.key} scope="col" className="p-2">
                        {c.label}
                      </th>
                    ))}
                    <th scope="col" className="p-2" />
                  </tr>
                </thead>
                <tbody>
                  {orders.map((o) => (
                    <tr
                      key={o.id}
                      className="border-b last:border-0 hover:bg-muted/40"
                    >
                      {visibleCols.includes("order_no") && (
                        <td className="p-2 font-medium">
                          <span className="inline-flex flex-wrap items-center gap-1">
                            {o.order_no}
                            <CopyButton value={o.order_no} label="复制订单号" />
                            <PendingChangeBadge
                              count={o.pending_item_change_count}
                            />
                          </span>
                        </td>
                      )}
                      {visibleCols.includes("customer") && (
                        <td className="p-2">{o.customer_name ?? "—"}</td>
                      )}
                      {visibleCols.includes("status") && (
                        <td className="p-2">
                          <StatusBadge
                            tone={STATUS_TONE[o.status] ?? "default"}
                          >
                            {STATUS_LABEL[o.status] ?? o.status}
                          </StatusBadge>
                        </td>
                      )}
                      {visibleCols.includes("source") && (
                        <td className="p-2">
                          <StatusBadge tone={orderSourceTone(o.source_type)}>
                            {orderSourceLabel(o.source_type, o.source_channel)}
                          </StatusBadge>
                        </td>
                      )}
                      {visibleCols.includes("links") && (
                        <td className="p-2 text-xs">
                          <div className="flex flex-wrap items-center gap-2">
                            {inquiryDeepLink(o.inquiry_id) ? (
                              <Link
                                href={inquiryDeepLink(o.inquiry_id)! as Route}
                                className="text-primary underline-offset-2 hover:underline"
                              >
                                询盘 #{o.inquiry_id}
                              </Link>
                            ) : null}
                            {quoteRecordsDeepLink(o.quote_id) ? (
                              <Link
                                href={
                                  quoteRecordsDeepLink(o.quote_id)! as Route
                                }
                                className="text-primary underline-offset-2 hover:underline"
                              >
                                报价单 #{o.quote_id}
                              </Link>
                            ) : null}
                            {!o.inquiry_id && !o.quote_id && (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </div>
                        </td>
                      )}
                      {visibleCols.includes("amount") && (
                        <td className="p-2">
                          {o.total_amount === null
                            ? "—"
                            : `${o.currency} ${o.total_amount.toLocaleString(
                                "en-US",
                                {
                                  minimumFractionDigits: 2,
                                },
                              )}`}
                        </td>
                      )}
                      {visibleCols.includes("incoterm") && (
                        <td className="p-2">
                          {o.incoterm || (
                            <span className="text-warning">未填</span>
                          )}
                        </td>
                      )}
                      {visibleCols.includes("payment_terms") && (
                        <td
                          className="p-2 max-w-[220px] truncate"
                          title={o.payment_terms ?? ""}
                        >
                          {o.payment_terms || (
                            <span className="text-warning">未填</span>
                          )}
                        </td>
                      )}
                      {visibleCols.includes("destination") && (
                        <td className="p-2">{o.port_of_destination || "—"}</td>
                      )}
                      <td className="p-2">
                        <div className="flex gap-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setStatusOrder(o)}
                          >
                            状态
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setSelectedId(o.id)}
                          >
                            详情
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* 窄屏卡片：DOM 在表格之后，避免隐藏节点干扰文本定位 */}
            <div className="divide-y divide-border/60 md:hidden">
              {orders.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  aria-label={`查看订单 ${o.order_no}`}
                  className="flex w-full items-center gap-3 px-5 py-4 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/30"
                  onClick={() => setSelectedId(o.id)}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1">
                      <span className="truncate font-medium">{o.order_no}</span>
                      <CopyButton value={o.order_no} label="复制订单号" />
                    </div>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {o.customer_name ?? "—"}
                    </p>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <StatusBadge tone={STATUS_TONE[o.status] ?? "default"}>
                        {STATUS_LABEL[o.status] ?? o.status}
                      </StatusBadge>
                      <StatusBadge tone={orderSourceTone(o.source_type)}>
                        {orderSourceLabel(o.source_type, o.source_channel)}
                      </StatusBadge>
                      <PendingChangeBadge count={o.pending_item_change_count} />
                      <span className="text-xs text-muted-foreground">
                        {o.total_amount === null
                          ? "—"
                          : `${o.currency} ${o.total_amount.toLocaleString(
                              "en-US",
                              { minimumFractionDigits: 2 },
                            )}`}
                      </span>
                      {o.port_of_destination && (
                        <span className="text-xs text-muted-foreground">
                          {o.port_of_destination}
                        </span>
                      )}
                    </div>
                  </div>
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground/60" />
                </button>
              ))}
            </div>
            <PaginationBar
              page={page}
              pageSize={ORDERS_PAGE_SIZE}
              total={list.data?.total ?? 0}
              currentCount={orders.length}
              loading={list.isFetching}
              onPageChange={setPage}
              ariaLabel="订单列表分页"
            />
          </>
        )}
      </SectionCard>

      {/* §13.3 订单详情：金额构成 / 货物明细 / 贸易条款；收款计划与附件独立面板。
          深链进来的订单可能不在当前页列表里 ⇒ 详情只依赖 detailOrderId（各自 GET），
          币种取自列表行（拿不到就 null，面板按无币种展示）。 */}
      {detailOrderId !== null && (
        <>
          <OrderDetailPanel
            key={`detail-${detailOrderId}`}
            orderId={detailOrderId}
            onClose={closeDetail}
          />
          <PaymentSchedulesPanel
            key={`schedules-${detailOrderId}`}
            orderId={detailOrderId}
            currency={selected?.currency ?? null}
          />
          <OrderAttachmentsPanel
            key={`files-${detailOrderId}`}
            orderId={detailOrderId}
          />
          {/* 已有单证台账（外部单证），与随单附件分开展示 */}
          <OrderExternalDocsPanel
            key={`external-docs-${detailOrderId}`}
            orderId={detailOrderId}
          />
        </>
      )}

      {statusOrder && (
        <OrderStatusDialog
          open
          onOpenChange={(next) => {
            if (!next) setStatusOrder(null);
          }}
          order={{
            id: statusOrder.id,
            order_no: statusOrder.order_no,
            status: statusOrder.status,
          }}
          onChanged={() => {
            setStatusOrder(null);
            void qc.invalidateQueries({ queryKey: ["upstream", "orders"] });
          }}
        />
      )}
    </div>
  );
}
