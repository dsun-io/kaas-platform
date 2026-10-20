"use client";

import { LoadingBlock } from "@/components/shared/loading-block";

/**
 * 产品工位 · tab「定义」（P14 行为等价搬入）
 *
 * 本组件的内容与搬家前 `frontend/src/app/(app)/settings/tenant-products/page.tsx`
 * 逐项一致：产品列表（key / 名称 / 利润模式 / 利润率 / 税费系数 / 状态 / 操作）+
 * 表单编辑（key/名称/利润配置/成本口径/规格 JSONB）+ 新增/编辑/删除。
 *
 * **JSON 文本框保留为「高级 JSON」**（P14 硬约束① + P16 编辑器叠加）：
 *   · `specJson` 状态仍是**唯一真源**（可视化编辑器与 JSON 两侧同源）、
 *     `JSON.parse(specJson || "{}")` 的写入路径、
 *     `<textarea value={...} rows={...}>` 的 UI（现居于编辑器「高级 JSON」tab）全部保留；
 *   · **不按 `Axis` 设计任何字段**（三产品 `axes` 全为空列表）；
 *   · 新建时的初始 JSON 保留 `axes: []`（搬家前的真实行为，见 S6.1 提交说明）。
 *
 * **可见性**：本 tab 不引入任何 `RouteGuard` / `adminOnly` 分支（P14 硬约束②：
 * 工位可见性属 P15 契约层，前端不发明权限门）。搬家前这一页所在工位是
 * `adminOnly:true`（契约层），但现在它在产品工位（`adminOnly:false`）里 ——
 * 这层可见性差异由 P15 契约统一收口，前端**不做任何代偿**。
 */
import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { ProductSpecEditor } from "../components/product-spec-editor";

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
  /** 完整 ProductSpec 快照（P16 编辑器的数据源 —— 后端 S6.1-a 起出参带出） */
  spec?: Record<string, unknown>;
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

export function ProductsDefinitionsTab() {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<Partial<TenantProduct> | null>(null);
  const [specJson, setSpecJson] = useState("");

  /** specJson 是唯一真源；这里只做"读出来 → 改一块 → 写回"的辅助。 */
  const specObj = useMemo<Record<string, unknown> | null>(() => {
    try {
      return JSON.parse(specJson || "{}") as Record<string, unknown>;
    } catch {
      return null;
    }
  }, [specJson]);

  const patchSpec = (patch: Record<string, unknown>) => {
    if (!specObj) return;
    setSpecJson(JSON.stringify({ ...specObj, ...patch }, null, 2));
  };

  const hsCodesText = Array.isArray(specObj?.hs_codes)
    ? (specObj?.hs_codes as unknown[]).join(", ")
    : "";
  const packagingRows = Array.isArray(specObj?.packaging)
    ? (specObj?.packaging as Record<string, unknown>[])
    : [];
  /** 包装区间可选的规格字段（数值参数 / 规格轴 / 变体） */
  const specFieldOptions = useMemo(() => {
    if (!specObj) return [];
    const out: { key: string; label: string }[] = [];
    const nums = Array.isArray(specObj.numeric_inputs)
      ? (specObj.numeric_inputs as Record<string, unknown>[])
      : [];
    for (const n of nums) {
      if (typeof n.key === "string")
        out.push({ key: n.key, label: String(n.label ?? n.key) });
    }
    for (const groupKey of ["axes", "variants"]) {
      const groups = Array.isArray(specObj[groupKey])
        ? (specObj[groupKey] as Record<string, unknown>[])
        : [];
      for (const g of groups) {
        if (typeof g.name === "string")
          out.push({ key: g.name, label: String(g.label ?? g.name) });
      }
    }
    return out;
  }, [specObj]);

  // ── 包装配置（需求 20）：产品级多包装，一个默认；区间按规格字段自动取值 ──
  const writePackaging = (rows: Record<string, unknown>[]) =>
    patchSpec({ packaging: rows });

  const addPackaging = () =>
    writePackaging([
      ...packagingRows,
      {
        id: `pkg-${Date.now()}`,
        name: `包装 ${packagingRows.length + 1}`,
        method: "",
        is_default: packagingRows.length === 0,
        created_at: new Date().toISOString(),
        mode: "per_piece",
        amount: 0,
        ranges: [],
      },
    ]);

  const updatePackaging = (index: number, patch: Record<string, unknown>) =>
    writePackaging(
      packagingRows.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    );

  const setDefaultPackaging = (index: number) =>
    writePackaging(
      packagingRows.map((row, i) => ({ ...row, is_default: i === index })),
    );

  const removePackaging = (index: number) => {
    const next = packagingRows.filter((_, i) => i !== index);
    // 删掉默认包装后，把第一项补成默认（保证「默认包装」始终存在）
    if (next.length > 0 && !next.some((r) => r.is_default)) {
      next[0] = { ...next[0], is_default: true };
    }
    writePackaging(next);
  };

  const addRange = (pkgIndex: number) => {
    const row = packagingRows[pkgIndex];
    if (!row) return;
    const ranges = Array.isArray(row.ranges) ? row.ranges : [];
    updatePackaging(pkgIndex, {
      ranges: [
        ...ranges,
        {
          field: specFieldOptions[0]?.key ?? "",
          min: null,
          max: null,
          amount: 0,
        },
      ],
    });
  };

  const updateRange = (
    pkgIndex: number,
    rangeIndex: number,
    patch: Record<string, unknown>,
  ) => {
    const row = packagingRows[pkgIndex];
    if (!row) return;
    const ranges = Array.isArray(row.ranges)
      ? (row.ranges as Record<string, unknown>[])
      : [];
    updatePackaging(pkgIndex, {
      ranges: ranges.map((r, i) => (i === rangeIndex ? { ...r, ...patch } : r)),
    });
  };

  const removeRange = (pkgIndex: number, rangeIndex: number) => {
    const row = packagingRows[pkgIndex];
    if (!row) return;
    const ranges = Array.isArray(row.ranges)
      ? (row.ranges as Record<string, unknown>[])
      : [];
    updatePackaging(pkgIndex, {
      ranges: ranges.filter((_, i) => i !== rangeIndex),
    });
  };

  const { data: products, isLoading } = useQuery({
    queryKey: ["tenant-products"],
    queryFn: async () => {
      const { data } = await apiClient.get<TenantProduct[]>("/tenant-products");
      return data;
    },
  });

  // 系统/注册表产品（没有 tenant_products 行）：产品工位也要能看到并复制成自定义定义
  const { data: registryProducts } = useQuery({
    queryKey: ["export-products"],
    queryFn: async () => {
      const { data } = await apiClient.get<{
        products: {
          key: string;
          name: string;
          name_en: string;
          category_code: string;
        }[];
      }>("/export-quote/products");
      return data.products;
    },
  });

  /** 合并行：租户定义优先（同 key 覆盖系统定义），其余系统产品只读 + 可复制。 */
  const mergedRows = useMemo<TenantProduct[]>(() => {
    const rows: TenantProduct[] = [...(products ?? [])];
    const seen = new Set(rows.map((r) => r.product_key));
    for (const p of registryProducts ?? []) {
      if (seen.has(p.key)) continue;
      rows.push({
        id: -1,
        product_key: p.key,
        product_name: p.name || p.key,
        product_name_en: p.name_en,
        category_code: p.category_code,
        cost_field: "raw_price",
        cost_basis: "pretax",
        profit_mode: "margin_on_price",
        profit_value: 0.06,
        misc_fee_rate: 0.03,
        is_system: true,
        is_active: true,
      });
    }
    return rows;
  }, [products, registryProducts]);

  const saveMutation = useMutation({
    mutationFn: async (product: Partial<TenantProduct>) => {
      // specJson 是唯一真源（P14 约束：JSON.parse(specJson || "{}") 的写入路径保留）
      const spec = JSON.parse(specJson || "{}");
      // spec.key 必须与 product_key 对齐 —— 它是引擎的产品标识（Loader 的 cache key）；
      // 不对齐的后果是"下拉里看不到本产品"（规格空间接口按 key 查不到）。
      if (product.product_key) spec.key = product.product_key;
      if (product.product_name && !spec.name) spec.name = product.product_name;
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

  // ── 系统级产品的租户停用（需求 16，用户选「允许租户停用」）──
  // 复用既有工程位产品启用表（tenant_workstation_products），不另造一张表。
  const { data: wsProducts } = useQuery({
    queryKey: ["tenant-product-status", "quote"],
    queryFn: async () => {
      const { data } = await apiClient.get<{
        items: { product_key: string; is_enabled: boolean }[];
      }>("/tenant-product-status", { params: { workstation: "quote" } });
      return data.items;
    },
  });
  const enabledMap = new Map(
    (wsProducts ?? []).map((r) => [r.product_key, r.is_enabled]),
  );
  const toggleEnabled = useMutation({
    mutationFn: async (args: { productKey: string; enabled: boolean }) => {
      await apiClient.post(
        "/tenant-product-status",
        { product_key: args.productKey, is_enabled: args.enabled },
        { params: { workstation: "quote" } },
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["tenant-product-status", "quote"],
      });
      queryClient.invalidateQueries({ queryKey: ["export-products"] });
    },
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">产品定义管理</h2>
          <p className="text-sm text-muted-foreground">
            租户级产品配置（利润/成本口径/规格）。系统级产品由平台管理员维护。
          </p>
        </div>
        <button
          onClick={() => {
            setEditing({ ...EMPTY_PRODUCT });
            // 保留 P14 的 axes: []（搬家前真实行为）+ S6.1 三段表单的空初始值
            setSpecJson(
              JSON.stringify(
                {
                  key: "",
                  name: "",
                  axes: [],
                  numeric_inputs: [],
                  variants: [],
                  derived: [],
                },
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
          <h3 className="font-semibold">
            {editing.id ? "编辑产品" : "新增产品"}
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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
            <label className="text-xs">规格定义</label>
            <ProductSpecEditor
              specJson={specJson}
              onChange={setSpecJson}
              productKey={editing.product_key || ""}
            />
          </div>

          {/* HS 编码（需求 18）：一行可多个，逗号分隔；报价/单证优先取第一个 */}
          <div className="rounded-lg border p-3 space-y-2">
            <h4 className="text-sm font-medium">HS 编码</h4>
            <input
              value={hsCodesText}
              onChange={(e) =>
                patchSpec({
                  hs_codes: e.target.value
                    .split(/[,，\s]+/)
                    .map((s) => s.trim())
                    .filter(Boolean),
                })
              }
              placeholder="如：7314410000（多个用逗号分隔）"
              className="w-full rounded border px-2 py-1 text-sm"
            />
            <p className="text-xs text-muted-foreground">
              报价行快照与单证 HS Code 列优先取第一个；产品基础信息里的
              `hs_code` 作为兜底。
            </p>
          </div>

          {/* 包装费用（需求 20）：按卷计，可多套；默认包装在报价时自动选中 */}
          <div className="rounded-lg border p-3 space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <h4 className="text-sm font-medium">包装费用（元 / 卷）</h4>
                <p className="text-xs text-muted-foreground">
                  未指定时用默认包装；未设默认时用最早创建的一套。区间按规格字段自动取值，
                  未命中任何区间时用「默认金额」。
                </p>
              </div>
              <button
                type="button"
                onClick={addPackaging}
                className="rounded border px-2 py-1 text-xs"
              >
                + 包装
              </button>
            </div>

            {packagingRows.length === 0 && (
              <p className="text-xs text-muted-foreground">
                该产品还没有包装配置（报价时包装费按 0 计）。
              </p>
            )}

            {packagingRows.map((pkg, pkgIndex) => {
              const ranges = Array.isArray(pkg.ranges)
                ? (pkg.ranges as Record<string, unknown>[])
                : [];
              return (
                <div
                  key={String(pkg.id ?? pkgIndex)}
                  className="rounded border bg-muted/20 p-3 space-y-2"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      value={String(pkg.name ?? "")}
                      onChange={(e) =>
                        updatePackaging(pkgIndex, { name: e.target.value })
                      }
                      placeholder="包装名称"
                      className="w-44 rounded border px-2 py-1 text-sm"
                    />
                    <input
                      value={String(pkg.method ?? "")}
                      onChange={(e) =>
                        updatePackaging(pkgIndex, { method: e.target.value })
                      }
                      placeholder="包装方式（如：编织袋+钢带）"
                      className="w-56 rounded border px-2 py-1 text-sm"
                    />
                    <label className="flex items-center gap-1 text-xs">
                      <input
                        type="radio"
                        name={`default-pkg-${String(editing.product_key ?? "")}`}
                        checked={Boolean(pkg.is_default)}
                        onChange={() => setDefaultPackaging(pkgIndex)}
                      />
                      默认包装
                    </label>
                    <button
                      type="button"
                      onClick={() => removePackaging(pkgIndex)}
                      className="ml-auto text-xs text-destructive underline"
                    >
                      删除
                    </button>
                  </div>
                  <div className="flex items-end gap-2">
                    <label className="text-xs">
                      默认金额（元/卷）
                      <input
                        type="number"
                        step="any"
                        value={Number(pkg.amount ?? 0)}
                        onChange={(e) =>
                          updatePackaging(pkgIndex, {
                            amount: Number(e.target.value) || 0,
                          })
                        }
                        className="ml-2 w-28 rounded border px-2 py-1 text-sm"
                      />
                    </label>
                    <button
                      type="button"
                      onClick={() => addRange(pkgIndex)}
                      className="rounded border px-2 py-1 text-xs"
                    >
                      + 规格区间
                    </button>
                  </div>

                  {ranges.map((rng, rangeIndex) => (
                    <div
                      key={rangeIndex}
                      className="flex flex-wrap items-end gap-2 pl-3"
                    >
                      <label className="text-xs">
                        规格字段
                        <select
                          value={String(rng.field ?? "")}
                          onChange={(e) =>
                            updateRange(pkgIndex, rangeIndex, {
                              field: e.target.value,
                            })
                          }
                          className="ml-1 rounded border px-1 py-1 text-sm"
                        >
                          <option value="">（未选）</option>
                          {specFieldOptions.map((o) => (
                            <option key={o.key} value={o.key}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="text-xs">
                        最小值（含）
                        <input
                          type="number"
                          step="any"
                          value={rng.min == null ? "" : Number(rng.min)}
                          onChange={(e) =>
                            updateRange(pkgIndex, rangeIndex, {
                              min:
                                e.target.value === ""
                                  ? null
                                  : Number(e.target.value),
                            })
                          }
                          className="ml-1 w-24 rounded border px-1 py-1 text-sm"
                        />
                      </label>
                      <label className="text-xs">
                        最大值（不含）
                        <input
                          type="number"
                          step="any"
                          value={rng.max == null ? "" : Number(rng.max)}
                          onChange={(e) =>
                            updateRange(pkgIndex, rangeIndex, {
                              max:
                                e.target.value === ""
                                  ? null
                                  : Number(e.target.value),
                            })
                          }
                          className="ml-1 w-24 rounded border px-1 py-1 text-sm"
                        />
                      </label>
                      <label className="text-xs">
                        金额（元/卷）
                        <input
                          type="number"
                          step="any"
                          value={Number(rng.amount ?? 0)}
                          onChange={(e) =>
                            updateRange(pkgIndex, rangeIndex, {
                              amount: Number(e.target.value) || 0,
                            })
                          }
                          className="ml-1 w-24 rounded border px-1 py-1 text-sm"
                        />
                      </label>
                      <button
                        type="button"
                        onClick={() => removeRange(pkgIndex, rangeIndex)}
                        className="text-xs text-destructive underline"
                      >
                        移除
                      </button>
                    </div>
                  ))}
                </div>
              );
            })}
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
              <th scope="col" className="px-4 py-2 text-left">
                Key
              </th>
              <th scope="col" className="px-4 py-2 text-left">
                名称
              </th>
              <th scope="col" className="px-4 py-2 text-left">
                利润模式
              </th>
              <th scope="col" className="px-4 py-2 text-left">
                利润率
              </th>
              <th scope="col" className="px-4 py-2 text-left">
                税费系数
              </th>
              <th scope="col" className="px-4 py-2 text-left">
                HS 编码
              </th>
              <th scope="col" className="px-4 py-2 text-left">
                包装
              </th>
              <th scope="col" className="px-4 py-2 text-left">
                状态
              </th>
              <th scope="col" className="px-4 py-2 text-left">
                操作
              </th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={9} className="px-4 py-4">
                  <LoadingBlock rows={3} />
                </td>
              </tr>
            ) : (
              mergedRows.map((p) => (
                <tr key={`${p.id}:${p.product_key}`} className="border-b">
                  <td className="px-4 py-2 font-mono">{p.product_key}</td>
                  <td className="px-4 py-2">{p.product_name}</td>
                  <td className="px-4 py-2">{p.profit_mode}</td>
                  <td className="px-4 py-2">{p.profit_value}</td>
                  <td className="px-4 py-2">{p.misc_fee_rate}</td>
                  <td className="px-4 py-2 font-mono text-xs">
                    {Array.isArray(p.spec?.hs_codes)
                      ? (p.spec?.hs_codes as unknown[]).join(", ")
                      : "—"}
                  </td>
                  <td className="px-4 py-2 text-xs">
                    {Array.isArray(p.spec?.packaging) &&
                    (p.spec?.packaging as unknown[]).length > 0
                      ? `${(p.spec?.packaging as unknown[]).length} 套`
                      : "—"}
                  </td>
                  <td className="px-4 py-2">
                    {p.is_system
                      ? `系统级 · ${
                          enabledMap.get(p.product_key) === false
                            ? "已停用"
                            : "启用"
                        }`
                      : p.is_active
                        ? "启用"
                        : "停用"}
                  </td>
                  <td className="px-4 py-2">
                    {p.is_system ? (
                      <div className="flex gap-2">
                        <button
                          onClick={() =>
                            toggleEnabled.mutate({
                              productKey: p.product_key,
                              enabled: enabledMap.get(p.product_key) === false,
                            })
                          }
                          disabled={toggleEnabled.isPending}
                          className="text-xs text-primary underline"
                        >
                          {enabledMap.get(p.product_key) === false
                            ? "启用"
                            : "停用"}
                        </button>
                        {/* 系统产品全局共享；租户要改定义时复制一份租户级覆盖（同 key 时优先租户行） */}
                        <button
                          onClick={async () => {
                            // 系统定义的原始 spec 从后端取（列表不带完整 spec）
                            try {
                              const { data } = await apiClient.get<{
                                spec: Record<string, unknown>;
                              }>(
                                `/export-quote/products/${encodeURIComponent(p.product_key)}/spec`,
                              );
                              setEditing({
                                ...p,
                                id: undefined,
                                is_system: false,
                                is_active: true,
                                product_name:
                                  String(data.spec.name ?? p.product_name) ||
                                  p.product_name,
                              });
                              setSpecJson(JSON.stringify(data.spec, null, 2));
                            } catch {
                              // 读取失败就不打开编辑器（避免把空定义存成租户覆盖）
                            }
                          }}
                          className="text-xs text-primary underline"
                          title="复制为租户自定义定义（同 key 时租户行优先于系统定义）"
                        >
                          自定义
                        </button>
                      </div>
                    ) : (
                      <div className="flex gap-2">
                        <button
                          onClick={() => {
                            setEditing(p);
                            // P16：用**真实** spec 初始化（此前只塞 key/name，编辑=丢数据）
                            setSpecJson(
                              JSON.stringify(
                                p.spec ?? {
                                  key: p.product_key,
                                  name: p.product_name,
                                },
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
