"use client";

/**
 * 批量报价（B3/B4）—— 多客户 × 多询盘，一次生成多张报价单。
 *
 * 用户口径（2026-10-18）：
 *  · 一个询盘一张报价单，不跨客户/询盘合并；
 *  · 同一询盘可以有多张报价（新建，不覆盖）；默认展示最新一张；
 *  · 单批最多 200 行；
 *  · 已报价询盘也允许再次报价；
 *  · 某张报价生成后续单证后，同询盘其他报价自动 closed。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Loader2, Play } from "lucide-react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";

import apiClient from "@/lib/api/client";
import { useLatestFxRate } from "@/lib/fx/use-latest-fx";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { DataTable } from "@/components/shared/data-table";
import { EmptyState } from "@/components/shared/empty-state";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge } from "@/components/shared/status-badge";
import type {
  ExportProduct,
  ExportQuoteResponse,
} from "@contracts/export-quote";
import type {
  BatchQuoteResponse,
  QuoteOrderItemIn,
} from "@contracts/quote-order";
import type { ProductTaxRate, TaxArchive } from "@contracts/export-quote";
import { useExportProducts } from "../hooks/use-export-quote-import";
import { useProductFormulas } from "../hooks/use-export-quote-calc";
import { buildLineItem } from "../lib/line-to-item";

interface CustomerRow {
  id: number;
  company_name: string;
  country?: string | null;
}
interface InquiryRow {
  id: number;
  inquiry_no?: string | null;
  product_name_raw?: string | null;
  quantity?: number | null;
  quantity_unit?: string | null;
  status: string;
}

const STATUS_CN: Record<string, string> = {
  unquoted: "未报价",
  quoted: "已报价",
  closed: "已关闭",
};

function errText(e: unknown): string {
  const detail = (e as { response?: { data?: { detail?: unknown } } })?.response
    ?.data?.detail;
  if (typeof detail === "string") return detail;
  const nested = (detail as { detail?: string } | undefined)?.detail;
  return nested || (e instanceof Error ? e.message : "操作失败");
}

export function BatchQuoteView() {
  const [customerIds, setCustomerIds] = useState<number[]>([]);
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [piecesMap, setPiecesMap] = useState<Record<string, string>>({});
  const [productKey, setProductKey] = useState("");
  const [numeric, setNumeric] = useState<Record<string, string>>({});
  const [variants, setVariants] = useState<Record<string, string>>({});
  const [cost, setCost] = useState("");
  const [result, setResult] = useState<BatchQuoteResponse | null>(null);
  // P0-B1/Q10：批量建单是"一次生成 N 张正式报价单"，点一下即落库 ⇒ 先确认 + 防重
  const [confirmOpen, setConfirmOpen] = useState(false);
  const submittingRef = useRef(false);

  const customers = useQuery({
    queryKey: ["batch", "customers"],
    queryFn: async () => {
      const { data } = await apiClient.get<{ items: CustomerRow[] }>(
        "/customers",
        { params: { page_size: 100 } },
      );
      return data.items;
    },
  });

  const inquiries = useQuery({
    queryKey: ["batch", "inquiries", customerIds],
    enabled: customerIds.length > 0,
    queryFn: async () => {
      const pairs = await Promise.all(
        customerIds.map(async (cid) => {
          const { data } = await apiClient.get<{ items: InquiryRow[] }>(
            `/customers/${cid}/inquiries`,
          );
          return data.items
            .filter((i) => i.status !== "closed")
            .map((i) => ({ ...i, customer_id: cid }));
        }),
      );
      return pairs.flat();
    },
  });

  const products = useExportProducts();
  const formulas = useProductFormulas(productKey || null, true);
  const latestFx = useLatestFxRate("USD", "CNY");
  // 企业税档（销项/杂税）+ 产品税率（进项/退税）
  const taxArchives = useQuery({
    queryKey: ["batch", "tax-archives"],
    queryFn: async () => {
      const { data } = await apiClient.get<{ items: TaxArchive[] }>(
        "/tax-archives",
      );
      return data.items;
    },
  });
  const productTaxes = useQuery({
    queryKey: ["batch", "product-tax-rates"],
    queryFn: async () => {
      const { data } = await apiClient.get<{ items: ProductTaxRate[] }>(
        "/product-tax-rates",
      );
      return data.items;
    },
  });

  useEffect(() => {
    if (!productKey && products.data?.products[0]?.key) {
      setProductKey(products.data.products[0].key);
    }
  }, [productKey, products.data]);

  // 换产品：重置规格到产品默认值
  useEffect(() => {
    const f = formulas.data;
    if (!f) return;
    setNumeric(
      Object.fromEntries(
        f.numeric_inputs.map((n) => [
          n.key,
          n.default == null
            ? ""
            : String(Number(n.default) * (n.ui_scale || 1)),
        ]),
      ),
    );
    setVariants(
      Object.fromEntries(
        f.space.variants
          .filter((v) => v.options.length > 0)
          .map((v) => [v.name, String(v.options[0]?.value ?? "")]),
      ),
    );
    setCost("");
  }, [formulas.data]);

  const selectedRows = useMemo(() => {
    const rows = inquiries.data ?? [];
    return rows.filter((r) => picked[`${r.customer_id}:${r.id}`]);
  }, [inquiries.data, picked]);

  const buildSpec = (): Record<string, unknown> => {
    const f = formulas.data;
    if (!f) throw new Error("产品规格尚未加载");
    const spec: Record<string, unknown> = {};
    for (const n of f.numeric_inputs) {
      const raw = numeric[n.key];
      if (raw === undefined || raw.trim() === "") continue;
      spec[n.key] = Number(raw) / (n.ui_scale || 1);
    }
    for (const v of f.space.variants) {
      const pickedValue = variants[v.name];
      if (pickedValue === undefined || pickedValue === "") continue;
      const option = v.options.find((o) => String(o.value) === pickedValue);
      if (option) spec[v.name] = option.value;
    }
    return spec;
  };

  const run = useMutation({
    mutationFn: async () => {
      const f = formulas.data;
      const product = products.data?.products.find((p) => p.key === productKey);
      if (!f || !product) throw new Error("请先选择产品并等待规格加载");
      if (selectedRows.length === 0) throw new Error("请先勾选询盘");
      if (selectedRows.length > 200) throw new Error("单批最多 200 行");
      if (cost.trim() === "") {
        throw new Error("请填写成本（成本必须手输，可用历史报价参考）");
      }

      const productTax = (productTaxes.data ?? []).find(
        (x) => x.product_key === productKey,
      );
      if (!productTax) {
        throw new Error(
          "该产品还没有配置进项税/出口退税率，请先到「税务档案 → 产品税率」配置",
        );
      }
      const enterpriseTax = (taxArchives.data ?? [])[0];
      const policy = {
        input_vat_rate: productTax.input_vat_rate ?? undefined,
        ...(productTax.rebate_rate != null
          ? { rebate_rate: productTax.rebate_rate }
          : {}),
        output_vat_rate: enterpriseTax?.tax_values.output_vat_rate ?? 0,
        misc_fee_rate: enterpriseTax?.tax_values.misc_fee_rate ?? 0.03,
        profit_mode: "margin_on_price",
        profit_value: 0.06,
      };

      const spec = buildSpec();
      const groups = [];
      for (const row of selectedRows) {
        const key = `${row.customer_id}:${row.id}`;
        const pieces = Math.max(1, Math.ceil(Number(piecesMap[key] || 1)));
        const costValue = cost.trim() === "" ? null : Number(cost);
        const variantOverrides: Record<
          string,
          Record<string, Record<string, number>>
        > = {};
        let costApplied = false;
        if (costValue !== null) {
          for (const v of f.space.variants) {
            const optValue = variants[v.name];
            const opt = v.options.find((o) => String(o.value) === optValue);
            if (!opt) continue;
            const attrs = opt.attributes ?? {};
            if (attrs[f.cost.field] === undefined) continue;
            variantOverrides[v.name] = {
              [String(opt.value)]: { [f.cost.field]: costValue },
            };
            costApplied = true;
            break;
          }
        }
        const constantsOverride =
          costValue !== null && !costApplied
            ? { [f.cost.field]: costValue }
            : undefined;

        const { data: calc } = await apiClient.post<ExportQuoteResponse>(
          "/export-quote/calculate",
          {
            product_key: productKey,
            fx_rate: Number(latestFx.data?.rate) || 1,
            fx_source: "manual",
            orders: [{ total: pieces, unit: "ROLLS" }],
            spec_rows: [spec],
            variant_overrides: variantOverrides,
            constants_override: constantsOverride,
            quote_date: new Date().toISOString().slice(0, 10),
            currency: "CNY",
            quote_currency: "USD",
            validity_days: 30,
            with_verification: false,
            policy,
          },
          { timeout: 60_000 },
        );
        const built = buildLineItem({
          product,
          formulas: f,
          spec,
          result: calc,
          view: "customer",
          pieces,
          costOverride: costValue,
          rollLengthM:
            typeof spec.len_m === "number" ? (spec.len_m as number) : null,
        });
        groups.push({
          customer_id: String(row.customer_id),
          inquiry_id: row.id,
          currency: "USD",
          items: [built.item as QuoteOrderItemIn],
        });
      }
      const { data } = await apiClient.post<BatchQuoteResponse>(
        "/quotes/batch",
        { groups },
        { timeout: 120_000 },
      );
      return data;
    },
    onSuccess: (data) => {
      setResult(data);
      setConfirmOpen(false);
      // 成功后清空勾选，避免"再点一次生成一批重复报价单"
      setPicked({});
      setCustomerIds([]);
      setPiecesMap({});
      toast.success(`已生成 ${data.created.length} 张报价单`);
    },
    onError: (e) => toast.error(errText(e)),
  });

  /** 确认后触发批量建单；`submittingRef` 兜住同一 tick 连点两次。 */
  const confirmRun = () => {
    if (submittingRef.current || run.isPending) return;
    submittingRef.current = true;
    run.mutate(undefined, {
      onSettled: () => {
        submittingRef.current = false;
      },
    });
  };

  const toggleCustomer = (id: number) => {
    setCustomerIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };
  const toggleInquiry = (cid: number, iid: number) => {
    const key = `${cid}:${iid}`;
    setPicked((prev) => ({ ...prev, [key]: !prev[key] }));
    setPiecesMap((prev) => ({ ...prev, [key]: prev[key] ?? "1" }));
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 rounded-xl border border-border/70 bg-white/60 px-4 py-2.5 text-xs text-muted-foreground">
        <span>
          已选客户：
          <b className="font-medium text-foreground">{customerIds.length}</b>
        </span>
        <span>
          已选询盘：
          <b className="font-medium text-foreground">{selectedRows.length}</b>
        </span>
        <span>
          预计生成：
          <b className="font-medium text-foreground">
            {selectedRows.length}
          </b>{" "}
          张报价单
        </span>
      </div>

      <SectionCard
        title="1. 选客户与询盘"
        description="勾选客户后加载其名下询盘；已关闭询盘不出现。单批最多 200 行。"
      >
        {customers.isLoading ? (
          <div className="grid gap-4 md:grid-cols-2">
            <Skeleton className="h-64 w-full rounded-lg" />
            <Skeleton className="h-64 w-full rounded-lg" />
          </div>
        ) : (customers.data ?? []).length === 0 ? (
          <EmptyState
            title="还没有客户"
            description="先到「客户管理」创建客户与询盘，再回来批量报价。"
            className="border-0 py-8"
          />
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            <div className="max-h-64 space-y-1 overflow-auto rounded-lg border p-2">
              {(customers.data ?? []).map((c) => (
                <label
                  key={c.id}
                  className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-muted"
                >
                  <input
                    type="checkbox"
                    checked={customerIds.includes(c.id)}
                    onChange={() => toggleCustomer(c.id)}
                  />
                  <span>{c.company_name}</span>
                  <span className="text-xs text-muted-foreground">
                    {c.country ?? ""}
                  </span>
                </label>
              ))}
            </div>
            <div className="max-h-64 space-y-1 overflow-auto rounded-lg border p-2">
              {customerIds.length === 0 ? (
                <p className="p-2 text-xs text-muted-foreground">
                  先在左侧选择客户
                </p>
              ) : inquiries.isLoading ? (
                <div className="space-y-2 p-1">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <Skeleton key={i} className="h-8 w-full rounded-md" />
                  ))}
                </div>
              ) : (
                (inquiries.data ?? []).map((i) => {
                  const key = `${i.customer_id}:${i.id}`;
                  return (
                    <label
                      key={key}
                      className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-muted"
                    >
                      <input
                        type="checkbox"
                        checked={!!picked[key]}
                        onChange={() => toggleInquiry(i.customer_id, i.id)}
                      />
                      <span className="font-mono text-xs">
                        {i.inquiry_no ?? `#${i.id}`}
                      </span>
                      <span className="truncate">
                        {i.product_name_raw ?? "—"}
                      </span>
                      <StatusBadge
                        tone={i.status === "quoted" ? "success" : "default"}
                      >
                        {STATUS_CN[i.status] ?? i.status}
                      </StatusBadge>
                    </label>
                  );
                })
              )}
            </div>
          </div>
        )}
      </SectionCard>

      <SectionCard
        title="2. 统一产品与规格"
        description="本批每个询盘生成一张报价单，使用同一产品/规格；件数可按询盘单独改。"
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <label className="space-y-1">
            <span className="text-sm font-medium">产品</span>
            <select
              value={productKey}
              onChange={(e) => setProductKey(e.target.value)}
              className="h-9 w-full rounded-lg border border-input bg-background px-2 text-sm"
            >
              {(products.data?.products ?? []).map((p: ExportProduct) => (
                <option key={p.key} value={p.key}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          {(formulas.data?.numeric_inputs ?? []).map((n) => (
            <label key={n.key} className="space-y-1">
              <span className="text-sm font-medium">
                {n.label}
                {n.ui_unit ? `（${n.ui_unit}）` : ""}
              </span>
              <Input
                value={numeric[n.key] ?? ""}
                onChange={(e) =>
                  setNumeric((prev) => ({ ...prev, [n.key]: e.target.value }))
                }
              />
            </label>
          ))}
          {(formulas.data?.space.variants ?? [])
            .filter((v) => v.options.length > 0)
            .map((v) => (
              <label key={v.name} className="space-y-1">
                <span className="text-sm font-medium">{v.label}</span>
                <select
                  value={variants[v.name] ?? ""}
                  onChange={(e) =>
                    setVariants((prev) => ({
                      ...prev,
                      [v.name]: e.target.value,
                    }))
                  }
                  className="h-9 w-full rounded-lg border border-input bg-background px-2 text-sm"
                >
                  {v.options.map((o, idx) => (
                    <option key={idx} value={String(o.value)}>
                      {o.label ?? String(o.value)}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          <label className="space-y-1">
            <span className="text-sm font-medium">
              成本（{formulas.data?.cost.unit ?? ""}）
            </span>
            <Input
              value={cost}
              onChange={(e) => setCost(e.target.value)}
              placeholder="必填；参考历史报价后手填"
            />
          </label>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          汇率自动取最新 USD/CNY（{latestFx.data?.rate ?? "…"}）。
        </p>
      </SectionCard>

      <SectionCard title={`3. 已选 ${selectedRows.length} 个询盘`}>
        {selectedRows.length === 0 ? (
          <EmptyState
            title="尚未勾选询盘"
            description="在步骤 1 勾选客户与询盘后，这里会显示本批要生成的报价单。"
            className="border-0 py-8"
          />
        ) : (
          <DataTable
            caption="已选询盘"
            tableClassName="text-sm"
            rows={selectedRows}
            getRowKey={(r) => `${r.customer_id}:${r.id}`}
            columns={[
              {
                key: "inquiry_no",
                header: "询盘",
                className: "font-mono text-xs",
                render: (r) => r.inquiry_no ?? `#${r.id}`,
              },
              {
                key: "product_name_raw",
                header: "产品",
                render: (r) => r.product_name_raw ?? "—",
              },
              {
                key: "pieces",
                header: "件数（卷）",
                render: (r) => {
                  const key = `${r.customer_id}:${r.id}`;
                  return (
                    <Input
                      className="h-8 w-24"
                      value={piecesMap[key] ?? "1"}
                      onChange={(e) =>
                        setPiecesMap((prev) => ({
                          ...prev,
                          [key]: e.target.value,
                        }))
                      }
                    />
                  );
                },
              },
            ]}
          />
        )}
        <div className="mt-3 flex items-center gap-2">
          <Button
            onClick={() => setConfirmOpen(true)}
            disabled={run.isPending || selectedRows.length === 0}
          >
            {run.isPending ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
            ) : (
              <Play className="mr-1 h-4 w-4" />
            )}
            生成报价单
          </Button>
          {result && (
            <span className="text-xs text-muted-foreground">
              成功 {result.created.length} / 失败 {result.failed.length}
            </span>
          )}
        </div>
        {result && result.failed.length > 0 && (
          <div className="mt-3 space-y-1 rounded-lg border border-warning/40 bg-warning-muted p-2 text-xs text-warning-muted-foreground">
            {result.failed.map((f, i) => (
              <div key={i}>
                询盘 #{f.inquiry_id}：{f.code} — {f.detail}
              </div>
            ))}
          </div>
        )}
        {result && result.created.length > 0 && (
          <div className="mt-3 rounded-lg border px-2">
            <DataTable
              caption="批量生成结果"
              tableClassName="text-xs"
              rows={result.created}
              getRowKey={(c) => `created-${c.quote_id}`}
              columns={[
                {
                  key: "inquiry_id",
                  header: "询盘",
                  render: (c) => `#${c.inquiry_id}`,
                },
                {
                  key: "quote_no",
                  header: "报价单号",
                  className: "font-mono",
                  render: (c) => c.quote_no,
                },
              ]}
            />
          </div>
        )}
      </SectionCard>

      {/* P0-B1/Q10：批量建单二次确认 —— 一次落库 N 张正式报价单 */}
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={(next) => {
          if (!next && !run.isPending) setConfirmOpen(false);
        }}
        title={`为 ${selectedRows.length} 个询盘批量生成报价单？`}
        description={`将按当前产品 / 规格 / 成本，为选中的 ${selectedRows.length} 个询盘各生成 1 张报价单（共 ${selectedRows.length} 张，单批最多 200 行）。生成后立即落库为正式报价单（草稿态），无法整批撤回。`}
        confirmLabel="确认生成"
        pending={run.isPending}
        onConfirm={confirmRun}
      />
    </div>
  );
}
