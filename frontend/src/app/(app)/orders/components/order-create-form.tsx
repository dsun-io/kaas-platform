"use client";

/**
 * 手动新建订单 —— 「历史订单 / 线下成交」的正规入口。
 *
 * 为什么要有这个入口（而不是只留"由报价转订单"）：
 *   业务明确要求支持手动新建订单并支持导入历史数据（设计文档 §1.6）。
 *   这类订单没有报价这一环，唯一的归属就是**业务客户**，
 *   所以客户必选、报价可选（有就挂上，在客户页的树里出现在该报价下；
 *   没有就直接归到客户的「直接挂客户」分组）。
 *
 * 客户与报价不一致时只给提示、不阻断：
 *   后端 `POST /orders` 在传了 `customer_id` 时以传入的为准，
 *   而单据归属错了比"多一条提示"严重得多，因此把差异显式说出来让业务自己确认。
 */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FilePlus2 } from "lucide-react";
import { toast } from "sonner";

import {
  CustomerPicker,
  type CustomerPickerValue,
} from "@/components/customer-picker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import apiClient from "@/lib/api/client";
import {
  toCustomerIdPayload,
  useQuoteOptions,
  type OrderOption,
} from "@/lib/workstation/use-upstream";

interface OrderCreateBody {
  customer_id: number | string;
  customer_name: string;
  quote_order_id?: number;
  currency?: string;
  notes?: string;
}

export function OrderCreateForm({
  onCreated,
}: {
  onCreated?: (order: OrderOption) => void;
}) {
  const qc = useQueryClient();
  const quotes = useQuoteOptions();

  const [customer, setCustomer] = useState<CustomerPickerValue | null>(null);
  const [quoteId, setQuoteId] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);

  const selectedQuote =
    (quotes.data ?? []).find((q) => String(q.id) === quoteId) ?? null;
  const customerMismatch =
    !!selectedQuote?.customer_name &&
    !!customer?.name &&
    selectedQuote.customer_name !== customer.name;

  const create = useMutation({
    mutationFn: async (body: OrderCreateBody) => {
      const { data } = await apiClient.post<OrderOption>("/orders", body);
      return data;
    },
    onSuccess: (order, body) => {
      toast.success(
        body.quote_order_id
          ? `已由报价生成订单 ${order.order_no}（贸易条款已继承）`
          : `已新建订单 ${order.order_no}（直接挂客户）`,
      );
      setQuoteId("");
      setNotes("");
      qc.invalidateQueries({ queryKey: ["upstream", "orders"] });
      // 客户页的「往来记录」树里立刻能看到这张新单
      qc.invalidateQueries({ queryKey: ["customer-records"] });
      onCreated?.(order);
    },
    onError: () => {
      // 具体错误信息由 apiClient 的响应拦截器统一提示；
      // 这里补一句业务口径，避免用户以为"点了没反应"
      setError("建单失败：请确认所选客户存在、未删除且属于本团队，然后重试。");
    },
  });

  const submit = () => {
    if (!customer) {
      setError(
        "请选择业务客户 —— 订单必须归属到客户，否则在客户页查不到这张单",
      );
      return;
    }
    setError(null);
    const body: OrderCreateBody = {
      customer_id: toCustomerIdPayload(customer.id),
      customer_name: customer.name,
    };
    if (quoteId) body.quote_order_id = Number(quoteId);
    if (currency.trim()) body.currency = currency.trim().toUpperCase();
    if (notes.trim()) body.notes = notes.trim();
    create.mutate(body);
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <CustomerPicker
          value={customer}
          onChange={(next) => {
            setCustomer(next);
            setError(null);
          }}
          required
          hint="订单上的客户是后续单证与往来记录树的归属依据"
        />

        <div className="space-y-1.5">
          <Label className="text-xs">关联报价单（可选）</Label>
          <select
            className="h-8 w-full rounded-lg border border-input bg-background px-2 text-xs"
            value={quoteId}
            onChange={(e) => setQuoteId(e.target.value)}
          >
            <option value="">（不关联 —— 直接挂客户）</option>
            {(quotes.data ?? []).map((q) => (
              <option key={q.id} value={String(q.id)}>
                {q.quote_no} · {q.customer_name ?? "未填客户"} · {q.currency}{" "}
                {q.total_amount ?? "-"}
              </option>
            ))}
          </select>
          <p className="text-[11px] text-muted-foreground">
            选了报价会按「转订单」处理：复制货物行项与贸易条款
          </p>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">币种</Label>
          <Input
            value={currency}
            onChange={(e) => setCurrency(e.target.value.toUpperCase())}
            className="h-8 text-xs"
          />
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">备注</Label>
          <Input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="如：2025 年线下签约的历史订单"
            className="h-8 text-xs"
          />
        </div>
      </div>

      {customerMismatch && (
        <p className="text-xs text-warning">
          提示：所选报价的客户是「{selectedQuote?.customer_name}」，
          与上面选的「{customer?.name}」不一致。请确认是不是同一家客户 ——
          订单会按上面选的客户落库，在客户页的树里也会挂到那家名下。
        </p>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}

      <Button onClick={submit} disabled={create.isPending}>
        <FilePlus2 className="mr-1 h-4 w-4" />
        {create.isPending ? "建单中…" : "新建订单"}
      </Button>
    </div>
  );
}
