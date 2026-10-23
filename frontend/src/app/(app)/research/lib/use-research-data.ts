"use client";

/**
 * 调研工位的数据层（从 page.tsx 抽出；queryKey/参数/placeholderData 行为不变）。
 *
 * 为什么单独抽 hook：主文件保留"状态编排"，列表/统计/挑选/运行历史的取数口径
 * （筛选参数、分页大小、防抖后的搜索词）集中在一处，列表与"导出全量"共用
 * `productQueryParams`，避免两套参数口径漂移。
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";

import { RESEARCH_PAGE_SIZE } from "./constants";
import type {
  LeadOption,
  ResearchProduct,
  ResearchProductPage,
  ResearchRun,
  ResearchStats,
  TabKey,
} from "./types";

export function useResearchData({
  tab,
  createOpen,
  debouncedSearch,
  country,
  category,
  canSupply,
  page,
}: {
  tab: TabKey;
  createOpen: boolean;
  debouncedSearch: string;
  country: string;
  category: string;
  canSupply: string;
  page: number;
}) {
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

  /** 取某一页（供导出全量复用，参数与列表同源）。 */
  const fetchProductPage = async (
    targetPage: number,
    pageSize: number,
  ): Promise<ResearchProductPage> => {
    const params = productQueryParams(targetPage, pageSize);
    return (
      await apiClient.get<ResearchProductPage>(`/research/products?${params}`)
    ).data;
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
    queryFn: () => fetchProductPage(page, RESEARCH_PAGE_SIZE),
    // 筛选/翻页时保留上一批数据：否则新 key 首帧 data=undefined ⇒ 整表卸载，
    // 编辑弹窗的"焦点归还目标"（行内按钮）也跟着被换掉，键盘用户会丢焦点。
    placeholderData: (previous) => previous,
  });
  const products: ResearchProduct[] = productsQuery.data?.items ?? [];

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

  return {
    stats,
    categories,
    countryOptions,
    products,
    productsTotal: productsQuery.data?.total ?? 0,
    productsFetching: productsQuery.isFetching,
    /** 列表/导出共用的参数构造器 */
    productQueryParams,
    /** 取某一页（导出全量用） */
    fetchProductPage,
    leads,
    leadsTotal: leadsQuery.data?.total ?? 0,
    leadsLoading: leadsQuery.isLoading,
    runs: runsQuery.data?.items ?? [],
  };
}
