"use client";

/**
 * 订单工位 —— 报价转订单、订单条款维护、收款计划与应收概览。
 *
 * 业务位置：报价谈成 → 转订单 → 建收款计划 → 备货出运 → 按订单开单证。
 * 订单上的**贸易条款**（贸易术语/付款方式/装卸港/唛头/原产国）是单证的核心输入，
 * 所以这里必须能看、能改；否则单证就只能手工重填，极易与合同不一致。
 */
import { useState } from "react";
import { AlertCircle, Bell, Plus, Upload } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { ImportExistingDataDialog } from "@/components/import-existing-data-dialog";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge } from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import apiClient from "@/lib/api/client";
import { usePageView } from "@/lib/events/use-page-view";
import {
  useOrderOptions,
  useQuoteOptions,
  type OrderOption,
} from "@/lib/workstation/use-upstream";

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

export default function OrdersPage() {
  usePageView({ resource_id: "/orders" });
  const qc = useQueryClient();
  const list = useOrderOptions();
  const quotes = useQuoteOptions();
  const [quoteId, setQuoteId] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [showImport, setShowImport] = useState(false);

  const selected = list.data?.find((o) => o.id === selectedId) ?? null;

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
        actions={
          <Button variant="outline" onClick={() => setShowImport(true)}>
            <Upload className="mr-1 h-4 w-4" />
            导入已有数据
          </Button>
        }
      />

      <ImportExistingDataDialog
        open={showImport}
        onOpenChange={setShowImport}
        resourceLabel="订单"
        columnsHint="订单号、客户、币种、金额、订单日期、贸易术语、付款方式、装运港、目的港（列名以实际导出模板为准）"
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

      <SectionCard title="订单列表">
        {list.isLoading ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            加载中…
          </p>
        ) : list.isError ? (
          <div className="flex items-center gap-2 py-8 text-sm text-destructive">
            <AlertCircle className="h-4 w-4" />
            读取订单失败。请确认后端服务已启动。
          </div>
        ) : (list.data?.length ?? 0) === 0 ? (
          <EmptyState
            icon={Bell}
            title="还没有订单"
            description="从上面的报价单转一张订单试试。"
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="p-2">订单号</th>
                  <th className="p-2">客户</th>
                  <th className="p-2">状态</th>
                  <th className="p-2">金额</th>
                  <th className="p-2">贸易术语</th>
                  <th className="p-2">付款方式</th>
                  <th className="p-2">目的港</th>
                  <th className="p-2" />
                </tr>
              </thead>
              <tbody>
                {list.data!.map((o) => (
                  <tr
                    key={o.id}
                    className="border-b last:border-0 hover:bg-muted/40"
                  >
                    <td className="p-2 font-medium">{o.order_no}</td>
                    <td className="p-2">{o.customer_name ?? "—"}</td>
                    <td className="p-2">
                      <StatusBadge tone={STATUS_TONE[o.status] ?? "default"}>
                        {STATUS_LABEL[o.status] ?? o.status}
                      </StatusBadge>
                    </td>
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
                    <td className="p-2">
                      {o.incoterm || <span className="text-warning">未填</span>}
                    </td>
                    <td
                      className="p-2 max-w-[220px] truncate"
                      title={o.payment_terms ?? ""}
                    >
                      {o.payment_terms || (
                        <span className="text-warning">未填</span>
                      )}
                    </td>
                    <td className="p-2">{o.port_of_destination || "—"}</td>
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
