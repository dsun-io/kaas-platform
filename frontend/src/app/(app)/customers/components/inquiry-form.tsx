"use client";

/**
 * 「添加询盘」表单：一条询盘支持多个产品行（设计稿 docs/OPTIMIZATION_PLAN_2026-10-22_
 * PRODUCT_INQUIRY_ORDER.md §5 + §13.1 方案 A）。
 *
 * 交互（用户口径）：
 *  - 渠道 + 备注**共用**（一条询盘一个渠道、一个备注）；
 *  - 每个产品行：产品（可从产品库下拉选，也可手输）/ 规格说明 / 数量 / 单位 / 用途；
 *  - 「+ 再加一个产品」加行；行首「删除」删行（只剩一行时不显示删除）。
 *
 * 提交契约：POST /customers/{id}/inquiries，带 items[]（每行一个产品），
 * 同时把第一行同步进旧标量字段（product_name_raw / quantity / quantity_unit /
 * application）供历史消费方兼容。空行会被丢弃，不会产生垃圾明细。
 *
 * 产品库列表取不到（接口未就绪 / 无权限）时**不阻塞手输**：datalist 为空而已。
 */
import { useId, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { apiClient } from "@/lib/api/client";
import { useProducts } from "@/lib/products/use-products";

import { errMsg } from "./error-message";
import {
  buildInquiryPayload,
  emptyInquiryItemRow,
  resolveProductKey,
  type InquiryItemFormRow,
} from "./inquiry-items";

/**
 * 询盘渠道：**必须与后端枚举逐字一致**（kaas_common/domain/enums.py INQUIRY_CHANNEL：
 * email/whatsapp/alibaba/expo/website/quote/other）。2026-10-21（C28）修：此前这里是自由
 * 输入框（placeholder 写 Alibaba / Expo / Web），用户按提示填 Alibaba 会被后端
 * validate_enum 判 422 —— "按提示操作反而失败"。改用下拉，只发枚举值。
 */
const INQUIRY_CHANNEL_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "email", label: "邮件" },
  { value: "whatsapp", label: "WhatsApp" },
  { value: "alibaba", label: "阿里巴巴" },
  { value: "expo", label: "展会" },
  { value: "website", label: "官网" },
  { value: "quote", label: "报价" },
  { value: "other", label: "其他" },
];

export function InquiryForm({
  customerId,
  onClose,
}: {
  customerId: number;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const productListId = useId();
  /** 行 id 自增（删除中间行后 React 仍按 id 复用正确的输入框） */
  const rowSeq = useRef(1);
  const [channel, setChannel] = useState("");
  const [notes, setNotes] = useState("");
  const [rows, setRows] = useState<InquiryItemFormRow[]>(() => [
    emptyInquiryItemRow("row-1"),
  ]);
  const [error, setError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);

  // 产品库（GET /products）：选中名称后反查 product_key 一并提交；取不到不影响手输。
  const { data: productsData } = useProducts();
  const productOptions = (productsData?.items ?? []).map((item) => ({
    product_key: item.product_key,
    name: item.name,
  }));

  const updateRow = (id: string, patch: Partial<InquiryItemFormRow>) => {
    setRows((current) =>
      current.map((row) => (row.id === id ? { ...row, ...patch } : row)),
    );
  };
  const addRow = () => {
    rowSeq.current += 1;
    setRows((current) => [...current, emptyInquiryItemRow("row-" + rowSeq.current)]);
  };
  const removeRow = (id: string) => {
    setRows((current) =>
      current.length <= 1 ? current : current.filter((row) => row.id !== id),
    );
  };

  const handleSubmit = async () => {
    const { payload, error: validationError } = buildInquiryPayload({
      channel,
      notes,
      rows,
    });
    if (validationError) {
      setError(validationError);
      return;
    }
    setIsPending(true);
    setError(null);
    try {
      await apiClient.post(`/customers/${customerId}/inquiries`, {
        customer_id: customerId,
        ...payload,
      });
      qc.invalidateQueries({ queryKey: ["customers", "detail", customerId] });
      onClose();
    } catch (e: unknown) {
      setError(errMsg(e));
    } finally {
      setIsPending(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Select value={channel} onValueChange={(value) => setChannel(value ?? "")}>
          <SelectTrigger aria-label="询盘渠道">
            <SelectValue placeholder="渠道（可留空）" />
          </SelectTrigger>
          <SelectContent>
            {INQUIRY_CHANNEL_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          name="inquiry-notes"
          placeholder="备注（多个产品共用）"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </div>

      {/* 产品库候选：native datalist ⇒ 同一个输入框既能下拉选、也能自由手输 */}
      <datalist id={productListId}>
        {productOptions.map((option) => (
          <option key={option.product_key} value={option.name} />
        ))}
      </datalist>

      {rows.map((row, index) => (
        <div
          key={row.id}
          className="space-y-2 rounded-lg border border-border/70 bg-white/50 p-3"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">
              产品 {index + 1}
            </span>
            {rows.length > 1 && (
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-muted-foreground"
                aria-label={"删除产品 " + (index + 1)}
                onClick={() => removeRow(row.id)}
              >
                <X className="size-3.5" />
                删除
              </Button>
            )}
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Input
              name={"item-" + index + "-product"}
              list={productListId}
              aria-label={"产品 " + (index + 1)}
              placeholder="产品（可从产品库选，也可手输）"
              value={row.product}
              onChange={(e) =>
                updateRow(row.id, {
                  product: e.target.value,
                  product_key: resolveProductKey(e.target.value, productOptions),
                })
              }
            />
            <Input
              name={"item-" + index + "-spec"}
              aria-label={"规格说明 " + (index + 1)}
              placeholder="规格说明（如 2.5mm 热镀锌）"
              value={row.spec_text}
              onChange={(e) => updateRow(row.id, { spec_text: e.target.value })}
            />
            <div className="grid grid-cols-2 gap-2">
              <Input
                name={"item-" + index + "-quantity"}
                type="number"
                inputMode="decimal"
                aria-label={"数量 " + (index + 1)}
                placeholder="数量"
                value={row.quantity}
                onChange={(e) => updateRow(row.id, { quantity: e.target.value })}
              />
              <Input
                name={"item-" + index + "-unit"}
                aria-label={"单位 " + (index + 1)}
                placeholder="单位（㎡ / 卷 / 吨）"
                value={row.quantity_unit}
                onChange={(e) =>
                  updateRow(row.id, { quantity_unit: e.target.value })
                }
              />
            </div>
            <Input
              name={"item-" + index + "-application"}
              aria-label={"用途 " + (index + 1)}
              placeholder="用途（如 围栏 / 牧场）"
              value={row.application}
              onChange={(e) => updateRow(row.id, { application: e.target.value })}
            />
          </div>
        </div>
      ))}

      <Button size="sm" variant="outline" onClick={addRow}>
        <Plus className="mr-1 size-4" />
        再加一个产品
      </Button>

      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button onClick={handleSubmit} disabled={isPending}>
          {isPending ? "提交中…" : "添加询盘"}
        </Button>
        <Button variant="outline" onClick={onClose}>
          取消
        </Button>
      </div>
    </div>
  );
}
