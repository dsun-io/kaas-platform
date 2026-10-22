"use client";

/**
 * 调研产品「深化记录」编辑弹窗（U-P0B6/X4）。
 *
 * 为什么从平铺表单迁到 Dialog：旧实现把 158 行编辑表单原地铺在列表下方，
 * 打开后整页跳动、且编辑态与列表滚动位置互相牵制。现在：
 * · 编辑草稿在弹窗内独立持有（列表重取/筛选不影响已打开的表单内容）；
 * · 提交失败 → 弹窗内 role="alert"（保留输入，可直接重试）；
 * · pending 期间保存/取消禁用、Esc/遮罩不能关。
 *
 * 业务字段与接口不变：仍是 `PATCH /research/products/{id}` 的同一组字段。
 */
import { useState } from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AsyncButton } from "@/components/shared";

/** 本弹窗需要编辑的字段（只是 ResearchProduct 的子集，保持结构兼容）。 */
export interface ResearchEditValue {
  id: number;
  product_name: string | null;
  product_name_cn: string | null;
  product_category: string | null;
  price_local: number | null;
  price_currency: string | null;
  market_note: string | null;
  can_supply: boolean | null;
  supply_notes: string | null;
  spec_raw: string | null;
}

export function ResearchEditDialog({
  product,
  categories,
  pending,
  error,
  onSubmit,
  onClose,
}: {
  /** 打开时的那条产品（快照；列表后续刷新不影响表单） */
  product: ResearchEditValue;
  categories: string[];
  pending: boolean;
  error: string | null;
  onSubmit: (draft: ResearchEditValue) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<ResearchEditValue>(() => ({ ...product }));

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            深化记录 · {product.product_name ?? `#${product.id}`}
          </DialogTitle>
          <DialogDescription>
            供货能力由你判定 —— 绝不由系统推断。保存后立即生效。
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <div>
            <label className="text-xs text-muted-foreground">本地产品</label>
            <Input value={draft.product_name ?? ""} disabled />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">中文产品名</label>
            <Input
              value={draft.product_name_cn ?? ""}
              onChange={(e) =>
                setDraft({ ...draft, product_name_cn: e.target.value })
              }
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">类目</label>
            <select
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              value={draft.product_category ?? ""}
              onChange={(e) =>
                setDraft({ ...draft, product_category: e.target.value })
              }
            >
              <option value="">—</option>
              {categories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs text-muted-foreground">当地价格</label>
            <Input
              type="number"
              value={draft.price_local ?? ""}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  price_local:
                    e.target.value === "" ? null : Number(e.target.value),
                })
              }
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">币种</label>
            <Input
              value={draft.price_currency ?? ""}
              onChange={(e) =>
                setDraft({ ...draft, price_currency: e.target.value })
              }
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">可供货</label>
            <select
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              value={
                draft.can_supply === null
                  ? ""
                  : draft.can_supply
                    ? "true"
                    : "false"
              }
              onChange={(e) =>
                setDraft({
                  ...draft,
                  can_supply:
                    e.target.value === "" ? null : e.target.value === "true",
                })
              }
            >
              <option value="">未填</option>
              <option value="true">是</option>
              <option value="false">否</option>
            </select>
          </div>
          <div className="md:col-span-2">
            <label className="text-xs text-muted-foreground">供货备注</label>
            <Input
              value={draft.supply_notes ?? ""}
              onChange={(e) =>
                setDraft({ ...draft, supply_notes: e.target.value })
              }
            />
          </div>
          <div className="md:col-span-3">
            <label className="text-xs text-muted-foreground">市场备注</label>
            <textarea
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              rows={3}
              value={draft.market_note ?? ""}
              onChange={(e) =>
                setDraft({ ...draft, market_note: e.target.value })
              }
            />
          </div>
        </div>

        {draft.spec_raw && (
          <div>
            <p className="text-xs text-muted-foreground">规格（来自来源）</p>
            <p className="mt-1 rounded bg-secondary/50 p-2 text-xs">
              {draft.spec_raw}
            </p>
          </div>
        )}

        {error ? (
          <p
            role="alert"
            className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
          >
            保存失败：{error}
          </p>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            取消
          </Button>
          <AsyncButton
            pending={pending}
            pendingLabel="保存中…"
            onClick={() => onSubmit(draft)}
          >
            保存
          </AsyncButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
