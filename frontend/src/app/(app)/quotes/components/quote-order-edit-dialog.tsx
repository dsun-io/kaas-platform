"use client";

/**
 * 报价单编辑弹窗（设计 §9.3）：行项整批替换 + 条款 + 状态流转 + 备注。
 *
 * 锁定规则（后端判、前端明示）：
 *   · 已转订单/已开单证（`quote_no_editable === false`）⇒ 行项与金额锁定；
 *   · 已签发（status ≠ draft）⇒ 行项锁定（签发后是法律凭证）；
 *   · 两种情况下**只留状态流转与备注**，并在弹窗顶部写明原因。
 *
 * 保存顺序：先 `PUT /quotes/{id}/items`（可编辑时），再 `PATCH /quotes/{id}`。
 * 任一步失败都停在这里并展示后端原因（409/422 原样透出），不假装成功。
 */
import { useState } from "react";
import { AlertCircle, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { normalizeApiError } from "@/lib/api/api-error";
import type {
  QuoteOrder,
  QuoteOrderItem,
  QuoteOrderItemIn,
  QuoteOrderPatch,
} from "@contracts/quote-order";

import {
  useReplaceQuoteItems,
  useUpdateQuoteOrder,
} from "../hooks/use-quote-orders";
import {
  buildQuoteItemsPayload,
  buildQuotePatch,
  makeQuoteItemDraft,
  QUOTE_TERM_FIELDS,
  quoteItemDrafts,
  quoteLockReason,
  quoteStatusSelectOptions,
  quoteTermsFromOrder,
  sumQuoteDrafts,
  validateQuoteItemDrafts,
  type QuoteItemDraft,
  type QuoteTermsDraft,
} from "./quote-order-edit";

const QTY_UNITS = ["ROLLS", "PCS", "SET", "M", "M2", "KG", "TON", "CTN"];

function money(value: number, currency: string): string {
  return `${currency} ${value.toFixed(2)}`;
}

export function QuoteOrderEditDialog({
  open,
  quote,
  items,
  onClose,
}: {
  open: boolean;
  quote: QuoteOrder | null;
  items: QuoteOrderItem[];
  onClose: () => void;
}) {
  const update = useUpdateQuoteOrder();
  const replaceItems = useReplaceQuoteItems();
  const [drafts, setDrafts] = useState<QuoteItemDraft[]>(() =>
    quoteItemDrafts(items),
  );
  const [terms, setTerms] = useState<QuoteTermsDraft>(() =>
    quote ? quoteTermsFromOrder(quote) : ({} as QuoteTermsDraft),
  );
  const [notes, setNotes] = useState(quote?.notes ?? "");
  const [status, setStatus] = useState(quote?.status ?? "draft");
  const [error, setError] = useState<string | null>(null);

  if (!quote) return null;

  const lockReason = quoteLockReason(quote);
  const pending = update.isPending || replaceItems.isPending;
  const currency = quote.currency ?? "USD";
  const total = sumQuoteDrafts(drafts);

  const addRow = () => setDrafts((prev) => [...prev, makeQuoteItemDraft()]);
  const removeRow = (key: string) =>
    setDrafts((prev) => prev.filter((item) => item.key !== key));
  const patchDraft = (key: string, patch: Partial<QuoteItemDraft>) =>
    setDrafts((prev) =>
      prev.map((item) => (item.key === key ? { ...item, ...patch } : item)),
    );

  const save = async () => {
    setError(null);
    // 锁定时只允许状态流转与备注：尽管后端 PATCH 不会因状态拒改条款，
    // 前端也不能在"只读"界面上把未变的条款当成一次修改提交。
    const patch: QuoteOrderPatch = buildQuotePatch({
      terms: lockReason ? quoteTermsFromOrder(quote) : terms,
      notes,
      status,
      currentStatus: quote.status,
    });

    let nextItems: QuoteOrderItemIn[] | null = null;
    if (!lockReason) {
      if (drafts.length === 0) {
        setError("报价单至少要有一行产品；要作废请改状态并备注原因。");
        return;
      }
      const itemErrors = validateQuoteItemDrafts(drafts);
      if (itemErrors.length > 0) {
        setError(itemErrors[0] ?? null);
        return;
      }
      nextItems = buildQuoteItemsPayload(drafts, currency);
    }

    try {
      if (nextItems) {
        await replaceItems.mutateAsync({ id: quote.id, items: nextItems });
      }
      await update.mutateAsync({ id: quote.id, patch });
      toast.success(
        patch.status
          ? `报价单已保存，状态流转到「${patch.status}」`
          : "报价单已保存（行项/条款已更新，报价单文件随之同步）",
      );
      onClose();
    } catch (err) {
      const normalized = normalizeApiError(err);
      const hint =
        normalized.code === "QUOTE_NOT_EDITABLE"
          ? "该报价已签发：行项只能整单重开后再改。"
          : normalized.code === "QUOTE_NO_LOCKED"
            ? "该报价已有下游订单/单证，单号锁定。"
            : null;
      setError(hint ?? normalized.message);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>编辑报价单 {quote.quote_no}</DialogTitle>
        </DialogHeader>

        {lockReason && (
          <p
            role="note"
            className="rounded-md border border-warning/40 bg-warning-muted px-3 py-2 text-xs text-warning-muted-foreground"
          >
            锁定：{lockReason}
          </p>
        )}

        <div className="space-y-2">
          <p className="text-xs font-medium">
            产品明细{lockReason ? "（只读）" : ""}
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th scope="col" className="p-2">
                    产品
                  </th>
                  <th scope="col" className="p-2">
                    规格
                  </th>
                  <th scope="col" className="p-2">
                    数量
                  </th>
                  <th scope="col" className="p-2">
                    单位
                  </th>
                  <th scope="col" className="p-2">
                    单价
                  </th>
                  <th scope="col" className="p-2">
                    行金额
                  </th>
                  {!lockReason && (
                    <th scope="col" className="p-2">
                      <span className="sr-only">操作</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {drafts.map((draft, index) => {
                  const label = `第 ${index + 1} 行`;
                  return (
                    <tr
                      key={draft.key}
                      className="border-b last:border-0 align-top"
                    >
                      <td className="p-1">
                        <Input
                          aria-label={`${label}产品`}
                          className="h-8 min-w-[130px] text-xs"
                          value={draft.product_name}
                          disabled={!!lockReason}
                          onChange={(e) =>
                            patchDraft(draft.key, {
                              product_name: e.target.value,
                            })
                          }
                        />
                      </td>
                      <td className="p-1">
                        <Input
                          aria-label={`${label}规格`}
                          className="h-8 min-w-[130px] text-xs"
                          value={draft.spec_text}
                          disabled={!!lockReason}
                          onChange={(e) =>
                            patchDraft(draft.key, { spec_text: e.target.value })
                          }
                        />
                      </td>
                      <td className="p-1">
                        <Input
                          aria-label={`${label}数量`}
                          className="h-8 w-20 text-xs tabular-nums"
                          value={draft.qty}
                          disabled={!!lockReason}
                          onChange={(e) =>
                            patchDraft(draft.key, { qty: e.target.value })
                          }
                        />
                      </td>
                      <td className="p-1">
                        <select
                          aria-label={`${label}单位`}
                          className="h-8 w-24 rounded-md border border-input bg-background px-1 text-xs"
                          value={draft.qty_unit}
                          disabled={!!lockReason}
                          onChange={(e) =>
                            patchDraft(draft.key, { qty_unit: e.target.value })
                          }
                        >
                          {QTY_UNITS.map((unit) => (
                            <option key={unit} value={unit}>
                              {unit}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="p-1">
                        <Input
                          aria-label={`${label}单价`}
                          className="h-8 w-24 text-xs tabular-nums"
                          value={draft.unit_price}
                          disabled={!!lockReason}
                          onChange={(e) =>
                            patchDraft(draft.key, {
                              unit_price: e.target.value,
                            })
                          }
                        />
                      </td>
                      <td className="p-2 text-xs tabular-nums">
                        {money(
                          Number(draft.qty) * Number(draft.unit_price) || 0,
                          currency,
                        )}
                      </td>
                      {!lockReason && (
                        <td className="p-1">
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            aria-label={`删除${label}`}
                            onClick={() => removeRow(draft.key)}
                          >
                            <Trash2 className="size-3.5" />
                          </Button>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {!lockReason && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={addRow}
              >
                <Plus className="mr-1 size-3.5" />
                添加产品行
              </Button>
            )}
            <span className="text-xs text-muted-foreground">
              行项合计 {money(total, currency)}
            </span>
          </div>
        </div>

        <div className="grid gap-2 sm:grid-cols-2">
          {QUOTE_TERM_FIELDS.map((field) => (
            <label key={field.key} className="space-y-1">
              <span className="text-xs text-muted-foreground">
                {field.label}
              </span>
              <Input
                aria-label={field.label}
                className="h-8 text-xs"
                value={terms[field.key] ?? ""}
                disabled={!!lockReason}
                onChange={(e) =>
                  setTerms((prev) => ({ ...prev, [field.key]: e.target.value }))
                }
              />
            </label>
          ))}
        </div>

        <label className="block space-y-1">
          <span className="text-xs text-muted-foreground">备注</span>
          <Textarea
            aria-label="报价备注"
            className="min-h-[56px] text-sm"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </label>

        <label className="block space-y-1">
          <span className="text-xs text-muted-foreground">状态流转</span>
          <select
            aria-label="报价状态"
            className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            {quoteStatusSelectOptions(quote.status).map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <span className="text-[11px] text-muted-foreground">
            合法流转：
            {quoteStatusSelectOptions(quote.status)
              .slice(1)
              .map((option) => option.label)
              .join(" / ") || "终态，无后续流转"}
          </span>
        </label>

        {error && (
          <p
            role="alert"
            className="flex items-center gap-1 text-xs text-destructive"
          >
            <AlertCircle className="size-3.5" />
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={onClose}
          >
            取消
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={pending}
            onClick={() => void save()}
          >
            {pending ? "保存中…" : "保存报价单"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
