"use client";

/**
 * 订单工位 —— 报价转订单、订单条款维护、收款计划与应收概览。
 *
 * 业务位置：报价谈成 → 转订单 → 建收款计划 → 备货出运 → 按订单开单证。
 * 订单上的**贸易条款**（贸易术语/付款方式/装卸港/唛头/原产国）是单证的核心输入，
 * 所以这里必须能看、能改；否则单证就只能手工重填，极易与合同不一致。
 */
import { useState } from "react";
import { AlertCircle, Bell, ChevronRight, Plus } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { CopyButton } from "@/components/shared/copy-button";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { PaginationBar } from "@/components/shared/pagination-bar";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge } from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import apiClient from "@/lib/api/client";
import { usePageView } from "@/lib/events/use-page-view";
import { usePersistentState } from "@/lib/hooks/use-persistent-state";
import { cn } from "@/lib/utils";
import {
  useQuoteOptions,
  type OrderOption,
} from "@/lib/workstation/use-upstream";

import { useOrdersList, ORDERS_PAGE_SIZE } from "./hooks/use-orders-list";

import { OrderCreateForm } from "./components/order-create-form";

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
  { key: "amount", label: "金额" },
  { key: "incoterm", label: "贸易术语" },
  { key: "payment_terms", label: "付款方式" },
  { key: "destination", label: "目的港" },
] as const;
type OrderColumnKey = (typeof ORDER_COLUMNS)[number]["key"];

export default function OrdersPage() {
  usePageView({ resource_id: "/orders" });
  const qc = useQueryClient();
  // C25：列表走**分页**查询（下拉选择器仍用 useOrderOptions —— 那个只回 items）
  const [page, setPage] = useState(1);
  const list = useOrdersList({ page });
  const orders = list.data?.items ?? [];
  const quotes = useQuoteOptions();
  const [quoteId, setQuoteId] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [density, setDensity] = usePersistentState<"cozy" | "compact">(
    "ui:orders:density",
    "cozy",
  );
  const [visibleCols, setVisibleCols] = usePersistentState<OrderColumnKey[]>(
    "ui:orders:columns",
    ORDER_COLUMNS.map((c) => c.key),
  );

  const selected = orders.find((o) => o.id === selectedId) ?? null;

  const createFromQuote = useMutation({
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

  const saveTerms = useMutation({
    mutationFn: async (body: Partial<OrderRow> & { id: number }) => {
      const { id, ...rest } = body;
      const { data } = await apiClient.patch<OrderRow>(`/orders/${id}`, rest);
      return data;
    },
    onSuccess: () => {
      toast.success("订单条款已保存，新开的单证会带上这些条款");
      qc.invalidateQueries({ queryKey: ["upstream", "orders"] });
    },
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="订单"
        description="报价谈成后转订单；订单上的贸易条款会一路传到单证，避免单证与合同不一致。"
      />

      <SectionCard
        title="由报价单转订单"
        description="转化会复制货物行项、币种与贸易条款（贸易术语/付款方式/装卸港/唛头/原产国）。"
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
      </SectionCard>

      <SectionCard
        title="手动新建订单"
        description="历史订单 / 线下成交的单：客户必选，报价可选（有报价就按转单处理，没有就直接归到该客户名下）。"
      >
        <OrderCreateForm onCreated={(order) => setSelectedId(order.id)} />
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
            <details className="relative">
              <summary className="cursor-pointer list-none rounded-md border px-2 py-1.5 text-xs hover:bg-muted">
                列配置
              </summary>
              <div className="absolute right-0 z-20 mt-1 w-44 rounded-lg border bg-white p-2 shadow-lg">
                {ORDER_COLUMNS.map((c) => (
                  <label
                    key={c.key}
                    className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs hover:bg-muted"
                  >
                    <input
                      type="checkbox"
                      checked={visibleCols.includes(c.key)}
                      onChange={() => {
                        const next = visibleCols.includes(c.key)
                          ? visibleCols.filter((k) => k !== c.key)
                          : [...visibleCols, c.key];
                        // 至少保留一列，避免表格变成空壳
                        if (next.length > 0) setVisibleCols(next);
                      }}
                    />
                    {c.label}
                  </label>
                ))}
              </div>
            </details>
          </div>
        }
      >
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
            title="还没有订单"
            description="从上面的报价单转一张订单试试。"
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
                          <span className="inline-flex items-center gap-1">
                            {o.order_no}
                            <CopyButton value={o.order_no} label="复制订单号" />
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
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setSelectedId(o.id)}
                        >
                          条款
                        </Button>
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

      {selected && (
        <SectionCard
          title={`贸易条款 · ${selected.order_no}`}
          description="这些字段会被单证继承。留空会让单证上对应栏位空白，报关/审单可能因此被退。"
          action={
            <Button
              size="sm"
              variant="outline"
              onClick={() => setSelectedId(null)}
            >
              关闭
            </Button>
          }
        >
          <TermsForm
            key={selected.id}
            order={selected}
            saving={saveTerms.isPending}
            onSave={(patch) => saveTerms.mutate({ id: selected.id, ...patch })}
          />
        </SectionCard>
      )}
    </div>
  );
}

const TERM_FIELDS: { key: keyof OrderRow; label: string; hint?: string }[] = [
  { key: "incoterm", label: "贸易术语", hint: "如 FOB Tianjin / CIF Brisbane" },
  {
    key: "payment_terms",
    label: "付款方式",
    hint: "如 T/T 30% deposit, balance against B/L copy",
  },
  {
    key: "port_of_loading",
    label: "装运港",
    hint: "如 Xingang, Tianjin, China",
  },
  {
    key: "port_of_destination",
    label: "目的港",
    hint: "如 Brisbane, Australia",
  },
  { key: "shipping_marks", label: "唛头", hint: "无唛头填 N/M" },
  { key: "country_of_origin", label: "原产国", hint: "如 China" },
];

function TermsForm({
  order,
  saving,
  onSave,
}: {
  order: OrderRow;
  saving: boolean;
  onSave: (patch: Partial<OrderRow>) => void;
}) {
  const [draft, setDraft] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      TERM_FIELDS.map((f) => [f.key as string, (order[f.key] as string) ?? ""]),
    ),
  );

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        {TERM_FIELDS.map((field) => (
          <label key={field.key as string} className="space-y-1">
            <span className="text-sm font-medium">{field.label}</span>
            <Input
              value={draft[field.key as string] ?? ""}
              placeholder={field.hint}
              onChange={(e) =>
                setDraft((prev) => ({ ...prev, [field.key]: e.target.value }))
              }
            />
          </label>
        ))}
      </div>
      <Button
        disabled={saving}
        onClick={() => onSave(draft as Partial<OrderRow>)}
      >
        {saving ? "保存中…" : "保存条款"}
      </Button>
    </div>
  );
}
