"use client";

/**
 * 租户级产品定义管理界面。
 *
 * 支持：产品列表 + 表单编辑（key/名称/利润配置/规格 JSONB）。
 * 权限矩阵（**未完成**）：is_system=true 系统级产品所有租户可见，
 * is_system=false 租户级产品仅本租户可见。
 * 详见 docs/PRODUCT_CONFIG_TENANT_UNFINISHED.md
 */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";

interface TenantProduct {
  id: number;
  product_key: string;
  product_name: string;
  product_name_en?: string;
  category_code?: string;
  cost_field: string;
  cost_basis: string;
  cost_unit?: string;
  profit_mode: string;
  profit_value: number;
  misc_fee_rate: number;
  is_system: boolean;
  is_active: boolean;
  created_at?: string;
}

const EMPTY_PRODUCT: Partial<TenantProduct> = {
  product_key: "",
  product_name: "",
  cost_field: "raw_price",
  cost_basis: "pretax",
  profit_mode: "margin_on_price",
  profit_value: 0.06,
  misc_fee_rate: 0.03,
  is_active: true,
};

export default function TenantProductsPage() {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<Partial<TenantProduct> | null>(null);
  const [specJson, setSpecJson] = useState("");

  const { data: products, isLoading } = useQuery({
    queryKey: ["tenant-products"],
    queryFn: async () => {
      const { data } = await apiClient.get<TenantProduct[]>("/tenant-products");
      return data;
    },
  });

  const saveMutation = useMutation({
    mutationFn: async (product: Partial<TenantProduct>) => {
      const spec = JSON.parse(specJson || "{}");
      const payload = { ...product, spec };
      if (product.id) {
        const { data } = await apiClient.put(
          `/tenant-products/${product.id}`,
          payload,
        );
        return data;
      }
      const { data } = await apiClient.post("/tenant-products", payload);
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tenant-products"] });
      setEditing(null);
      setSpecJson("");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiClient.delete(`/tenant-products/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tenant-products"] });
    },
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">产品定义管理</h1>
          <p className="text-sm text-muted-foreground">
            租户级产品配置（利润/成本口径/规格）。系统级产品由平台管理员维护。
          </p>
        </div>
        <button
          onClick={() => {
            setEditing({ ...EMPTY_PRODUCT });
            setSpecJson(
              JSON.stringify(
                { key: "", name: "", axes: [], variants: [] },
                null,
                2,
              ),
            );
          }}
          className="rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground"
        >
          新增产品
        </button>
      </div>

      {editing && (
        <div className="rounded-lg border p-4 space-y-4">
          <h2 className="font-semibold">
            {editing.id ? "编辑产品" : "新增产品"}
          </h2>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-xs">产品 Key</label>
              <input
                value={editing.product_key || ""}
                onChange={(e) =>
                  setEditing({ ...editing, product_key: e.target.value })
                }
                className="w-full rounded border px-2 py-1 text-sm"
                disabled={!!editing.id}
              />
            </div>
            <div>
              <label className="text-xs">产品名称</label>
              <input
                value={editing.product_name || ""}
                onChange={(e) =>
                  setEditing({ ...editing, product_name: e.target.value })
                }
                className="w-full rounded border px-2 py-1 text-sm"
              />
            </div>
            <div>
              <label className="text-xs">利润模式</label>
              <select
                value={editing.profit_mode || "margin_on_price"}
                onChange={(e) =>
                  setEditing({ ...editing, profit_mode: e.target.value })
                }
                className="w-full rounded border px-2 py-1 text-sm"
              >
                <option value="margin_on_price">售价加成（利润率）</option>
                <option value="fixed">固定额</option>
                <option value="ratio">成本比率</option>
              </select>
            </div>
            <div>
              <label className="text-xs">利润率 / 利润值</label>
              <input
                type="number"
                step="0.001"
                value={editing.profit_value ?? 0.06}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    profit_value: parseFloat(e.target.value),
                  })
                }
                className="w-full rounded border px-2 py-1 text-sm"
              />
            </div>
            <div>
              <label className="text-xs">综合税费系数</label>
              <input
                type="number"
                step="0.001"
                value={editing.misc_fee_rate ?? 0.03}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    misc_fee_rate: parseFloat(e.target.value),
                  })
                }
                className="w-full rounded border px-2 py-1 text-sm"
              />
            </div>
            <div>
              <label className="text-xs">成本口径</label>
              <select
                value={editing.cost_basis || "pretax"}
                onChange={(e) =>
                  setEditing({ ...editing, cost_basis: e.target.value })
                }
                className="w-full rounded border px-2 py-1 text-sm"
              >
                <option value="pretax">不含税</option>
                <option value="incl_tax">含税</option>
              </select>
            </div>
          </div>
          <div>
            <label className="text-xs">规格定义 (JSONB)</label>
            <textarea
              value={specJson}
              onChange={(e) => setSpecJson(e.target.value)}
              rows={10}
              className="w-full rounded border px-2 py-1 font-mono text-xs"
            />
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => saveMutation.mutate(editing)}
              disabled={saveMutation.isPending}
              className="rounded bg-primary px-4 py-2 text-sm text-primary-foreground"
            >
              {saveMutation.isPending ? "保存中…" : "保存"}
            </button>
            <button
              onClick={() => {
                setEditing(null);
                setSpecJson("");
              }}
              className="rounded border px-4 py-2 text-sm"
            >
              取消
            </button>
          </div>
        </div>
      )}

      <div className="rounded-lg border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/50">
              <th className="px-4 py-2 text-left">Key</th>
              <th className="px-4 py-2 text-left">名称</th>
              <th className="px-4 py-2 text-left">利润模式</th>
              <th className="px-4 py-2 text-left">利润率</th>
              <th className="px-4 py-2 text-left">税费系数</th>
              <th className="px-4 py-2 text-left">状态</th>
              <th className="px-4 py-2 text-left">操作</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td
                  colSpan={7}
                  className="px-4 py-8 text-center text-muted-foreground"
                >
                  加载中…
                </td>
              </tr>
            ) : (
              (products ?? []).map((p) => (
                <tr key={p.id} className="border-b">
                  <td className="px-4 py-2 font-mono">{p.product_key}</td>
                  <td className="px-4 py-2">{p.product_name}</td>
                  <td className="px-4 py-2">{p.profit_mode}</td>
                  <td className="px-4 py-2">{p.profit_value}</td>
                  <td className="px-4 py-2">{p.misc_fee_rate}</td>
                  <td className="px-4 py-2">
                    {p.is_system ? "系统级" : p.is_active ? "启用" : "停用"}
                  </td>
                  <td className="px-4 py-2">
                    {!p.is_system && (
                      <div className="flex gap-2">
                        <button
                          onClick={() => {
                            setEditing(p);
                            setSpecJson(
                              JSON.stringify(
                                { key: p.product_key, name: p.product_name },
                                null,
                                2,
                              ),
                            );
                          }}
                          className="text-xs text-primary underline"
                        >
                          编辑
                        </button>
                        <button
                          onClick={() => deleteMutation.mutate(p.id)}
                          className="text-xs text-destructive underline"
                        >
                          删除
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
