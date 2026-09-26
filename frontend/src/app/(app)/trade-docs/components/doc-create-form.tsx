"use client";

/**
 * 开单表单：选单证类型 + 选上游来源（订单 / 报价单 / 询盘）+ 币种。
 *
 * 关键设计
 * --------
 * - 单证类型来自模板清单（manifest），所以「能选的类型」一定「渲染得出来」，
 *   不会出现选了某类型却打不开的情况。
 * - 类型按业务分组展示（出口商自制 / 第三方签发 / 通用），
 *   并标注「第三方签发」—— 这类单据本系统只出申报信息，不是正式凭证，
 *   提前讲清楚，避免用户以为打印出来就能用。
 */
import { useMemo, useState } from "react";
import { FilePlus2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getAvailableTemplates } from "@/lib/trade-doc/render";
import {
  useOrderOptions,
  useQuoteOptions,
} from "@/lib/workstation/use-upstream";

import { useCreateTradeDoc } from "../hooks/use-trade-docs";
import { DOC_TYPE_GROUPS, THIRD_PARTY_TYPES } from "../lib/doc-type-groups";

type SourceKind = "order" | "quote" | "inquiry" | "none";

export function DocCreateForm({
  onCreated,
}: {
  onCreated?: (id: number) => void;
}) {
  const templates = useMemo(() => getAvailableTemplates(), []);
  const [docType, setDocType] = useState("ci");
  const [sourceKind, setSourceKind] = useState<SourceKind>("order");
  const [sourceId, setSourceId] = useState("");
  const [currency, setCurrency] = useState("USD");

  const orders = useOrderOptions();
  const quotes = useQuoteOptions();

  const create = useCreateTradeDoc();

  const submit = () => {
    const payload: Parameters<typeof create.mutate>[0] = {
      doc_type: docType,
      currency,
    };
    if (sourceKind === "order") {
      if (!sourceId) return toast.error("请选择来源订单");
      payload.order_id = Number(sourceId);
    } else if (sourceKind === "quote") {
      if (!sourceId) return toast.error("请选择来源报价单");
      payload.quote_order_id = Number(sourceId);
    } else if (sourceKind === "inquiry") {
      if (!sourceId) return toast.error("请输入询盘编号");
      payload.inquiry_id = Number(sourceId);
    }
    // 后端要求至少一个上游来源；无上游时用客户维度挂靠，避免"孤儿单据"
    if (sourceKind === "none") {
      toast.error("单证必须关联一个上游来源（订单 / 报价单 / 询盘）");
      return;
    }

    create.mutate(payload, {
      onSuccess: (doc) => {
        toast.success(`已开单 ${doc.doc_no}`);
        onCreated?.(doc.id);
      },
    });
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1">
          <span className="text-sm font-medium">单证类型</span>
          <select
            className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            value={docType}
            onChange={(e) => setDocType(e.target.value)}
          >
            {DOC_TYPE_GROUPS.map((group) => (
              <optgroup key={group.label} label={group.label}>
                {group.types
                  .map((type) => templates.find((t) => t.doc_type === type))
                  .filter((t): t is NonNullable<typeof t> => Boolean(t))
                  .map((t) => (
                    <option key={t.doc_type} value={t.doc_type}>
                      {t.name_zh} · {t.name_en}
                      {THIRD_PARTY_TYPES.has(t.doc_type)
                        ? "（第三方签发）"
                        : ""}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
          <span className="block text-xs text-muted-foreground">
            {templates.find((t) => t.doc_type === docType)?.description}
          </span>
        </label>

        <label className="space-y-1">
          <span className="text-sm font-medium">上游来源</span>
          <select
            className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            value={sourceKind}
            onChange={(e) => {
              setSourceKind(e.target.value as SourceKind);
              setSourceId("");
            }}
          >
            <option value="order">订单</option>
            <option value="quote">报价单</option>
            <option value="inquiry">询盘（手输编号）</option>
          </select>
          <span className="block text-xs text-muted-foreground">
            单据会继承上游的货物、金额与贸易条款
          </span>
        </label>

        <label className="space-y-1 sm:col-span-2">
          <span className="text-sm font-medium">选择具体来源</span>
          {sourceKind === "order" && (
            <select
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              value={sourceId}
              onChange={(e) => setSourceId(e.target.value)}
            >
              <option value="">— 请选择订单 —</option>
              {(orders.data ?? []).map((o) => (
                <option key={o.id} value={String(o.id)}>
                  {o.order_no} · {o.customer_name ?? "未填客户"} · {o.currency}{" "}
                  {o.total_amount ?? "-"}
                </option>
              ))}
            </select>
          )}
          {sourceKind === "quote" && (
            <select
              className="h-9 w-full md:w-full rounded-md border border-input bg-background px-2 text-sm"
              value={sourceId}
              onChange={(e) => setSourceId(e.target.value)}
            >
              <option value="">— 请选择报价单 —</option>
              {(quotes.data ?? []).map((q) => (
                <option key={q.id} value={String(q.id)}>
                  {q.quote_no} · {q.customer_name ?? "未填客户"} · {q.currency}{" "}
                  {q.total_amount ?? "-"}
                </option>
              ))}
            </select>
          )}
          {sourceKind === "inquiry" && (
            <Input
              placeholder="询盘编号（数字 ID）"
              value={sourceId}
              onChange={(e) => setSourceId(e.target.value)}
            />
          )}
          {sourceKind === "order" && orders.data?.length === 0 && (
            <span className="block text-xs text-amber-700">
              还没有订单。请先在「订单」工位建单，或改选「报价单」。
            </span>
          )}
        </label>

        <label className="space-y-1">
          <span className="text-sm font-medium">币种</span>
          <Input
            value={currency}
            onChange={(e) => setCurrency(e.target.value.toUpperCase())}
          />
        </label>
      </div>

      <Button onClick={submit} disabled={create.isPending}>
        <FilePlus2 className="mr-1 h-4 w-4" />
        {create.isPending ? "开单中…" : "开单"}
      </Button>
    </div>
  );
}
