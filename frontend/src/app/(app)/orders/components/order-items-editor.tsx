"use client";

/**
 * 订单货物明细编辑（设计 §9.2 / §6.1）—— 行级增删改 + 整批替换提交。
 *
 * 交互口径：
 *   · 表格是**编辑态**（不是逐行弹窗）：货物行共 5~20 行，逐行弹窗反而更慢；
 *   · 提交是**整批替换**（与建单向导同一形状 `buildOrderItemsPayload`），
 *     后端按此重算 `total_amount`/`amount_breakdown`；
 *   · pending：直接 PATCH 生效；confirmed 及以后：必须填「变更原因」并提交审批申请，
 *     订单本身不变（D-8 审计链完整性）。
 *
 * 不提供"上移/下移"排序：全站排序唯一实现是拖拽（UI_STANDARDS §7），
 * 这里不引入排序入口，行序按现有顺序 + 追加。
 */
import { useMemo, useState } from "react";
import { AlertCircle, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { normalizeApiError } from "@/lib/api/api-error";
import {
  buildOrderItemsPayload,
  COMMON_QTY_UNITS,
  itemDraftAmount,
  itemDraftsFromQuote,
  makeItemDraft,
  recalcItemAmount,
  sumDraftItemsAmount,
  validateOrderItems,
  type OrderItemDraft,
} from "@/lib/orders/order-create";
import { formatOrderMoney, type OrderItem } from "@/lib/orders/order-detail";
import {
  orderItemsEditHint,
  orderItemsEditMode,
} from "@/lib/orders/item-change";

import {
  useCreateItemChangeRequest,
  useReplaceOrderItems,
} from "../hooks/use-order-items";

const ERROR_HINTS: Record<string, string> = {
  ORDER_ITEMS_LOCKED:
    "该订单已确认，明细改动必须走变更审批（本页会按审批模式提交）。",
  CHANGE_REQUEST_PENDING: "该订单已有一条待审批的变更申请，请先处理它。",
  INVALID_ITEMS: "货物明细不能为空，且每行数量必须大于 0。",
  INVALID_ITEM_NUMBER: "数量/单价/金额必须是数字。",
};

function updateDraft(
  items: OrderItemDraft[],
  key: string,
  patch: Partial<OrderItemDraft>,
): OrderItemDraft[] {
  return items.map((item) => {
    if (item.key !== key) return item;
    const next = { ...item, ...patch };
    // 改数量/单价时同步行金额（用户手改过金额的行保持原值）
    return patch.line_amount !== undefined ? next : recalcItemAmount(next);
  });
}

export function OrderItemsEditor({
  orderId,
  status,
  currency,
  items,
  onClose,
}: {
  orderId: number;
  status: string | null;
  currency: string | null;
  items: OrderItem[];
  onClose: () => void;
}) {
  const mode = orderItemsEditMode(status);
  const [drafts, setDrafts] = useState<OrderItemDraft[]>(() =>
    itemDraftsFromQuote(items),
  );
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const replaceItems = useReplaceOrderItems(orderId);
  const createRequest = useCreateItemChangeRequest(orderId);
  const pending = replaceItems.isPending || createRequest.isPending;
  const total = useMemo(() => sumDraftItemsAmount(drafts), [drafts]);

  const addRow = () => setDrafts((prev) => [...prev, makeItemDraft()]);
  const removeRow = (key: string) =>
    setDrafts((prev) => prev.filter((item) => item.key !== key));

  const submit = async () => {
    setError(null);
    if (drafts.length === 0) {
      setError("请至少保留一行货物明细（整批替换不能提交空数组）");
      return;
    }
    const itemErrors = validateOrderItems(drafts);
    if (itemErrors.length > 0) {
      setError(itemErrors[0] ?? null);
      return;
    }
    if (mode === "approval" && !reason.trim()) {
      setError("已确认订单的明细变更必须填写变更原因（审批留痕要求）");
      return;
    }
    const payload = buildOrderItemsPayload(drafts, currency ?? "USD");
    try {
      if (mode === "direct") {
        await replaceItems.mutateAsync(payload);
        toast.success("货物明细已保存，订单金额已按行项重算");
      } else {
        await createRequest.mutateAsync({
          items: payload,
          reason: reason.trim(),
        });
        toast.success("已提交变更申请：管理员批准后才会应用（订单当前不变）");
      }
      onClose();
    } catch (err) {
      const normalized = normalizeApiError(err);
      setError(ERROR_HINTS[normalized.code ?? ""] ?? normalized.message);
    }
  };

  return (
    <div className="space-y-3 rounded-lg border border-primary/30 bg-primary/5 p-3">
      <p className="text-xs text-muted-foreground">
        {orderItemsEditHint(mode)}
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
              <th scope="col" className="p-2">
                <span className="sr-only">操作</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {drafts.map((item, index) => {
              const label = `第 ${index + 1} 行`;
              return (
                <tr key={item.key} className="border-b last:border-0 align-top">
                  <td className="p-1">
                    <Input
                      aria-label={`${label}产品`}
                      className="h-8 min-w-[140px] text-xs"
                      value={item.product_name}
                      onChange={(e) =>
                        setDrafts((prev) =>
                          updateDraft(prev, item.key, {
                            product_name: e.target.value,
                          }),
                        )
                      }
                    />
                  </td>
                  <td className="p-1">
                    <Input
                      aria-label={`${label}规格`}
                      className="h-8 min-w-[140px] text-xs"
                      value={item.spec_text}
                      onChange={(e) =>
                        setDrafts((prev) =>
                          updateDraft(prev, item.key, {
                            spec_text: e.target.value,
                          }),
                        )
                      }
                    />
                  </td>
                  <td className="p-1">
                    <Input
                      aria-label={`${label}数量`}
                      className="h-8 w-20 text-xs tabular-nums"
                      inputMode="decimal"
                      value={item.qty}
                      onChange={(e) =>
                        setDrafts((prev) =>
                          updateDraft(prev, item.key, { qty: e.target.value }),
                        )
                      }
                    />
                  </td>
                  <td className="p-1">
                    <select
                      aria-label={`${label}单位`}
                      className="h-8 w-24 rounded-lg border border-input bg-background px-1 text-xs"
                      value={item.qty_unit}
                      onChange={(e) =>
                        setDrafts((prev) =>
                          updateDraft(prev, item.key, {
                            qty_unit: e.target.value,
                          }),
                        )
                      }
                    >
                      {COMMON_QTY_UNITS.map((unit) => (
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
                      inputMode="decimal"
                      value={item.unit_price}
                      onChange={(e) =>
                        setDrafts((prev) =>
                          updateDraft(prev, item.key, {
                            unit_price: e.target.value,
                          }),
                        )
                      }
                    />
                  </td>
                  <td className="p-2 text-xs tabular-nums">
                    {formatOrderMoney(itemDraftAmount(item), currency)}
                  </td>
                  <td className="p-1">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      aria-label={`删除${label}`}
                      onClick={() => removeRow(item.key)}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="outline" onClick={addRow}>
          <Plus className="mr-1 size-3.5" />
          添加货物行
        </Button>
        <span className="text-xs text-muted-foreground">
          货物金额合计 {formatOrderMoney(total, currency)}
        </span>
      </div>

      {mode === "approval" && (
        <label className="block space-y-1">
          <span className="text-xs font-medium">变更原因（必填）</span>
          <Textarea
            aria-label="变更原因"
            className="min-h-[60px] text-sm"
            placeholder="例如：客户追加 2 卷；单价按最新成本调整"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
      )}

      {error && (
        <p
          role="alert"
          className="flex items-center gap-1 text-xs text-destructive"
        >
          <AlertCircle className="size-3.5" />
          {error}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          disabled={pending}
          onClick={() => void submit()}
        >
          {pending
            ? "提交中…"
            : mode === "direct"
              ? "保存货物明细"
              : "提交变更申请"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={onClose}
        >
          取消
        </Button>
      </div>
    </div>
  );
}
