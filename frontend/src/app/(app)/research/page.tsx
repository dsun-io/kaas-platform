"use client";

import { useMemo, useRef, useState } from "react";
import { usePageView } from "@/lib/events/use-page-view";
import { RouteGuard } from "@/components/route-guard";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  PageHeader,
  StatusBadge,
  SectionCard,
  EmptyState,
  StatCard,
  ConfirmDialog,
} from "@/components/shared";
import { toast } from "sonner";
import { normalizeApiError } from "@/lib/api/api-error";
import { PaginationBar } from "@/components/shared/pagination-bar";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import {
  CRAWL_STATUS_TONES,
  RUN_STATUS_TONES,
  toneForStatus,
} from "@/lib/status-tones";
import {
  Globe2,
  ImageOff,
  Layers,
  MapPin,
  PackageSearch,
  Pencil,
  Trash2,
  CheckCircle2,
  XCircle,
  History,
  Download,
  Plus,
} from "lucide-react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ManualResearchDialog } from "./components/manual-research-dialog";
import {
  ResearchEditDialog,
  type ResearchEditValue,
} from "./components/research-edit-dialog";

/* ── types ─────────────────────────────────────────────────────────────── */
interface ResearchProduct {
  id: number;
  source_ref: number | null;
  source: string | null;
  product_name: string | null;
  product_name_cn: string | null;
  product_image_url: string | null;
  spec_raw: string | null;
  spec_normalized: Record<string, unknown> | null;
  product_category: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  shop_name: string | null;
  shop_type: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  link_url: string | null;
  price_local: number | null;
  price_currency: string | null;
  market_note: string | null;
  can_supply: boolean | null;
  supply_notes: string | null;
  research_status: string;
  created_at: string;
}

interface ResearchStats {
  total: number;
  can_supply_yes: number;
  by_country: { country: string; total: number; can_supply: number }[];
  by_category: { product_category: string; total: number }[];
}

interface LeadOption {
  id: number;
  company_name: string;
  country: string | null;
  city: string | null;
  shop_type: string | null;
  product_name: string | null;
  product_name_cn: string | null;
  crawl_status: string | null;
  can_supply: boolean | null;
  website: string | null;
}

interface ResearchRun {
  id: number;
  config: Record<string, unknown> | null;
  status: string;
  leads_scanned: number | null;
  products_found: number | null;
  products_kept: number | null;
  created_at: string;
}

type TabKey = "products" | "pick" | "runs";

const TABS: { key: TabKey; label: string }[] = [
  { key: "products", label: "调研产品" },
  { key: "pick", label: "从地图源挑选" },
  { key: "runs", label: "运行历史" },
];

const CAN_SUPPLY_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "可供货：全部" },
  { value: "true", label: "可供货：是" },
  { value: "false", label: "可供货：否" },
  { value: "unknown", label: "可供货：未填" },
];

/** 调研产品分页大小（与后端默认 page_size 同口径；上限 200 由后端 Query 校验）。 */
const RESEARCH_PAGE_SIZE = 20;
/** 导出全部时的单页上限（后端 le=200），整批拉完再写 CSV，避免静默截断。 */
const EXPORT_PAGE_SIZE = 200;

function supplyBadge(v: boolean | null) {
  if (v === true) return <StatusBadge tone="success">可供货</StatusBadge>;
  if (v === false) return <StatusBadge tone="danger">不可供货</StatusBadge>;
  return <StatusBadge tone="default">未填</StatusBadge>;
}

/* 状态显示文案映射（仅改展示文本，不改枚举值与 tone） */
const CRAWL_STATUS_CN: Record<string, string> = {
  pending: "待爬取",
  success: "成功",
  failed: "失败",
  blocked: "被拦截",
  no_website: "无官网",
};
const RUN_STATUS_CN: Record<string, string> = {
  succeeded: "成功",
  failed: "失败",
  running: "运行中",
  pending: "待运行",
};

/* ── page ──────────────────────────────────────────────────────────────── */
export default function ResearchPage() {
  usePageView({ resource_id: "/research" });
  const qc = useQueryClient();

  const [tab, setTab] = useState<TabKey>("products");
  const [search, setSearch] = useState("");
  // R49：搜索防抖（300ms）—— 输入即时回显，但只有停止输入后才发请求
  const debouncedSearch = useDebouncedValue(search, 300);
  const [country, setCountry] = useState("");
  const [category, setCategory] = useState("");
  const [canSupply, setCanSupply] = useState("");
  // R50：分页（后端 /research/products 支持 page/page_size；原来 page_size=200 硬编码无分页）
  const [page, setPage] = useState(1);
  const [exporting, setExporting] = useState(false);
  const [editing, setEditing] = useState<ResearchProduct | null>(null);
  const [picked, setPicked] = useState<number[]>([]);
  const [picking, setPicking] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  // P0-B1：移除调研产品不可恢复（深化数据一起没了）⇒ 二次确认 + 提交中禁用
  const [deleteTarget, setDeleteTarget] = useState<ResearchProduct | null>(
    null,
  );
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const deletingRef = useRef(false);
  // P0-B4：深化记录保存的 pending 防重（R51）
  const [savingEdit, setSavingEdit] = useState(false);
  const savingEditRef = useRef(false);
  // U-P0B6/X4：编辑改为 Dialog（草稿独立于列表）；保存失败留在弹窗内
  const [saveError, setSaveError] = useState<string | null>(null);
  const editOpenerRef = useRef<HTMLElement | null>(null);

  /* ── queries ── */
  const statsQuery = useQuery({
    queryKey: ["research-stats"],
    queryFn: async () =>
      (await apiClient.get<ResearchStats>("/research/stats")).data,
  });

  const categoriesQuery = useQuery({
    queryKey: ["research-categories"],
    queryFn: async () =>
      (await apiClient.get<{ items: string[] }>("/research/categories")).data,
  });
  const categories = categoriesQuery.data?.items ?? [];

  /** 当前筛选条件 → 查询参数（列表/导出全量共用同一份，避免两套口径漂移）。 */
  const productQueryParams = (targetPage: number, pageSize: number) => {
    const params = new URLSearchParams({
      page: String(targetPage),
      page_size: String(pageSize),
    });
    if (debouncedSearch) params.set("search", debouncedSearch);
    if (country) params.set("country", country);
    if (category) params.set("product_category", category);
    // 服务端三态过滤：true / false / unknown(未填)
    if (canSupply) params.set("can_supply", canSupply);
    return params;
  };

  const productsQuery = useQuery({
    queryKey: [
      "research-products",
      debouncedSearch,
      country,
      category,
      canSupply,
      page,
    ],
    queryFn: async () => {
      const params = productQueryParams(page, RESEARCH_PAGE_SIZE);
      return (
        await apiClient.get<{
          items: ResearchProduct[];
          total: number;
          page: number;
          page_size: number;
        }>(`/research/products?${params}`)
      ).data;
    },
    // 筛选/翻页时保留上一批数据：否则新 key 首帧 data=undefined ⇒ 整表卸载，
    // 编辑弹窗的"焦点归还目标"（行内按钮）也跟着被换掉，键盘用户会丢焦点。
    placeholderData: (previous) => previous,
  });
  const products = productsQuery.data?.items ?? [];

  const leadsQuery = useQuery({
    queryKey: ["research-lead-options"],
    queryFn: async () =>
      (
        await apiClient.get<{ items: LeadOption[]; total: number }>(
          "/leads?page_size=200&sort=recent",
        )
      ).data,
    enabled: tab === "pick" || createOpen,
  });
  const leads = leadsQuery.data?.items ?? [];

  const runsQuery = useQuery({
    queryKey: ["research-runs"],
    queryFn: async () =>
      (await apiClient.get<{ items: ResearchRun[] }>("/research/runs")).data,
    enabled: tab === "runs",
  });

  const stats = statsQuery.data;

  const countryOptions = useMemo(
    () => (stats?.by_country ?? []).map((c) => c.country).filter(Boolean),
    [stats],
  );

  /* ── actions ── */
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["research-products"] });
    qc.invalidateQueries({ queryKey: ["research-stats"] });
    qc.invalidateQueries({ queryKey: ["research-runs"] });
  };

  /** 打开编辑弹窗：记录触发按钮，关闭时归还焦点。 */
  const openEdit = (product: ResearchProduct, opener?: HTMLElement | null) => {
    editOpenerRef.current = opener ?? null;
    setSaveError(null);
    setEditing(product);
  };

  const closeEdit = () => {
    setEditing(null);
    setSaveError(null);
    // 焦点归还：对话框是被父组件直接卸载的（不是走 Dialog 的 close 生命周期），
    // 所以不能依赖 Dialog 自身的焦点恢复；这里在下一 tick 把焦点还给触发按钮。
    const opener = editOpenerRef.current;
    if (!opener) return;
    window.setTimeout(() => {
      if (opener.isConnected) opener.focus();
    }, 0);
  };

  /** 保存弹窗里的草稿（失败写回弹窗内错误，不关闭弹窗）。 */
  const saveEdit = async (draft: ResearchEditValue) => {
    if (savingEditRef.current) return;
    savingEditRef.current = true;
    setSavingEdit(true);
    setSaveError(null);
    try {
      await apiClient.patch(`/research/products/${draft.id}`, {
        product_name_cn: draft.product_name_cn || null,
        product_category: draft.product_category || null,
        price_local: draft.price_local,
        price_currency: draft.price_currency || null,
        market_note: draft.market_note || null,
        can_supply: draft.can_supply,
        supply_notes: draft.supply_notes || null,
      });
      toast.success("已保存");
      setEditing(null);
      refresh();
    } catch (err) {
      setSaveError(normalizeApiError(err).message);
    } finally {
      savingEditRef.current = false;
      setSavingEdit(false);
    }
  };

  /**
   * P0-B1：移除是**不可恢复**动作（深化数据：中文名/规格/税率/备注一起消失）。
   * 先弹确认；`deletingRef` 兜住连点（`deleting` 状态要等下一次渲染才生效）。
   */
  const remove = async () => {
    if (!deleteTarget || deletingRef.current) return;
    deletingRef.current = true;
    setDeleting(true);
    setDeleteError(null);
    try {
      await apiClient.delete(`/research/products/${deleteTarget.id}`);
      toast.success("已从调研集中移除");
      setDeleteTarget(null);
      refresh();
    } catch (err) {
      setDeleteError(normalizeApiError(err).message);
    } finally {
      deletingRef.current = false;
      setDeleting(false);
    }
  };

  const pickFromLeadgen = async () => {
    if (picked.length === 0) {
      toast.error("请至少选择一条线索");
      return;
    }
    setPicking(true);
    try {
      const { data } = await apiClient.post<{
        created: number;
        skipped: number;
        scanned: number;
      }>("/research/from-leadgen", { lead_ids: picked });
      toast.success(
        `已挑选 ${data.created} 条（跳过 ${data.skipped} 条已在调研集中的）`,
      );
      setPicked([]);
      refresh();
      setTab("products");
    } catch {
      toast.error("挑选失败");
    } finally {
      setPicking(false);
    }
  };

  /** CSV 写入（纯本地）：rowsToExport 决定导出范围（列表页 / 全量筛选结果）。 */
  const writeCsv = (rowsToExport: ResearchProduct[]) => {
    const header = [
      "product_name",
      "product_name_cn",
      "spec_raw",
      "country",
      "city",
      "shop_name",
      "shop_type",
      "phone",
      "email",
      "website",
      "link_url",
      "address",
      "product_category",
      "price_local",
      "price_currency",
      "can_supply",
      "supply_notes",
      "market_note",
    ];
    const esc = (v: unknown) => {
      const s = v === null || v === undefined ? "" : String(v);
      return `"${s.replace(/"/g, '""')}"`;
    };
    const rows = rowsToExport.map((p) =>
      header
        .map((k) => {
          if (k === "can_supply") {
            return esc(
              p.can_supply === null ? "" : p.can_supply ? "TRUE" : "FALSE",
            );
          }
          return esc((p as unknown as Record<string, unknown>)[k]);
        })
        .join(","),
    );
    const blob = new Blob(["\uFEFF" + [header.join(","), ...rows].join("\n")], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `market-research-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  /**
   * R48：导出**全部筛选结果**，不再静默截断成列表当前页。
   * 后端 /research/products 支持 page/page_size（le=200）⇒ 这里逐页拉完再写 CSV。
   * 失败如实提示（不能"点了没反应"）；导出量与列表页大小解耦。
   */
  const exportCsv = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const all: ResearchProduct[] = [];
      let targetPage = 1;
      let total = Number.POSITIVE_INFINITY;
      while (all.length < total) {
        const params = productQueryParams(targetPage, EXPORT_PAGE_SIZE);
        const { data } = await apiClient.get<{
          items: ResearchProduct[];
          total: number;
        }>(`/research/products?${params}`);
        total = data.total;
        if (data.items.length === 0) break;
        all.push(...data.items);
        targetPage += 1;
      }
      writeCsv(all);
      if (all.length > products.length) {
        // 说清"导出的是全部"而不是让人以为只有页面上这些
        toast.success(
          `已导出当前筛选的全部 ${all.length} 条（列表每页 ${RESEARCH_PAGE_SIZE} 条）`,
        );
      }
    } catch (err) {
      toast.error(normalizeApiError(err).message || "导出失败");
    } finally {
      setExporting(false);
    }
  };

  return (
    <RouteGuard>
      <PageHeader
        title="市场调研"
        description="从地图源中挑选有价值的记录并深化：规格、价格、供货能力"
      />
      <div className="space-y-6 p-6">
        {/* stats */}
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <StatCard
            label="调研产品"
            value={stats?.total ?? 0}
            icon={PackageSearch}
          />
          <StatCard
            label="可供货"
            value={stats?.can_supply_yes ?? 0}
            icon={CheckCircle2}
            variant="gradient"
          />
          <StatCard
            label="国家数"
            value={stats?.by_country.length ?? 0}
            icon={Globe2}
          />
          <StatCard
            label="类目数"
            value={stats?.by_category.length ?? 0}
            icon={Layers}
          />
        </div>

        {/* tabs */}
        <Tabs value={tab} onValueChange={(v) => setTab(v as TabKey)}>
          <TabsList variant="line">
            {TABS.map((t) => (
              <TabsTrigger key={t.key} variant="line" value={t.key}>
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        {tab === "products" && (
          <>
            <SectionCard
              title={`产品 (${productsQuery.data?.total ?? 0})`}
              action={
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setCreateOpen(true)}
                  >
                    <Plus className="mr-1 h-4 w-4" /> 手工录入
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void exportCsv()}
                    disabled={
                      exporting || (productsQuery.data?.total ?? 0) === 0
                    }
                  >
                    <Download className="mr-1 h-4 w-4" />{" "}
                    {exporting ? "导出中…" : "导出 CSV"}
                  </Button>
                </div>
              }
            >
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <Input
                  className="w-56"
                  placeholder="搜索产品 / 店铺…"
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value);
                    setPage(1);
                  }}
                />
                <select
                  className="rounded-md border bg-background px-3 py-2 text-sm"
                  value={country}
                  onChange={(e) => {
                    setCountry(e.target.value);
                    setPage(1);
                  }}
                >
                  <option value="">国家：全部</option>
                  {countryOptions.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
                <select
                  className="rounded-md border bg-background px-3 py-2 text-sm"
                  value={category}
                  onChange={(e) => {
                    setCategory(e.target.value);
                    setPage(1);
                  }}
                >
                  <option value="">类目：全部</option>
                  {categories.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
                <select
                  className="rounded-md border bg-background px-3 py-2 text-sm"
                  value={canSupply}
                  onChange={(e) => {
                    setCanSupply(e.target.value);
                    setPage(1);
                  }}
                >
                  {CAN_SUPPLY_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>

              {products.length === 0 ? (
                <EmptyState
                  icon={PackageSearch}
                  title="暂无调研产品"
                  description="到「从地图源挑选」选择值得深化的线索"
                />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-xs text-muted-foreground">
                        <th scope="col" className="p-2">
                          图片
                        </th>
                        <th scope="col" className="p-2">
                          产品（本地 / 中文）
                        </th>
                        <th scope="col" className="p-2">
                          规格
                        </th>
                        <th scope="col" className="p-2">
                          地区
                        </th>
                        <th scope="col" className="p-2">
                          店铺
                        </th>
                        <th scope="col" className="p-2">
                          联系方式
                        </th>
                        <th scope="col" className="p-2">
                          价格
                        </th>
                        <th scope="col" className="p-2">
                          可供货
                        </th>
                        <th scope="col" className="p-2" />
                      </tr>
                    </thead>
                    <tbody>
                      {products.map((p) => (
                        <tr key={p.id} className="border-b hover:bg-muted/40">
                          <td className="p-2">
                            {p.product_image_url ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                src={p.product_image_url}
                                alt={p.product_name ?? "产品"}
                                className="h-12 w-12 rounded object-cover"
                                loading="lazy"
                              />
                            ) : (
                              <div className="flex h-12 w-12 items-center justify-center rounded bg-secondary">
                                <ImageOff className="h-4 w-4 text-muted-foreground" />
                              </div>
                            )}
                          </td>
                          <td className="p-2">
                            <div className="font-medium">
                              {p.product_name ?? "—"}
                            </div>
                            <div className="text-xs text-muted-foreground">
                              {p.product_name_cn ?? "—"}
                            </div>
                          </td>
                          <td className="p-2 max-w-[220px] truncate text-xs text-muted-foreground">
                            {p.spec_raw ?? "—"}
                          </td>
                          <td className="p-2 text-xs">
                            {[p.country, p.city].filter(Boolean).join(" / ") ||
                              "—"}
                          </td>
                          <td className="p-2 text-xs">
                            <div>{p.shop_name ?? "—"}</div>
                            <div className="text-muted-foreground">
                              {p.shop_type ?? ""}
                            </div>
                          </td>
                          <td className="p-2 text-xs">
                            <div>{p.phone ?? "—"}</div>
                            {p.website && (
                              <a
                                className="text-primary hover:underline"
                                href={p.website}
                                target="_blank"
                                rel="noreferrer"
                              >
                                官网
                              </a>
                            )}
                          </td>
                          <td className="p-2 text-xs">
                            {p.price_local != null
                              ? `${p.price_local} ${p.price_currency ?? ""}`
                              : "—"}
                          </td>
                          <td className="p-2">{supplyBadge(p.can_supply)}</td>
                          <td className="p-2">
                            <div className="flex items-center gap-1">
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={(e) => openEdit(p, e.currentTarget)}
                                title="深化"
                                aria-label={`深化产品 ${p.product_name ?? p.id}`}
                              >
                                <Pencil className="h-4 w-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => {
                                  setDeleteError(null);
                                  setDeleteTarget(p);
                                }}
                                title="移除"
                                aria-label={`移除产品 ${p.product_name ?? p.id}`}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <PaginationBar
                page={page}
                pageSize={RESEARCH_PAGE_SIZE}
                total={productsQuery.data?.total ?? 0}
                currentCount={products.length}
                loading={productsQuery.isFetching}
                onPageChange={setPage}
                ariaLabel="调研产品分页"
              />
            </SectionCard>
          </>
        )}

        {tab === "pick" && (
          <SectionCard
            title={`地图源线索 (${leadsQuery.data?.total ?? 0})`}
            description="选择值得深化的记录。产品信息来自官网爬取，而非 Google Places。"
            action={
              <Button
                size="sm"
                onClick={pickFromLeadgen}
                disabled={picking || picked.length === 0}
              >
                {picking ? "挑选中…" : `挑选已选 (${picked.length})`}
              </Button>
            }
          >
            {leads.length === 0 ? (
              <EmptyState
                icon={MapPin}
                title="地图源中暂无线索"
                description="请先在「地图源线索采集」中运行抓取"
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs text-muted-foreground">
                      <th scope="col" className="p-2 w-8" />
                      <th scope="col" className="p-2">
                        公司
                      </th>
                      <th scope="col" className="p-2">
                        地区
                      </th>
                      <th scope="col" className="p-2">
                        店铺类型
                      </th>
                      <th scope="col" className="p-2">
                        产品
                      </th>
                      <th scope="col" className="p-2">
                        爬取
                      </th>
                      <th scope="col" className="p-2">
                        可供货
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {leads.map((l) => (
                      <tr key={l.id} className="border-b hover:bg-muted/40">
                        <td className="p-2">
                          <input
                            type="checkbox"
                            checked={picked.includes(l.id)}
                            onChange={(e) =>
                              setPicked(
                                e.target.checked
                                  ? [...picked, l.id]
                                  : picked.filter((x) => x !== l.id),
                              )
                            }
                          />
                        </td>
                        <td className="p-2 font-medium">{l.company_name}</td>
                        <td className="p-2 text-xs">
                          {[l.country, l.city].filter(Boolean).join(" / ") ||
                            "—"}
                        </td>
                        <td className="p-2 text-xs">{l.shop_type ?? "—"}</td>
                        <td className="p-2 text-xs">
                          <div>{l.product_name ?? "—"}</div>
                          <div className="text-muted-foreground">
                            {l.product_name_cn ?? ""}
                          </div>
                        </td>
                        <td className="p-2">
                          <StatusBadge
                            tone={toneForStatus(
                              CRAWL_STATUS_TONES,
                              l.crawl_status,
                            )}
                          >
                            {CRAWL_STATUS_CN[l.crawl_status ?? "pending"] ??
                              l.crawl_status ??
                              "pending"}
                          </StatusBadge>
                        </td>
                        <td className="p-2">
                          {l.can_supply === true ? (
                            <CheckCircle2 className="h-4 w-4 text-success" />
                          ) : l.can_supply === false ? (
                            <XCircle className="h-4 w-4 text-destructive" />
                          ) : (
                            <span className="text-xs text-muted-foreground">
                              —
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </SectionCard>
        )}

        {tab === "runs" && (
          <SectionCard title="运行历史">
            {(runsQuery.data?.items ?? []).length === 0 ? (
              <EmptyState icon={History} title="暂无运行记录" />
            ) : (
              <div className="space-y-1 text-sm">
                {(runsQuery.data?.items ?? []).map((r) => (
                  <div
                    key={r.id}
                    className="flex flex-wrap items-center gap-3 rounded border px-3 py-2"
                  >
                    <StatusBadge
                      tone={toneForStatus(RUN_STATUS_TONES, r.status)}
                    >
                      {RUN_STATUS_CN[r.status] ?? r.status}
                    </StatusBadge>
                    <span className="text-muted-foreground">#{r.id}</span>
                    <Badge variant="outline">
                      {String((r.config ?? {}).action ?? "—")}
                    </Badge>
                    <span>找到 {r.products_found ?? "-"}</span>
                    <span>保留 {r.products_kept ?? "-"}</span>
                    <span className="ml-auto text-xs text-muted-foreground">
                      {r.created_at?.slice(0, 19) ?? ""}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </SectionCard>
        )}
      </div>

      <ManualResearchDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        categories={categories}
        leads={leads}
        leadsLoading={leadsQuery.isLoading}
        onCreated={() => {
          refresh();
          setTab("products");
        }}
      />

      {/* U-P0B6/X4：编辑改为 Dialog（草稿独立于列表，失败留弹窗可重试） */}
      {editing && (
        <ResearchEditDialog
          key={editing.id}
          product={editing}
          categories={categories}
          pending={savingEdit}
          error={saveError}
          onSubmit={(draft) => void saveEdit(draft)}
          onClose={closeEdit}
        />
      )}

      {/* P0-B1：移除调研产品的二次确认 —— 深化数据不可恢复 */}
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open && !deletingRef.current) {
            setDeleteTarget(null);
            setDeleteError(null);
          }
        }}
        title={`从调研集移除「${deleteTarget?.product_name_cn ?? deleteTarget?.product_name ?? ""}」？`}
        description="移除后该产品的深化数据（中文名、规格、进项税/退税率、备注）会一并删除且不可恢复；如果只是暂时不需要，建议保留记录。"
        confirmLabel="确认移除"
        pending={deleting}
        error={deleteError}
        onConfirm={() => void remove()}
      />
    </RouteGuard>
  );
}
