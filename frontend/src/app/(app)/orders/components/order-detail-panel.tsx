"use client";

/**
 * 订单详情面板（§13.3）：金额构成 / 货物明细 / 贸易条款。
 *
 * 数据来自 `GET /orders/{id}`（金额构成 + items + payment_schedules + receipts）。
 * 收款计划与附件是独立面板（`PaymentSchedulesPanel` / `OrderAttachmentsPanel`），
 * 因为它们的读写与失效范围不同，合在一起会让组件过大、也无法单独复用。
 *
 * 历史订单没有 amount_breakdown：金额构成回退为「货物行合计 + total_amount」，
 * 并明确提示「历史订单未拆费用」，不伪造运费/保险等四项。
 */
import { useMemo, useState } from "react";
import { AlertCircle, PencilLine, X } from "lucide-react";
import { toast } from "sonner";

import {
  DataTable,
  type DataTableColumn,
} from "@/components/shared/data-table";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge } from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ORDER_STATUS_LABEL } from "@/lib/orders/order-status";
import {
  formatOrderDate,
  formatOrderMoney,
  orderItemSpecText,
  resolveAmountBreakdown,
  type OrderDetail,
} from "@/lib/orders/order-detail";

import { orderItemsEditMode } from "@/lib/orders/item-change";

import { useOrderChangeRequests } from "../hooks/use-order-items";
import { useOrderDetail, useUpdateOrderTerms } from "../hooks/use-order-detail";

import { OrderChangeBanner } from "./order-change-banner";
import { OrderItemsEditor } from "./order-items-editor";
import { OrderSourceChain } from "./order-source-chain";

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

const TERM_FIELDS: {
  key: string;
  label: string;
  hint?: string;
}[] = [
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

export function OrderDetailPanel({
  orderId,
  onClose,
}: {
  orderId: number;
  onClose: () => void;
}) {
  const detail = useOrderDetail(orderId);
  const saveTerms = useUpdateOrderTerms(orderId);
  const changeRequests = useOrderChangeRequests(orderId);
  const [editingItems, setEditingItems] = useState(false);

  if (detail.isLoading) {
    return (
      <SectionCard title="订单详情">
        <div className="space-y-2" aria-busy="true" aria-label="订单详情加载中">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-8 w-full rounded-md" />
          ))}
        </div>
      </SectionCard>
    );
  }

  if (detail.isError || !detail.data) {
    return (
      <SectionCard
        title="订单详情"
        action={
          <Button size="sm" variant="outline" onClick={onClose}>
            关闭
          </Button>
        }
      >
        <p className="flex items-center gap-2 py-4 text-sm text-destructive">
          <AlertCircle className="h-4 w-4" />
          订单详情读取失败。请刷新重试。
        </p>
      </SectionCard>
    );
  }

  const order = detail.data;
  const { breakdown, total, fallback } = resolveAmountBreakdown(order);
  const items = order.items ?? [];
  const currency = order.currency ?? null;
  // U-P0C：货物明细列表改用共享 DataTable（no-bare-table）；行 key 兼容历史行无 id。
  const itemRows = items.map((item, index) => ({
    ...item,
    rowKey: item.id != null ? String(item.id) : `item-${index}`,
  }));
  const itemColumns: DataTableColumn<(typeof itemRows)[number]>[] = [
    {
      key: "product_name",
      header: "产品",
      render: (row) => row.product_name ?? "—",
    },
    {
      key: "spec",
      header: "规格",
      className: "max-w-[240px] truncate",
      render: (row) => orderItemSpecText(row) || "—",
    },
    {
      key: "qty",
      header: "数量",
      className: "tabular-nums",
      render: (row) => `${row.qty ?? "—"} ${row.qty_unit ?? ""}`,
    },
    {
      key: "unit_price",
      header: "单价",
      className: "tabular-nums",
      render: (row) =>
        formatOrderMoney(row.unit_price, row.currency ?? currency),
    },
    {
      key: "line_amount",
      header: "金额",
      className: "tabular-nums",
      render: (row) =>
        formatOrderMoney(row.line_amount, row.currency ?? currency),
    },
  ];

  return (
    <>
      <SectionCard
        title={`订单详情 · ${order.order_no}`}
        description="金额构成 = 货物金额 + 运费 + 保险费 + 其他费用；订单总额以订单头为准。"
        action={
          <Button size="sm" variant="outline" onClick={onClose}>
            <X className="mr-1 h-4 w-4" />
            关闭
          </Button>
        }
      >
        <OrderSourceChain order={order} />
        <OrderChangeBanner
          orderId={order.id}
          currency={currency}
          requests={changeRequests.data?.items ?? []}
        />

        <div className="mb-4 flex flex-wrap items-center gap-3 text-sm">
          <StatusBadge tone={STATUS_TONE[order.status] ?? "default"}>
            {ORDER_STATUS_LABEL[order.status] ?? order.status}
          </StatusBadge>
          <span className="text-muted-foreground">
            客户：{order.customer_name ?? "—"}
          </span>
          <span className="text-muted-foreground">
            订单日期：{formatOrderDate(order.order_date)}
          </span>
          <span className="text-muted-foreground">
            交货日期：{formatOrderDate(order.delivery_date)}
          </span>
          <span className="ml-auto font-medium tabular-nums">
            订单总额 {formatOrderMoney(total, currency)}
          </span>
        </div>

        <div className="grid gap-3 lg:grid-cols-[minmax(0,340px)_1fr]">
          <div className="rounded-lg border p-3">
            <h3 className="mb-2 text-sm font-medium">金额构成</h3>
            <dl className="space-y-1 text-sm">
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">货物金额</dt>
                <dd className="tabular-nums">
                  {formatOrderMoney(breakdown.goods_amount, currency)}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">运费</dt>
                <dd className="tabular-nums">
                  {fallback
                    ? "—"
                    : formatOrderMoney(breakdown.freight_amount, currency)}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">保险费</dt>
                <dd className="tabular-nums">
                  {fallback
                    ? "—"
                    : formatOrderMoney(breakdown.insurance_amount, currency)}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">其他费用</dt>
                <dd className="tabular-nums">
                  {fallback
                    ? "—"
                    : formatOrderMoney(breakdown.other_amount, currency)}
                </dd>
              </div>
              <div className="flex justify-between gap-4 border-t pt-1">
                <dt className="font-medium">订单总额</dt>
                <dd className="font-semibold tabular-nums">
                  {formatOrderMoney(total, currency)}
                </dd>
              </div>
            </dl>
            {fallback && (
              <p className="mt-2 text-[11px] text-warning">
                历史订单没有单独记录运费/保险/其他，这里只展示货物行合计与订单总额；
                新单建单时会拆开保存。
              </p>
            )}
          </div>

          <div className="min-w-0">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-medium">货物明细</h3>
              {!editingItems && (
                <Button
                  size="sm"
                  variant="outline"
                  className="ml-auto h-7 px-2 text-xs"
                  onClick={() => setEditingItems(true)}
                >
                  <PencilLine className="mr-1 size-3.5" />
                  {orderItemsEditMode(order.status) === "direct"
                    ? "编辑明细"
                    : "申请变更明细"}
                </Button>
              )}
            </div>
            {editingItems ? (
              <OrderItemsEditor
                orderId={order.id}
                status={order.status}
                currency={currency}
                items={items}
                onClose={() => setEditingItems(false)}
              />
            ) : items.length === 0 ? (
              <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
                这张订单没有货物行（历史订单/线下成交可能只记了金额）。
                线下单/历史单可直接点「编辑明细」补录；报价谈成的单也可以回到报价工位改后重新转单。
              </p>
            ) : (
              <DataTable
                columns={itemColumns}
                rows={itemRows}
                getRowKey={(row) => row.rowKey}
                caption="订单货物明细"
              />
            )}
            {order.notes && (
              <p className="mt-2 text-xs text-muted-foreground">
                备注：{order.notes}
              </p>
            )}
          </div>
        </div>
      </SectionCard>

      <TermsCard
        key={order.id}
        order={order}
        saving={saveTerms.isPending}
        onSave={async (patch) => {
          try {
            await saveTerms.mutateAsync(patch);
            toast.success("订单条款已保存，新开的单证会带上这些条款");
          } catch {
            toast.error("保存条款失败，请重试");
          }
        }}
      />
    </>
  );
}

function TermsCard({
  order,
  saving,
  onSave,
}: {
  order: OrderDetail;
  saving: boolean;
  onSave: (patch: Record<string, string>) => Promise<void>;
}) {
  const initial = useMemo(
    () =>
      Object.fromEntries(
        TERM_FIELDS.map((field) => {
          const value = (order as unknown as Record<string, unknown>)[
            field.key
          ];
          return [field.key, typeof value === "string" ? value : ""];
        }),
      ),
    [order],
  );
  const [draft, setDraft] = useState<Record<string, string>>(initial);

  return (
    <SectionCard
      title="贸易条款"
      description="这些字段会被单证继承。留空会让单证上对应栏位空白，报关/审单可能因此被退。"
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {TERM_FIELDS.map((field) => (
          <label key={field.key} className="space-y-1">
            <span className="text-sm font-medium">{field.label}</span>
            <Input
              aria-label={field.label}
              value={draft[field.key] ?? ""}
              placeholder={field.hint}
              onChange={(e) =>
                setDraft((prev) => ({ ...prev, [field.key]: e.target.value }))
              }
            />
          </label>
        ))}
      </div>
      <Button
        className="mt-3"
        disabled={saving}
        onClick={() => void onSave(draft)}
      >
        {saving ? "保存中…" : "保存条款"}
      </Button>
    </SectionCard>
  );
}
