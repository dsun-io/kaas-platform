"use client";

/**
 * 税务管理（TAX-04）—— 团队级税务档案。
 *
 * 用户口径（TAX-00）：
 *  · 档案只负责在报价页“填表”，不参与后端算价；
 *  · 字段：进项票税点 / 销项税率 / 出口退税率 / 杂税（印花税已含在杂税里）；
 *  · 不含利润率/让利；
 *  · 版本/生效日期只展示排序，不做报价日期门禁；
 *  · 团队管理员写，成员只读。
 */
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Save, Power } from "lucide-react";
import { toast } from "sonner";

import apiClient from "@/lib/api/client";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge } from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { usePageView } from "@/lib/events/use-page-view";
import type {
  TaxArchive,
  TaxArchiveCreate,
  TaxArchiveList,
} from "@contracts/export-quote";

const KEY = ["tax-archives"];

type FormState = {
  id: number | null;
  name: string;
  code: string;
  effective_from: string;
  input_vat: string;
  output_vat: string;
  rebate: string;
  misc: string;
};

const EMPTY: FormState = {
  id: null, name: "", code: "", effective_from: "",
  input_vat: "10", output_vat: "0", rebate: "", misc: "3",
};

function pctToRate(value: string): number | undefined {
  const text = value.trim();
  if (!text) return undefined;
  const n = Number(text);
  if (!Number.isFinite(n)) throw new Error("税率必须是数字");
  return n / 100;
}

function rateToPct(value: number | undefined): string {
  return value == null ? "" : String(Number((value * 100).toFixed(4)));
}

function toForm(a: TaxArchive): FormState {
  return {
    id: a.id,
    name: a.name,
    code: a.code ?? "",
    effective_from: a.effective_from ?? "",
    input_vat: rateToPct(a.tax_values.input_vat_rate),
    output_vat: rateToPct(a.tax_values.output_vat_rate),
    rebate: rateToPct(a.tax_values.rebate_rate),
    misc: rateToPct(a.tax_values.misc_fee_rate),
  };
}

export default function TaxArchivesPage() {
  usePageView({ resource_id: "/settings/tax-archives" });
  const qc = useQueryClient();
  const [form, setForm] = useState<FormState>(EMPTY);
  const [showForm, setShowForm] = useState(false);

  const list = useQuery({
    queryKey: KEY,
    queryFn: async () => {
      const { data } = await apiClient.get<TaxArchiveList>("/tax-archives");
      return data;
    },
  });

  useEffect(() => {
    if (list.error) toast.error("读取税务档案失败，请确认数据库迁移已执行");
  }, [list.error]);

  const save = useMutation({
    mutationFn: async (state: FormState) => {
      const tax_values = {
        input_vat_rate: pctToRate(state.input_vat),
        output_vat_rate: pctToRate(state.output_vat),
        rebate_rate: pctToRate(state.rebate),
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
    onError: (e: unknown) => {
      const detail =
        (e as { response?: { data?: { detail?: unknown } } })?.response?.data
          ?.detail;
      const text =
        typeof detail === "string"
          ? detail
          : (detail as { detail?: string } | undefined)?.detail;
      toast.error(text || "保存失败");
    },
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

  const submit = () => {
    if (!form.name.trim()) {
      toast.error("请填写档案名称");
      return;
    }
    try {
      save.mutate(form);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "税率不合法");
    }
  };

  const items = list.data?.items ?? [];
  const set = (patch: Partial<FormState>) =>
    setForm((prev) => ({ ...prev, ...patch }));

  return (
    <div className="space-y-5">
      <PageHeader
        title="税务管理"
        description="团队级税务档案。报价时选择档案会自动填入税率；档案本身不参与算价。"
        actions={
          <Button
            onClick={() => {
              setForm(EMPTY);
              setShowForm(true);
            }}
          >
            <Plus className="mr-1 h-4 w-4" /> 新建档案
          </Button>
        }
      />

      <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
        本页<strong>仅团队管理员可保存</strong>，成员可查看并用于报价。档案只负责填表；
        报价单会保存当时实际使用的税率快照。
      </div>

      {showForm && (
        <SectionCard
          title={form.id == null ? "新建税务档案" : `编辑：${form.name}`}
        >
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <label className="space-y-1">
              <span className="text-sm font-medium">档案名称 *</span>
              <Input
                value={form.name}
                onChange={(e) => set({ name: e.target.value })}
                placeholder="如：默认税率档案（2026-09）"
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
            {(
              [
                ["input_vat", "进项票税点（%）"],
                ["output_vat", "销项税率（%）"],
                ["rebate", "出口退税率（%）"],
                ["misc", "杂税（%，含印花税）"],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="space-y-1">
                <span className="text-sm font-medium">{label}</span>
                <Input
                  inputMode="decimal"
                  value={form[key]}
                  onChange={(e) => set({ [key]: e.target.value })}
                  placeholder="留空 = 不设置"
                />
              </label>
            ))}
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

      <SectionCard title="档案列表">
        {list.isLoading ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            加载中…
          </p>
        ) : items.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            暂无档案。可新建一份，报价页会自动选中最新一份。
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="p-2">名称</th>
                  <th className="p-2">编码</th>
                  <th className="p-2">生效日期</th>
                  <th className="p-2">进项</th>
                  <th className="p-2">销项</th>
                  <th className="p-2">出口退税</th>
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
                    <td className="p-2">{rateToPct(a.tax_values.input_vat_rate) || "—"}%</td>
                    <td className="p-2">{rateToPct(a.tax_values.output_vat_rate) || "—"}%</td>
                    <td className="p-2">{rateToPct(a.tax_values.rebate_rate) || "—"}</td>
                    <td className="p-2">{rateToPct(a.tax_values.misc_fee_rate) || "—"}%</td>
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
    </div>
  );
}
