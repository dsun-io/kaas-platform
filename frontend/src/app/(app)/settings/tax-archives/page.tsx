"use client";

/**
 * 税务管理（TAX-04）—— 企业税档 + 产品税率。
 *
 * 用户口径（2026-10-18 修正）：
 *  · 销项增值税、杂税是**企业级**，按团队维护档案；
 *  · 进项增值税、出口退税率跟着**产品/HS**走，在本页「产品税率」逐条维护；
 *  · 同一产品只能有一条产品税率（已选过的产品不能再选）；
 *  · 税费变化后在一个页面统一管理，不用去每个产品页改。
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Power, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";

import apiClient from "@/lib/api/client";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge } from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { usePageView } from "@/lib/events/use-page-view";
import type {
  ExportProductList,
  ProductTaxRate,
  ProductTaxRateList,
  TaxArchive,
  TaxArchiveCreate,
  TaxArchiveList,
} from "@contracts/export-quote";

const KEY = ["tax-archives"];
const PT_KEY = ["product-tax-rates"];

type FormState = {
  id: number | null;
  name: string;
  code: string;
  effective_from: string;
  output_vat: string;
  misc: string;
};

const EMPTY: FormState = {
  id: null,
  name: "",
  code: "",
  effective_from: "",
  output_vat: "0",
  misc: "3",
};

type PTForm = {
  id: number | null;
  product_key: string;
  input_vat: string;
  rebate: string;
};

const EMPTY_PT: PTForm = { id: null, product_key: "", input_vat: "", rebate: "" };

function pctToRate(value: string): number | undefined {
  const text = value.trim();
  if (!text) return undefined;
  const n = Number(text);
  if (!Number.isFinite(n)) throw new Error("税率必须是数字");
  return n / 100;
}

function rateToPct(value: number | null | undefined): string {
  return value == null ? "" : String(Number((value * 100).toFixed(4)));
}

function toForm(a: TaxArchive): FormState {
  return {
    id: a.id,
    name: a.name,
    code: a.code ?? "",
    effective_from: a.effective_from ?? "",
    output_vat: rateToPct(a.tax_values.output_vat_rate),
    misc: rateToPct(a.tax_values.misc_fee_rate),
  };
}

function errText(e: unknown): string {
  const detail = (e as { response?: { data?: { detail?: unknown } } })?.response
    ?.data?.detail;
  if (typeof detail === "string") return detail;
  return (
    (detail as { detail?: string } | undefined)?.detail ||
    (e instanceof Error ? e.message : "操作失败")
  );
}

export default function TaxArchivesPage() {
  usePageView({ resource_id: "/settings/tax-archives" });
  const qc = useQueryClient();
  const [form, setForm] = useState<FormState>(EMPTY);
  const [showForm, setShowForm] = useState(false);
  const [ptForm, setPtForm] = useState<PTForm>(EMPTY_PT);
  const [showPtForm, setShowPtForm] = useState(false);

  const list = useQuery({
    queryKey: KEY,
    queryFn: async () => {
      const { data } = await apiClient.get<TaxArchiveList>("/tax-archives");
      return data;
    },
  });

  const productTaxes = useQuery({
    queryKey: PT_KEY,
    queryFn: async () => {
      const { data } = await apiClient.get<ProductTaxRateList>(
        "/product-tax-rates",
      );
      return data;
    },
  });

  const products = useQuery({
    queryKey: ["export-products"],
    queryFn: async () => {
      const { data } = await apiClient.get<ExportProductList>(
        "/export-quote/products",
      );
      return data;
    },
  });

  const productName = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of products.data?.products ?? []) map.set(p.key, p.name);
    return map;
  }, [products.data]);

  const save = useMutation({
    mutationFn: async (state: FormState) => {
      const tax_values = {
        output_vat_rate: pctToRate(state.output_vat),
        misc_fee_rate: pctToRate(state.misc),
      };
      const body: TaxArchiveCreate = {
        name: state.name.trim(),
        code: state.code.trim() || null,
        effective_from: state.effective_from || null,
        tax_values,
      };
      if (state.id == null) {
        const { data } = await apiClient.post<TaxArchive>("/tax-archives", body);
        return data;
      }
      const { data } = await apiClient.patch<TaxArchive>(
        `/tax-archives/${state.id}`,
        body,
      );
      return data;
    },
    onSuccess: () => {
      toast.success("税务档案已保存");
      setForm(EMPTY);
      setShowForm(false);
      void qc.invalidateQueries({ queryKey: KEY });
    },
    onError: (e) => toast.error(errText(e)),
  });

  const toggle = useMutation({
    mutationFn: async (a: TaxArchive) => {
      const { data } = await apiClient.patch<TaxArchive>(
        `/tax-archives/${a.id}`,
        { status: a.status === "active" ? "inactive" : "active" },
      );
      return data;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: KEY }),
    onError: () => toast.error("操作失败：仅团队管理员可修改税务档案"),
  });

  const saveProductTax = useMutation({
    mutationFn: async (state: PTForm) => {
      const body = {
        input_vat_rate: pctToRate(state.input_vat),
        rebate_rate: pctToRate(state.rebate),
      };
      if (state.id == null) {
        const { data } = await apiClient.post<ProductTaxRate>(
          "/product-tax-rates",
          { product_key: state.product_key, ...body },
        );
        return data;
      }
      const { data } = await apiClient.patch<ProductTaxRate>(
        `/product-tax-rates/${state.id}`,
        body,
      );
      return data;
    },
    onSuccess: () => {
      toast.success("产品税率已保存");
      setPtForm(EMPTY_PT);
      setShowPtForm(false);
      void qc.invalidateQueries({ queryKey: PT_KEY });
    },
    onError: (e) => toast.error(errText(e)),
  });

  const deleteProductTax = useMutation({
    mutationFn: async (row: ProductTaxRate) => {
      await apiClient.delete(`/product-tax-rates/${row.id}`);
    },
    onSuccess: () => {
      toast.success("产品税率已停用");
      void qc.invalidateQueries({ queryKey: PT_KEY });
    },
    onError: (e) => toast.error(errText(e)),
  });

  const submit = () => {
    if (!form.name.trim()) {
      toast.error("请填写档案名称");
      return;
    }
    try {
      save.mutate(form);
    } catch (e) {
      toast.error(errText(e));
    }
  };

  const submitProductTax = () => {
    if (ptForm.id == null && !ptForm.product_key) {
      toast.error("请选择产品");
      return;
    }
    if (!ptForm.input_vat.trim() && !ptForm.rebate.trim()) {
      toast.error("进项税、退税率至少填一个");
      return;
    }
    try {
      saveProductTax.mutate(ptForm);
    } catch (e) {
      toast.error(errText(e));
    }
  };

  const items = list.data?.items ?? [];
  const ptItems = productTaxes.data?.items ?? [];
  const configured = new Set(ptItems.map((x) => x.product_key));
  const availableProducts = (products.data?.products ?? []).filter(
    (p) => !configured.has(p.key),
  );
  const set = (patch: Partial<FormState>) =>
    setForm((prev) => ({ ...prev, ...patch }));

  return (
    <div className="space-y-5">
      <PageHeader
        title="税务管理"
        description="企业税档管销项税和杂税；进项税、出口退税率按产品在下方单独维护。"
        actions={
          <Button
            onClick={() => {
              setForm(EMPTY);
              setShowForm(true);
            }}
          >
            <Plus className="mr-1 h-4 w-4" /> 新建企业税档
          </Button>
        }
      />

      <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
        本页<strong>仅团队管理员可保存</strong>，成员可查看。销项税/杂税按企业税档走；
        进项税/出口退税率按产品走，报价时自动带出对应产品税率。
      </div>

      {showForm && (
        <SectionCard
          title={form.id == null ? "新建企业税档" : `编辑：${form.name}`}
        >
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <label className="space-y-1">
              <span className="text-sm font-medium">档案名称 *</span>
              <Input
                value={form.name}
                onChange={(e) => set({ name: e.target.value })}
                placeholder="如：默认企业税档（2026-09）"
              />
            </label>
            <label className="space-y-1">
              <span className="text-sm font-medium">编码</span>
              <Input
                value={form.code}
                onChange={(e) => set({ code: e.target.value })}
                placeholder="留空自动生成"
              />
            </label>
            <label className="space-y-1">
              <span className="text-sm font-medium">生效日期</span>
              <Input
                type="date"
                value={form.effective_from}
                onChange={(e) => set({ effective_from: e.target.value })}
              />
            </label>
            <label className="space-y-1">
              <span className="text-sm font-medium">销项税率（%）</span>
              <Input
                inputMode="decimal"
                value={form.output_vat}
                onChange={(e) => set({ output_vat: e.target.value })}
                placeholder="留空 = 不设置"
              />
            </label>
            <label className="space-y-1">
              <span className="text-sm font-medium">杂税（%，含印花税）</span>
              <Input
                inputMode="decimal"
                value={form.misc}
                onChange={(e) => set({ misc: e.target.value })}
                placeholder="留空 = 不设置"
              />
            </label>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setShowForm(false)}>
              取消
            </Button>
            <Button onClick={submit} disabled={save.isPending}>
              <Save className="mr-1 h-4 w-4" />
              {save.isPending ? "保存中…" : "保存"}
            </Button>
          </div>
        </SectionCard>
      )}

      <SectionCard title="企业税档（销项税 / 杂税）">
        {list.isLoading ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            加载中…
          </p>
        ) : items.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            暂无企业税档。可新建一份，报价页会自动选中最新一份。
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="p-2">名称</th>
                  <th className="p-2">编码</th>
                  <th className="p-2">生效日期</th>
                  <th className="p-2">销项</th>
                  <th className="p-2">杂税</th>
                  <th className="p-2">状态</th>
                  <th className="p-2">操作</th>
                </tr>
              </thead>
              <tbody>
                {items.map((a) => (
                  <tr key={a.id} className="border-b last:border-0">
                    <td className="p-2 font-medium">{a.name}</td>
                    <td className="p-2 font-mono text-xs">{a.code ?? "—"}</td>
                    <td className="p-2 text-xs">{a.effective_from ?? "—"}</td>
                    <td className="p-2">
                      {rateToPct(a.tax_values.output_vat_rate) || "—"}%
                    </td>
                    <td className="p-2">
                      {rateToPct(a.tax_values.misc_fee_rate) || "—"}%
                    </td>
                    <td className="p-2">
                      <StatusBadge
                        tone={a.status === "active" ? "success" : "default"}
                      >
                        {a.status === "active" ? "启用" : "停用"}
                      </StatusBadge>
                    </td>
                    <td className="p-2">
                      <div className="flex gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setForm(toForm(a));
                            setShowForm(true);
                          }}
                        >
                          <Pencil className="mr-1 h-3 w-3" /> 编辑
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={toggle.isPending}
                          onClick={() => toggle.mutate(a)}
                        >
                          <Power className="mr-1 h-3 w-3" />
                          {a.status === "active" ? "停用" : "启用"}
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      <SectionCard
        title="产品税率（进项税 / 出口退税率）"
        description="每个产品一条；已配置的产品不能再选。报价时按产品自动带出。"
      >
        <div className="mb-3 flex justify-end">
          <Button
            size="sm"
            onClick={() => {
              setPtForm(EMPTY_PT);
              setShowPtForm(true);
            }}
          >
            <Plus className="mr-1 h-4 w-4" /> 新增产品税率
          </Button>
        </div>

        {showPtForm && (
          <div className="mb-4 grid gap-3 rounded-lg border p-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="space-y-1">
              <span className="text-sm font-medium">产品 *</span>
              <select
                value={ptForm.product_key}
                disabled={ptForm.id != null}
                onChange={(e) =>
                  setPtForm((prev) => ({
                    ...prev,
                    product_key: e.target.value,
                  }))
                }
                className="h-9 w-full rounded-lg border border-input bg-background px-2 text-sm"
              >
                <option value="">请选择产品</option>
                {(ptForm.id != null
                  ? products.data?.products ?? []
                  : availableProducts
                ).map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.name}（{p.key}）
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-sm font-medium">进项增值税率（%）</span>
              <Input
                inputMode="decimal"
                value={ptForm.input_vat}
                onChange={(e) =>
                  setPtForm((prev) => ({
                    ...prev,
                    input_vat: e.target.value,
                  }))
                }
                placeholder="如 10"
              />
            </label>
            <label className="space-y-1">
              <span className="text-sm font-medium">出口退税率（%）</span>
              <Input
                inputMode="decimal"
                value={ptForm.rebate}
                onChange={(e) =>
                  setPtForm((prev) => ({ ...prev, rebate: e.target.value }))
                }
                placeholder="如 13"
              />
            </label>
            <div className="flex items-end gap-2">
              <Button
                onClick={submitProductTax}
                disabled={saveProductTax.isPending}
              >
                <Save className="mr-1 h-4 w-4" /> 保存
              </Button>
              <Button variant="outline" onClick={() => setShowPtForm(false)}>
                取消
              </Button>
            </div>
          </div>
        )}

        {productTaxes.isLoading ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            加载中…
          </p>
        ) : ptItems.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            暂无产品税率。新增后报价页按产品自动带出。
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="p-2">产品</th>
                  <th className="p-2">进项增值税率</th>
                  <th className="p-2">出口退税率</th>
                  <th className="p-2">操作</th>
                </tr>
              </thead>
              <tbody>
                {ptItems.map((row) => (
                  <tr key={row.id} className="border-b last:border-0">
                    <td className="p-2">
                      {productName.get(row.product_key) ?? row.product_key}
                      <span className="ml-1 font-mono text-xs text-muted-foreground">
                        {row.product_key}
                      </span>
                    </td>
                    <td className="p-2">
                      {rateToPct(row.input_vat_rate) || "—"}%
                    </td>
                    <td className="p-2">{rateToPct(row.rebate_rate) || "—"}%</td>
                    <td className="p-2">
                      <div className="flex gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setPtForm({
                              id: row.id,
                              product_key: row.product_key,
                              input_vat: rateToPct(row.input_vat_rate),
                              rebate: rateToPct(row.rebate_rate),
                            });
                            setShowPtForm(true);
                          }}
                        >
                          <Pencil className="mr-1 h-3 w-3" /> 编辑
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={deleteProductTax.isPending}
                          onClick={() => deleteProductTax.mutate(row)}
                        >
                          <Trash2 className="mr-1 h-3 w-3" /> 停用
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </div>
  );
}
