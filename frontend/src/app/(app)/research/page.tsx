"use client";

import { useMemo, useState } from "react";
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
} from "@/components/shared";
import { toast } from "sonner";
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
  const [country, setCountry] = useState("");
  const [category, setCategory] = useState("");
  const [canSupply, setCanSupply] = useState("");
  const [editing, setEditing] = useState<ResearchProduct | null>(null);
  const [picked, setPicked] = useState<number[]>([]);
  const [picking, setPicking] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

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

  const productsQuery = useQuery({
    queryKey: ["research-products", search, country, category, canSupply],
    queryFn: async () => {
      const params = new URLSearchParams({ page_size: "200" });
      if (search) params.set("search", search);
      if (country) params.set("country", country);
      if (category) params.set("product_category", category);
      // 服务端三态过滤：true / false / unknown(未填)
      if (canSupply) params.set("can_supply", canSupply);
      return (
        await apiClient.get<{ items: ResearchProduct[]; total: number }>(
          `/research/products?${params}`,
        )
      ).data;
    },
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

  const saveEdit = async () => {
    if (!editing) return;
    try {
      await apiClient.patch(`/research/products/${editing.id}`, {
        product_name_cn: editing.product_name_cn || null,
        product_category: editing.product_category || null,
        price_local: editing.price_local,
        price_currency: editing.price_currency || null,
        market_note: editing.market_note || null,
        can_supply: editing.can_supply,
        supply_notes: editing.supply_notes || null,
      });
      toast.success("已保存");
      setEditing(null);
      refresh();
    } catch {
      toast.error("保存失败");
    }
  };

  const remove = async (id: number) => {
    try {
      await apiClient.delete(`/research/products/${id}`);
      toast.success("已从调研集中移除");
      refresh();
    } catch {
      toast.error("删除失败");
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

  const exportCsv = () => {
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
    const rows = products.map((p) =>
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
                    onClick={exportCsv}
                    disabled={products.length === 0}
                  >
                    <Download className="mr-1 h-4 w-4" /> 导出 CSV
                  </Button>
                </div>
              }
            >
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <Input
                  className="w-56"
                  placeholder="搜索产品 / 店铺…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                <select
                  className="rounded-md border bg-background px-3 py-2 text-sm"
                  value={country}
                  onChange={(e) => setCountry(e.target.value)}
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
                  onChange={(e) => setCategory(e.target.value)}
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
                  onChange={(e) => setCanSupply(e.target.value)}
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
                        <th className="p-2">图片</th>
                        <th className="p-2">产品（本地 / 中文）</th>
                        <th className="p-2">规格</th>
                        <th className="p-2">地区</th>
                        <th className="p-2">店铺</th>
                        <th className="p-2">联系方式</th>
                        <th className="p-2">价格</th>
                        <th className="p-2">可供货</th>
                        <th className="p-2" />
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
                                onClick={() => setEditing({ ...p })}
                                title="深化"
                              >
                                <Pencil className="h-4 w-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => remove(p.id)}
                                title="移除"
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
            </SectionCard>

            {editing && (
              <SectionCard
                title="深化记录"
                description="供货能力由你判定 —— 绝不由系统推断"
                action={
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setEditing(null)}
                    >
                      取消
                    </Button>
                    <Button size="sm" onClick={saveEdit}>
                      保存
                    </Button>
                  </div>
                }
              >
                <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                  <div>
                    <label className="text-xs text-muted-foreground">
                      本地产品
                    </label>
                    <Input value={editing.product_name ?? ""} disabled />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground">
                      中文产品名
                    </label>
                    <Input
                      value={editing.product_name_cn ?? ""}
                      onChange={(e) =>
                        setEditing({
                          ...editing,
                          product_name_cn: e.target.value,
                        })
                      }
                    />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground">
                      类目
                    </label>
                    <select
                      className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                      value={editing.product_category ?? ""}
                      onChange={(e) =>
                        setEditing({
                          ...editing,
                          product_category: e.target.value,
                        })
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
                    <label className="text-xs text-muted-foreground">
                      当地价格
                    </label>
                    <Input
                      type="number"
                      value={editing.price_local ?? ""}
                      onChange={(e) =>
                        setEditing({
                          ...editing,
                          price_local:
                            e.target.value === ""
                              ? null
                              : Number(e.target.value),
                        })
                      }
                    />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground">
                      币种
                    </label>
                    <Input
                      value={editing.price_currency ?? ""}
                      onChange={(e) =>
                        setEditing({
                          ...editing,
                          price_currency: e.target.value,
                        })
                      }
                    />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground">
                      可供货
                    </label>
                    <select
                      className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                      value={
                        editing.can_supply === null
                          ? ""
                          : editing.can_supply
                            ? "true"
                            : "false"
                      }
                      onChange={(e) =>
                        setEditing({
                          ...editing,
                          can_supply:
                            e.target.value === ""
                              ? null
                              : e.target.value === "true",
                        })
                      }
                    >
                      <option value="">未填</option>
                      <option value="true">是</option>
                      <option value="false">否</option>
                    </select>
                  </div>
                  <div className="md:col-span-2">
                    <label className="text-xs text-muted-foreground">
                      供货备注
                    </label>
                    <Input
                      value={editing.supply_notes ?? ""}
                      onChange={(e) =>
                        setEditing({ ...editing, supply_notes: e.target.value })
                      }
                    />
                  </div>
                  <div className="md:col-span-3">
                    <label className="text-xs text-muted-foreground">
                      市场备注
                    </label>
                    <textarea
                      className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                      rows={3}
                      value={editing.market_note ?? ""}
                      onChange={(e) =>
                        setEditing({ ...editing, market_note: e.target.value })
                      }
                    />
                  </div>
                </div>
                {editing.spec_raw && (
                  <div className="mt-3">
                    <p className="text-xs text-muted-foreground">
                      规格（来自来源）
                    </p>
                    <p className="mt-1 rounded bg-secondary/50 p-2 text-xs">
                      {editing.spec_raw}
                    </p>
                  </div>
                )}
              </SectionCard>
            )}
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
                      <th className="p-2 w-8" />
                      <th className="p-2">公司</th>
                      <th className="p-2">地区</th>
                      <th className="p-2">店铺类型</th>
                      <th className="p-2">产品</th>
                      <th className="p-2">爬取</th>
                      <th className="p-2">可供货</th>
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
                            tone={
                              l.crawl_status === "success"
                                ? "success"
                                : l.crawl_status === "failed" ||
                                    l.crawl_status === "blocked"
                                  ? "danger"
                                  : "default"
                            }
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
                      tone={r.status === "succeeded" ? "success" : "danger"}
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
    </RouteGuard>
  );
}
