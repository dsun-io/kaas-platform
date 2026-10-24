"use client";

/**
 * 产品工位的数据层（P0 · 2026-10-22 傻瓜化重做）。
 *
 * 口径：
 * - 系统内置产品来自代码注册表（/products）；团队自定义产品来自 /tenant-products。
 *   两者按 product_key 合并成"一个产品一张卡"（同 key 时租户行覆盖系统行）。
 * - product_key 是内部稳定编号，**界面不展示**；新建产品时由这里生成。
 * - 产品规格完整快照存在 tenant_products.spec；系统产品没有租户行时按需读
 *   /export-quote/products/{key}/spec（用于展示与"复制为自定义"的底稿）。
 * - 保存时只改业务字段，其它底层字段原样保留（避免把高级设置里的内容覆盖掉）。
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import apiClient from "@/lib/api/client";
import { nameEnListFromInfo } from "@/lib/products/product-names";

export interface NumericInputItem {
  key: string;
  label: string;
  label_en?: string;
  unit?: string;
  ui_unit?: string;
  ui_scale?: number;
  default?: number | string | null;
  min_value?: number | null;
  max_value?: number | null;
  decimals?: number | null;
  note?: string;
}

export interface VariantOption {
  name: string;
  label?: string;
  [k: string]: unknown;
}

export interface VariantGroupItem {
  name: string;
  label?: string;
  label_en?: string;
  options: VariantOption[];
}

export interface PackagingRange {
  field: string;
  min: number | null;
  max: number | null;
  amount: number;
}

export interface PackagingItem {
  id?: string;
  name?: string;
  method?: string;
  is_default?: boolean;
  created_at?: string;
  mode?: string;
  amount?: number;
  ranges?: PackagingRange[];
  [k: string]: unknown;
}

export type ProductSpec = {
  key?: string;
  name?: string;
  name_en?: string;
  axes?: unknown[];
  numeric_inputs?: NumericInputItem[];
  variants?: VariantGroupItem[];
  derived?: unknown[];
  columns?: unknown[];
  invariants?: unknown[];
  space_deduction?: unknown;
  params?: unknown[];
  notes?: unknown[];
  constants?: Record<string, unknown>;
  packaging?: PackagingItem[];
  hs_codes?: string[];
  profit_mode?: string;
  profit_value?: number;
  misc_fee_rate?: number;
  cost_basis?: string;
  [k: string]: unknown;
};

export interface TenantProduct {
  id: number;
  product_key: string;
  product_name: string;
  product_name_en?: string | null;
  category_code?: string | null;
  cost_field?: string;
  cost_basis?: string;
  cost_unit?: string | null;
  profit_mode?: string;
  profit_value?: number;
  misc_fee_rate?: number;
  spec?: ProductSpec;
  is_system?: boolean;
  is_active?: boolean;
  created_at?: string | null;
}

export interface RegistryProductRow {
  product_key: string;
  name: string;
  name_en?: string;
  /** 地区别名（主名之外的其它英文名）；后端 `/products` 已按主名算好 */
  name_en_aliases?: string[];
  /** 全部英文名（主名在前）—— 详情页编辑框的回填来源 */
  name_en_list?: string[];
  category_code?: string;
  media_count: number;
  profile: Record<string, unknown>;
}

export interface WorkProduct {
  key: string;
  name: string;
  /** 主英文名（报价/单证用它） */
  nameEn: string;
  /** 全部英文名（主名在前，包含主名）—— 详情页多英文名编辑器用 */
  nameEnList: string[];
  /** 地区别名 = nameEnList 去掉主名 */
  nameEnAliases: string[];
  categoryCode: string;
  tenant: TenantProduct | null;
  isSystem: boolean;
}

export const tenantProductKeys = {
  list: ["tenant-products"] as const,
  spec: (key: string) => ["product-spec", key] as const,
  status: ["tenant-product-status", "quote"] as const,
};

export function useTenantProducts() {
  return useQuery({
    queryKey: tenantProductKeys.list,
    queryFn: async () => {
      const { data } = await apiClient.get<TenantProduct[]>("/tenant-products");
      return data ?? [];
    },
  });
}

/** 系统产品完整规格（只在没有租户行时用）。 */
export function useRegistryProductSpec(productKey: string | null) {
  return useQuery({
    queryKey: tenantProductKeys.spec(productKey ?? ""),
    enabled: Boolean(productKey),
    queryFn: async () => {
      const { data } = await apiClient.get<{ spec: ProductSpec }>(
        "/export-quote/products/" +
          encodeURIComponent(productKey ?? "") +
          "/spec",
      );
      return data.spec;
    },
  });
}

export function useSaveTenantProduct() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      id?: number;
      body: Record<string, unknown>;
    }) => {
      const { id, body } = input;
      if (id) {
        const { data } = await apiClient.put("/tenant-products/" + id, body);
        return data as TenantProduct;
      }
      const { data } = await apiClient.post("/tenant-products", body);
      return data as TenantProduct;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: tenantProductKeys.list });
    },
  });
}

export function useDeleteTenantProduct() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      await apiClient.delete("/tenant-products/" + id);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: tenantProductKeys.list });
    },
  });
}

export interface ProductStatusRow {
  product_key: string;
  is_enabled: boolean;
}

export function useProductQuoteStatus() {
  return useQuery({
    queryKey: tenantProductKeys.status,
    queryFn: async () => {
      const { data } = await apiClient.get<{ items: ProductStatusRow[] }>(
        "/tenant-product-status",
        { params: { workstation: "quote" } },
      );
      return data.items ?? [];
    },
  });
}

export function useSetProductQuoteEnabled() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { productKey: string; enabled: boolean }) => {
      await apiClient.post(
        "/tenant-product-status",
        { product_key: input.productKey, is_enabled: input.enabled },
        { params: { workstation: "quote" } },
      );
    },
    // 2026-10-24：「在报价中显示」开关反馈延迟 ~2s（POST 往返 + 重拉 status + 重拉
    // export-products 才回显）。这里先乐观写入 status 缓存，失败再回滚——用户点完
    // checkbox 立刻变，网络失败才回弹并提示。
    onMutate: async (input) => {
      await qc.cancelQueries({ queryKey: tenantProductKeys.status });
      const previous = qc.getQueryData<ProductStatusRow[]>(
        tenantProductKeys.status,
      );
      qc.setQueryData<ProductStatusRow[]>(tenantProductKeys.status, (old) => {
        const rows = Array.isArray(old) ? old : [];
        const exists = rows.some((r) => r.product_key === input.productKey);
        return exists
          ? rows.map((r) =>
              r.product_key === input.productKey
                ? { ...r, is_enabled: input.enabled }
                : r,
            )
          : [
              ...rows,
              { product_key: input.productKey, is_enabled: input.enabled },
            ];
      });
      return { previous };
    },
    onError: (_error, _input, context) => {
      if (context?.previous !== undefined) {
        qc.setQueryData(tenantProductKeys.status, context.previous);
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["export-products"] });
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: tenantProductKeys.status });
    },
  });
}

/**
 * 系统产品 + 租户自定义产品合并成产品卡数据（同 key 时租户行优先）。
 *
 * 英文名（2026-10-24）三级回落，顺序固定：
 *   1. `product_profiles.info` 的 name_en_list（团队资料，**系统产品也能改**，主名在前）
 *   2. `/products` 已经算好的 name_en_list（后端把注册表名一起给了）
 *   3. 租户行 `product_name_en` → 注册表 `name_en`（旧口径，保持兼容）
 */
export function mergeWorkProducts(
  registry: RegistryProductRow[] | undefined,
  tenants: TenantProduct[] | undefined,
): WorkProduct[] {
  const rows: WorkProduct[] = [];
  const seen = new Set<string>();
  const tenantByKey = new Map((tenants ?? []).map((t) => [t.product_key, t]));

  const resolveNames = (
    profile: Record<string, unknown> | undefined,
    serverList: string[] | undefined,
    fallbacks: (string | null | undefined)[],
  ): string[] => {
    const fromProfile = nameEnListFromInfo(profile);
    if (fromProfile.length > 0) return fromProfile;
    const fromServer = (serverList ?? []).map((s) => s.trim()).filter(Boolean);
    if (fromServer.length > 0) return fromServer;
    return fallbacks.map((s) => (s ?? "").trim()).filter(Boolean);
  };

  for (const r of registry ?? []) {
    const t = tenantByKey.get(r.product_key) ?? null;
    const names = resolveNames(r.profile, r.name_en_list, [
      t?.product_name_en,
      r.name_en,
    ]);
    rows.push({
      key: r.product_key,
      name: t?.product_name || r.name || r.product_key,
      nameEn: names[0] ?? "",
      nameEnList: names,
      nameEnAliases: names.slice(1),
      categoryCode: t?.category_code || r.category_code || "",
      tenant: t,
      isSystem: !t,
    });
    seen.add(r.product_key);
  }
  for (const t of tenants ?? []) {
    if (seen.has(t.product_key)) continue;
    const names = resolveNames(undefined, undefined, [t.product_name_en]);
    rows.push({
      key: t.product_key,
      name: t.product_name || t.product_key,
      nameEn: names[0] ?? "",
      nameEnList: names,
      nameEnAliases: names.slice(1),
      categoryCode: t.category_code || "",
      tenant: t,
      isSystem: false,
    });
    seen.add(t.product_key);
  }
  return rows;
}

/** 产品是否已配置计算规则（空白产品会缺 derived）。 */
export function hasCalculationRules(
  spec: ProductSpec | undefined | null,
): boolean {
  if (!spec) return false;
  return Array.isArray(spec.derived) && spec.derived.length > 0;
}

/** 从英文名/中文名生成内部编号（用户看不到；冲突时加序号）。 */
export function makeProductKey(
  nameEn: string,
  name: string,
  existing: Iterable<string>,
): string {
  const used = new Set(existing);
  const base =
    String(nameEn || name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40) || "product_" + Date.now();
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(base + "_" + n)) n += 1;
  return base + "_" + n;
}

/** 计算规则字段：空白产品"从其他产品带入"时复制这些，不动名称/图片/档位。 */
const RULE_FIELDS: (keyof ProductSpec)[] = [
  "derived",
  "columns",
  "invariants",
  "space_deduction",
  "constants",
  "params",
  "numeric_inputs",
  "piece_metrics",
  "order_metrics",
  "pricing_key",
  "cost_field",
  "cost_unit",
  "piece_inputs",
];

export function copyCalculationRules(
  target: ProductSpec,
  source: ProductSpec,
): ProductSpec {
  const next: ProductSpec = { ...target };
  for (const field of RULE_FIELDS) {
    if (source[field] !== undefined) next[field] = source[field];
  }
  return next;
}

/** 金额百分比输入 → 0~1 的小数（空/非法返回 null）。 */
export function pctToRatio(text: string): number | null {
  if (String(text).trim() === "") return null;
  const n = Number(text);
  if (!Number.isFinite(n)) return null;
  return n / 100;
}

export function ratioToPct(value: number | null | undefined): string {
  if (value === null || value === undefined) return "";
  return String(Number((Number(value) * 100).toFixed(4)));
}
