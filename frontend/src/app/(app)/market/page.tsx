"use client";

import { useState } from "react";
import { usePageView } from "@/lib/events/use-page-view";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type TabKey = "region" | "product" | "usage" | "ports";

const TABS: { key: TabKey; label: string }[] = [
  { key: "region", label: "按地区查询" },
  { key: "product", label: "按品名查询" },
  { key: "usage", label: "按用途查询" },
  { key: "ports", label: "港口情报" },
];

interface RegionProduct {
  id: number;
  region_code: string;
  category_id: number | null;
  demand_level: string | null;
  popularity_rank: number | null;
  cert_requirements: string[] | null;
  standards: string[] | null;
  seasonality: string | null;
  specs: { key: string; value: string; unit: string | null; rank: number | null }[];
}

interface NameMapping {
  id: number;
  category_id: number | null;
  region_code: string;
  lang: string;
  local_name: string;
  alt_names: string[] | null;
  hs_code: string | null;
  is_verified: boolean;
  confidence: string | null;
}

interface Port {
  id: number;
  name_cn: string;
  name_en: string;
  un_locode: string | null;
  country_code: string;
  city: string | null;
  port_type: string | null;
  position_desc: string | null;
  suitable_cargo: string[] | null;
  suitable_shipping_modes: string[] | null;
  congestion_level: string | null;
}

function useRegions() {
  return useQuery({
    queryKey: ["market", "regions"],
    queryFn: async () => {
      const { data } = await apiClient.get<string[]>("/market/regions");
      return data;
    },
  });
}

function useRegionProducts(regionCode: string | null) {
  return useQuery({
    queryKey: ["market", "region-products", regionCode],
    queryFn: async () => {
      if (!regionCode) return [];
      const { data } = await apiClient.get<RegionProduct[]>(`/market/regions/${regionCode}/products`);
      return data;
    },
    enabled: !!regionCode,
  });
}

function useNameLookup(q: string, regionCode?: string) {
  return useQuery({
    queryKey: ["market", "name-lookup", q, regionCode],
    queryFn: async () => {
      if (!q) return [];
      const params = new URLSearchParams({ q });
      if (regionCode) params.set("region_code", regionCode);
      const { data } = await apiClient.get<NameMapping[]>(`/market/name-lookup?${params}`);
      return data;
    },
    enabled: q.length > 0,
  });
}

function usePorts(countryCode?: string) {
  return useQuery({
    queryKey: ["market", "ports", countryCode],
    queryFn: async () => {
      const params = countryCode ? `?country_code=${countryCode}` : "";
      const { data } = await apiClient.get<Port[]>(`/market/ports${params}`);
      return data;
    },
  });
}

function RegionTab() {
  const { data: regions } = useRegions();
  const [selected, setSelected] = useState<string | null>(null);
  const { data: products, isLoading } = useRegionProducts(selected);

  return (
    <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
      <Card className="md:col-span-1">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">选择地区</CardTitle>
        </CardHeader>
        <CardContent className="p-2">
          {regions?.length === 0 && (
            <p className="text-xs text-muted-foreground p-2">暂无地区数据</p>
          )}
          <div className="space-y-1">
            {regions?.map((r) => (
              <button
                key={r}
                onClick={() => setSelected(r)}
                className={cn(
                  "w-full text-left px-3 py-2 text-sm rounded-md hover:bg-muted transition-colors",
                  selected === r && "bg-primary text-primary-foreground"
                )}
              >
                {r}
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card className="md:col-span-3">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">
            {selected ? `${selected} 在售产品` : "选择地区后查看"}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading && <p className="text-sm text-muted-foreground">加载中…</p>}
          {!isLoading && products?.length === 0 && selected && (
            <p className="text-sm text-muted-foreground">该地区暂无产品数据</p>
          )}
          <div className="space-y-4">
            {products?.map((p) => (
              <div key={p.id} className="border rounded-md p-4 space-y-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium text-sm">品类 #{p.category_id ?? "-"}</span>
                  {p.demand_level && (
                    <Badge variant={p.demand_level === "high" ? "default" : "secondary"}>
                      {p.demand_level}
                    </Badge>
                  )}
                  {p.popularity_rank && (
                    <span className="text-xs text-muted-foreground">热度 #{p.popularity_rank}</span>
                  )}
                </div>
                {p.cert_requirements && p.cert_requirements.length > 0 && (
                  <div className="flex gap-1 flex-wrap">
                    {p.cert_requirements.map((c) => (
                      <Badge key={c} variant="outline" className="text-xs">{c}</Badge>
                    ))}
                  </div>
                )}
                {p.specs.length > 0 && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">常见规格</p>
                    <div className="flex gap-2 flex-wrap">
                      {p.specs.map((s, i) => (
                        <Badge key={i} variant="secondary" className="text-xs">
                          {s.key}: {s.value}{s.unit ? ` ${s.unit}` : ""}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function ProductTab() {
  const [q, setQ] = useState("");
  const [region, setRegion] = useState("");
  const { data: results, isLoading } = useNameLookup(q, region || undefined);
  const { data: regions } = useRegions();

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <Input
          placeholder="输入品名（中英文均可），如 chain link fence / 勾花网 / malla"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="max-w-md"
        />
        <select
          value={region}
          onChange={(e) => setRegion(e.target.value)}
          className="border rounded-md px-3 text-sm bg-background"
        >
          <option value="">全部地区</option>
          {regions?.map((r) => (
            <option key={r} value={r}>{r}</option>
          ))}
        </select>
      </div>

      {isLoading && <p className="text-sm text-muted-foreground">搜索中…</p>}
      {!isLoading && q && results?.length === 0 && (
        <p className="text-sm text-muted-foreground">未找到匹配品名</p>
      )}

      <div className="space-y-3">
        {results?.map((r) => (
          <Card key={r.id}>
            <CardContent className="pt-4">
              <div className="flex items-start justify-between">
                <div>
                  <p className="font-medium">{r.local_name}</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {r.region_code} · {r.lang} · 品类 #{r.category_id ?? "-"}
                    {r.hs_code && ` · HS ${r.hs_code}`}
                  </p>
                  {r.alt_names && r.alt_names.length > 0 && (
                    <div className="flex gap-1 flex-wrap mt-2">
                      {r.alt_names.map((a, i) => (
                        <Badge key={i} variant="outline" className="text-xs">{a}</Badge>
                      ))}
                    </div>
                  )}
                </div>
                {r.is_verified && <Badge>已核实</Badge>}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

function UsageTab() {
  const { data: usages } = useQuery({
    queryKey: ["market", "usages"],
    queryFn: async () => {
      const { data } = await apiClient.get<{ id: number; usage_code: string; usage_name: string; description: string | null }[]>("/market/usages");
      return data;
    },
  });

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        按用途反查适用产品类别（数据来自市场对照工位）
      </p>
      {usages?.length === 0 && (
        <p className="text-sm text-muted-foreground">暂无用途分类数据，请先录入</p>
      )}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        {usages?.map((u) => (
          <Card key={u.id}>
            <CardContent className="pt-4">
              <p className="font-medium text-sm">{u.usage_name}</p>
              <p className="text-xs text-muted-foreground mt-1">{u.usage_code}</p>
              {u.description && <p className="text-xs text-muted-foreground mt-2">{u.description}</p>}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

function PortsTab() {
  const [country, setCountry] = useState("");
  const { data: ports, isLoading } = usePorts(country || undefined);

  return (
    <div className="space-y-4">
      <div className="flex gap-2 items-center">
        <Input
          placeholder="输入国家代码过滤，如 US / DE / AE"
          value={country}
          onChange={(e) => setCountry(e.target.value.toUpperCase())}
          className="max-w-xs"
        />
        {country && (
          <Button variant="ghost" size="sm" onClick={() => setCountry("")}>清除</Button>
        )}
      </div>

      {isLoading && <p className="text-sm text-muted-foreground">加载中…</p>}
      {!isLoading && ports?.length === 0 && (
        <p className="text-sm text-muted-foreground">暂无港口数据</p>
      )}

      <div className="space-y-3">
        {ports?.map((p) => (
          <Card key={p.id}>
            <CardContent className="pt-4">
              <div className="flex items-start justify-between">
                <div>
                  <p className="font-medium text-sm">{p.name_en} {p.name_cn !== p.name_en && `(${p.name_cn})`}</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {p.country_code} · {p.city ?? "-"} · {p.un_locode ?? "-"}
                    {p.port_type && ` · ${p.port_type}`}
                  </p>
                  {p.position_desc && (
                    <p className="text-xs text-muted-foreground mt-1">{p.position_desc}</p>
                  )}
                </div>
                {p.congestion_level && (
                  <Badge variant={p.congestion_level === "high" ? "destructive" : "secondary"}>
                    拥堵: {p.congestion_level}
                  </Badge>
                )}
              </div>
              {p.suitable_cargo && p.suitable_cargo.length > 0 && (
                <div className="flex gap-1 flex-wrap mt-3">
                  {p.suitable_cargo.map((c) => (
                    <Badge key={c} variant="outline" className="text-xs">{c}</Badge>
                  ))}
                </div>
              )}
              {p.suitable_shipping_modes && p.suitable_shipping_modes.length > 0 && (
                <div className="flex gap-1 flex-wrap mt-2">
                  {p.suitable_shipping_modes.map((m) => (
                    <Badge key={m} variant="secondary" className="text-xs">{m}</Badge>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

export default function MarketPage() {
  usePageView({ resource_id: "/market" });
  const [activeTab, setActiveTab] = useState<TabKey>("region");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold md:text-2xl">产品市场对照</h1>
        <p className="text-sm text-muted-foreground mt-1">
          按地区 / 品名 / 用途查询产品与规格，港口情报与最近港口匹配
        </p>
      </div>

      <div className="flex gap-2 border-b">
        {TABS.map((tab) => (
          <Button
            key={tab.key}
            variant="ghost"
            className={cn(
              "rounded-none border-b-2 border-transparent px-4 pb-2",
              activeTab === tab.key && "border-primary font-medium"
            )}
            onClick={() => setActiveTab(tab.key)}
          >
            {tab.label}
          </Button>
        ))}
      </div>

      <div className="mt-6">
        {activeTab === "region" && <RegionTab />}
        {activeTab === "product" && <ProductTab />}
        {activeTab === "usage" && <UsageTab />}
        {activeTab === "ports" && <PortsTab />}
      </div>
    </div>
  );
}
