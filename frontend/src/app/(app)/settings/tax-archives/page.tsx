"use client";

import { DataTable } from "@/components/shared/data-table";
import { EmptyState } from "@/components/shared/empty-state";

/**
 * 税务档案（TAX-04）—— 企业税档 + 产品税率。
 *
 * 用户口径（2026-10-18 修正）：
 *  · 销项增值税、杂税是**企业级**，按团队维护档案；
 *  · 进项增值税、出口退税率跟着**产品/HS**走，在本页「产品税率」逐条维护；
 *  · 同一产品只能有一条产品税率（已选过的产品不能再选）；
 *  · 税费变化后在一个页面统一管理，不用去每个产品页改。
 */
import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Power, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";

import apiClient from "@/lib/api/client";
import { normalizeApiError } from "@/lib/api/api-error";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge } from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { usePageView } from "@/lib/events/use-page-view";
import { useTeam } from "@/lib/team/team-context";
import type {
  ExportProductList,
  ProductTaxRate,
  ProductTaxRateList,
  TaxArchive,
  TaxArchiveCreate,
  TaxArchiveList,
} from "@contracts/export-quote";

import { FxHistoryCard } from "./components/fx-history-card";
import { FxRateCard } from "./components/fx-rate-card";
import { TaxArchiveDeactivateButton } from "./components/tax-archive-deactivate-button";

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

const EMPTY_PT: PTForm = {
  id: null,
  product_key: "",
  input_vat: "",
  rebate: "",
};

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
  // 写入权限口径（2026-10-20 前后端对齐审计 P2-6）：
  // 后端 `tax_archives.py:121-131` 的写接口要「有团队 + 团队管理员（或平台管理员）」，
  // 前端用 `/teams/me` 的 `is_admin`（useTeam().isTeamAdmin，与后端 is_team_admin 同判据）。
  // 非管理员**不做整页 403**：税务档案是报价要用的只读资料，保留展示、只隐藏写入入口。
  const { isTeamAdmin } = useTeam();
  const canWrite = isTeamAdmin;
  const [form, setForm] = useState<FormState>(EMPTY);
  const [showForm, setShowForm] = useState(false);
  const [ptForm, setPtForm] = useState<PTForm>(EMPTY_PT);
  const [showPtForm, setShowPtForm] = useState(false);
  // P0-B1：产品税率「停用」= DELETE 软删（影响报价自动带出的进项税/退税率）⇒ 二次确认
  const [deleteTarget, setDeleteTarget] = useState<ProductTaxRate | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const deletingRef = useRef(false);

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
      const { data } =
        await apiClient.get<ProductTaxRateList>("/product-tax-rates");
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
        const { data } = await apiClient.post<TaxArchive>(
          "/tax-archives",
          body,
        );
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
      setDeleteTarget(null);
      setDeleteError(null);
      void qc.invalidateQueries({ queryKey: PT_KEY });
    },
    // 失败原因留在确认弹窗里（403/404 原样透出），弹窗不关
    onError: (e) => setDeleteError(normalizeApiError(e).message || errText(e)),
  });

  /** 确认后停用产品税率；`deletingRef` 兜住同一 tick 连点两次。 */
  const confirmDeleteProductTax = () => {
    if (!deleteTarget || deletingRef.current) return;
    deletingRef.current = true;
    setDeleteError(null);
    deleteProductTax.mutate(deleteTarget, {
      onSettled: () => {
        deletingRef.current = false;
      },
    });
  };

  const submit = () => {
    if (!canWrite) {
      toast.error("仅团队管理员可修改税务档案");
      return;
    }
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
    if (!canWrite) {
      toast.error("仅团队管理员可修改税务档案");
      return;
    }
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
        title="税务档案"
        description="企业税档管销项税和杂税；进项税、出口退税率按产品在下方单独维护。报价时整单参数直接引用这里的档案。"
        actions={
          canWrite ? (
            <Button
              onClick={() => {
                setForm(EMPTY);
                setShowForm(true);
              }}
            >
              <Plus className="mr-1 h-4 w-4" /> 新建企业税档
            </Button>
          ) : undefined
        }
      />

      <div className="rounded-lg border border-warning/40 bg-warning-muted px-3 py-2 text-xs text-warning-muted-foreground">
        {canWrite ? (
          <>
            本页<strong>仅团队管理员可保存</strong>
            ，成员可查看。销项税/杂税按企业税档走；
            进项税/出口退税率按产品走，报价时自动带出对应产品税率。
          </>
        ) : (
          <>
            当前账号<strong>只能查看</strong>税务档案（保存需团队管理员）。
            报价时系统会自动带出这里的税率，如需调整请联系团队管理员。
          </>
        )}
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
        <DataTable
          columns={[
            {
              key: "name",
              header: "名称",
              className: "font-medium",
              render: (a) => a.name,
            },
            {
              key: "code",
              header: "编码",
              className: "font-mono text-xs",
              render: (a) => a.code ?? "—",
            },
            {
              key: "effective_from",
              header: "生效日期",
              className: "text-xs",
              render: (a) => a.effective_from ?? "—",
            },
            {
              key: "output_vat",
              header: "销项",
              render: (a) =>
                `${rateToPct(a.tax_values.output_vat_rate) || "—"}%`,
            },
            {
              key: "misc",
              header: "杂税",
              render: (a) => `${rateToPct(a.tax_values.misc_fee_rate) || "—"}%`,
            },
            {
              key: "status",
              header: "状态",
              render: (a) => (
                <StatusBadge
                  tone={a.status === "active" ? "success" : "default"}
                >
                  {a.status === "active" ? "启用" : "停用"}
                </StatusBadge>
              ),
            },
            {
              key: "actions",
              header: "操作",
              render: (a) =>
                canWrite ? (
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
                    {a.status === "active" ? (
                      // C36 #1：停用走 DELETE 软删（二次确认 + 403/404 原样透出）；
                      // 重新启用仍走 PATCH（后端 DELETE 只做 active→inactive）
                      <TaxArchiveDeactivateButton archive={a} />
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={toggle.isPending}
                        onClick={() => toggle.mutate(a)}
                      >
                        <Power className="mr-1 h-3 w-3" /> 启用
                      </Button>
                    )}
                  </div>
                ) : (
                  <span className="text-xs text-muted-foreground">只读</span>
                ),
            },
          ]}
          rows={items}
          getRowKey={(a) => a.id}
          loading={list.isLoading}
          emptySlot={
            <EmptyState
              title="暂无企业税档"
              description="可新建一份，报价页会自动选中最新一份。"
              className="py-6"
            />
          }
        />
      </SectionCard>

      <SectionCard
        title="产品税率（进项税 / 出口退税率）"
        description="每个产品一条；已配置的产品不能再选。报价时按产品自动带出。"
      >
        <div className="mb-3 flex justify-end">
          {canWrite && (
            <Button
              size="sm"
              onClick={() => {
                setPtForm(EMPTY_PT);
                setShowPtForm(true);
              }}
            >
              <Plus className="mr-1 h-4 w-4" /> 新增产品税率
            </Button>
          )}
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
                  ? (products.data?.products ?? [])
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

        <DataTable
          columns={[
            {
              key: "product",
              header: "产品",
              render: (row) => (
                <>
                  {productName.get(row.product_key) ?? row.product_key}
                  <span className="ml-1 font-mono text-xs text-muted-foreground">
                    {row.product_key}
                  </span>
                </>
              ),
            },
            {
              key: "input_vat",
              header: "进项增值税率",
              render: (row) => `${rateToPct(row.input_vat_rate) || "—"}%`,
            },
            {
              key: "rebate",
              header: "出口退税率",
              render: (row) => `${rateToPct(row.rebate_rate) || "—"}%`,
            },
            {
              key: "actions",
              header: "操作",
              render: (row) =>
                canWrite ? (
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
                      onClick={() => {
                        setDeleteError(null);
                        setDeleteTarget(row);
                      }}
                    >
                      <Trash2 className="mr-1 h-3 w-3" /> 停用
                    </Button>
                  </div>
                ) : (
                  <span className="text-xs text-muted-foreground">只读</span>
                ),
            },
          ]}
          rows={ptItems}
          getRowKey={(row) => row.id}
          loading={productTaxes.isLoading}
          emptySlot={
            <EmptyState
              title="暂无产品税率"
              description="新增后报价页按产品自动带出进项税与退税率。"
              className="py-4"
            />
          }
        />
      </SectionCard>

      {/* C36 #14/#5：手工汇率兜底 + 汇率历史（同一屏：写与查） */}
      <FxRateCard />
      <FxHistoryCard />

      {/* P0-B1：产品税率停用二次确认（软删，但报价会自动改用其它税率） */}
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(next) => {
          if (!next && !deleteProductTax.isPending) {
            setDeleteTarget(null);
            setDeleteError(null);
          }
        }}
        title={`停用产品「${deleteTarget ? (productName.get(deleteTarget.product_key) ?? deleteTarget.product_key) : ""}」的税率？`}
        description="停用后该产品不再有进项税/退税率，报价时会回落到其它可用税率或需要重新配置；记录本身保留（软删，可审计）。"
        confirmLabel="确认停用"
        pending={deleteProductTax.isPending}
        error={deleteError}
        onConfirm={confirmDeleteProductTax}
      />
    </div>
  );
}
