"use client";

/**
 * 调研产品 · 手工录入（C36 #22）。
 *
 * 入口：调研页「产品」tab 的「手工录入」按钮。
 * 契约（`backend/worker/src/chain.py:2137-2294`）：
 * - POST `/research/products`，所有字段可选；`source_ref`（线索 id）选中后由**后端**回填产品/店铺字段，
 *   前端只传 source_ref + 用户显式填的值（不重复搬运）；
 * - 同一线索重复挑选 → 409 `ALREADY_PICKED`；线索不存在 → 404；未开通调研工位 → 403 —— 均如实透出。
 */
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { normalizeApiError } from "@/lib/api/api-error";
import { apiClient } from "@/lib/api/client";
import {
  buildManualResearchPayload,
  EMPTY_MANUAL_RESEARCH_FORM,
  explainResearchConflict,
  validateManualResearchForm,
  type ManualResearchForm,
} from "@/lib/research/manual-entry";

export interface ManualLeadOption {
  id: number;
  company_name: string;
  product_name: string | null;
  product_name_cn: string | null;
  country: string | null;
  city: string | null;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  categories: string[];
  leads: ManualLeadOption[];
  leadsLoading?: boolean;
  onCreated: () => void;
}

export function ManualResearchDialog({
  open,
  onOpenChange,
  categories,
  leads,
  leadsLoading = false,
  onCreated,
}: Props) {
  const [form, setForm] = useState<ManualResearchForm>(EMPTY_MANUAL_RESEARCH_FORM);
  const [errors, setErrors] = useState<string[]>([]);
  const [backendError, setBackendError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const set = <K extends keyof ManualResearchForm>(
    key: K,
    value: ManualResearchForm[K],
  ) => setForm((prev) => ({ ...prev, [key]: value }));

  const reset = () => {
    setForm(EMPTY_MANUAL_RESEARCH_FORM);
    setErrors([]);
    setBackendError(null);
  };

  const close = () => {
    if (submitting) return;
    onOpenChange(false);
  };

  const submit = async () => {
    setBackendError(null);
    const localErrors = validateManualResearchForm(form);
    setErrors(localErrors);
    if (localErrors.length > 0) return;

    setSubmitting(true);
    try {
      await apiClient.post("/research/products", buildManualResearchPayload(form));
      toast.success("已加入调研集");
      reset();
      onOpenChange(false);
      onCreated();
    } catch (error) {
      const conflict = explainResearchConflict(error);
      const info = normalizeApiError(error);
      if (info.status === 403) {
        setBackendError(`${info.message}（未开通调研工位）`);
      } else if (info.status === 404) {
        setBackendError("线索不存在或已删除，请刷新线索列表后重选");
      } else {
        setBackendError(conflict ?? `${info.message}（提交失败）`);
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>手工录入调研产品</DialogTitle>
          <DialogDescription>
            可以直接手工填产品/店铺信息；也可以选择一条地图源线索，产品与店铺字段留空时由后端自动回填。
            产品名或线索至少填一个。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <label className="block space-y-1">
            <span className="text-sm font-medium">从线索挑选（可选）</span>
            <select
              aria-label="从线索挑选"
              className="h-9 w-full rounded-md border bg-background px-2 text-sm"
              value={form.sourceRef}
              onChange={(e) => set("sourceRef", e.target.value)}
            >
              <option value="">
                {leadsLoading ? "正在读取线索…" : "不使用线索（纯手工录入）"}
              </option>
              {leads.map((lead) => (
                <option key={lead.id} value={String(lead.id)}>
                  {lead.company_name}
                  {lead.product_name ? ` · ${lead.product_name}` : ""}
                  {lead.country ? `（${lead.country}）` : ""}
                </option>
              ))}
            </select>
            <span className="block text-[11px] text-muted-foreground">
              选线索后，同一线索不能重复挑选（后端 409）；下面留空的产品/店铺字段会自动带入。
            </span>
          </label>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block space-y-1">
              <span className="text-sm font-medium">产品名（原语言）</span>
              <Input
                value={form.productName}
                placeholder="不选线索时必填，如 chain link fence"
                onChange={(e) => set("productName", e.target.value)}
              />
            </label>
            <label className="block space-y-1">
              <span className="text-sm font-medium">产品中文名</span>
              <Input
                value={form.productNameCn}
                placeholder="如 勾花网"
                onChange={(e) => set("productNameCn", e.target.value)}
              />
            </label>
            <label className="block space-y-1">
              <span className="text-sm font-medium">类目</span>
              <select
                aria-label="类目"
                className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                value={form.productCategory}
                onChange={(e) => set("productCategory", e.target.value)}
              >
                <option value="">请选择类目</option>
                {categories.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
            <label className="block space-y-1">
              <span className="text-sm font-medium">店铺名</span>
              <Input
                value={form.shopName}
                placeholder="如 ABC Fence Supplies"
                onChange={(e) => set("shopName", e.target.value)}
              />
            </label>
            <label className="block space-y-1">
              <span className="text-sm font-medium">国家</span>
              <Input
                value={form.country}
                placeholder="如 DE"
                onChange={(e) => set("country", e.target.value)}
              />
            </label>
            <label className="block space-y-1">
              <span className="text-sm font-medium">州 / 省 / 地区</span>
              <Input
                value={form.region}
                placeholder="如 Bayern"
                onChange={(e) => set("region", e.target.value)}
              />
            </label>
            <label className="block space-y-1">
              <span className="text-sm font-medium">城市</span>
              <Input
                value={form.city}
                placeholder="如 München"
                onChange={(e) => set("city", e.target.value)}
              />
            </label>
            <label className="block space-y-1">
              <span className="text-sm font-medium">本地价格</span>
              <Input
                inputMode="decimal"
                value={form.priceLocal}
                placeholder="如 12.5"
                onChange={(e) => set("priceLocal", e.target.value)}
              />
            </label>
            <label className="block space-y-1">
              <span className="text-sm font-medium">币种</span>
              <Input
                value={form.priceCurrency}
                placeholder="如 EUR"
                onChange={(e) => set("priceCurrency", e.target.value)}
              />
            </label>
            <label className="block space-y-1">
              <span className="text-sm font-medium">能否供货</span>
              <select
                aria-label="能否供货"
                className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                value={form.canSupply}
                onChange={(e) => set("canSupply", e.target.value)}
              >
                <option value="">未填</option>
                <option value="true">是</option>
                <option value="false">否</option>
              </select>
            </label>
          </div>

          <label className="block space-y-1">
            <span className="text-sm font-medium">市场备注</span>
            <textarea
              className="min-h-[72px] w-full rounded-md border border-input bg-background p-2 text-sm"
              value={form.marketNote}
              placeholder="如：当地常用镀锌层要求、包装偏好…"
              onChange={(e) => set("marketNote", e.target.value)}
            />
          </label>

          {errors.length > 0 && (
            <ul className="space-y-1 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              {errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          )}
          {backendError && (
            <p className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              {backendError}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={close} disabled={submitting}>
            取消
          </Button>
          <Button onClick={submit} disabled={submitting}>
            {submitting ? "提交中…" : "加入调研集"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
