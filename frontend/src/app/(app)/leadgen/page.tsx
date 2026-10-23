"use client";

/**
 * 线索开发工位（U-P1D2：拆分后本文件只剩「状态编排 + 数据 hooks」）。
 *
 * 视图层在 ./components（config-form / run-actions / run-history / filters /
 * table / detail-drawer），类型·文案·焦点归还在 ./lib。
 *
 * 口径不变：写操作全走 apiClient；失败只写页内 role="alert"（拦截器已 toast，
 * 不重复）；pending 期间按钮禁用防重。
 */
import { useRef, useState } from "react";
import { usePageView } from "@/lib/events/use-page-view";
import { RouteGuard } from "@/components/route-guard";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { PageHeader, SectionCard } from "@/components/shared";
import { useAsyncAction } from "@/lib/hooks/use-async-action";
import { toast } from "sonner";

import { LeadgenCsvImport } from "./components/csv-import-panel";
import { ManualLeadDialog } from "./components/manual-lead-dialog";
import { LeadgenConfigFields } from "./components/leadgen-config-form";
import { LeadgenRunActions } from "./components/leadgen-run-actions";
import { LeadgenRunHistory } from "./components/leadgen-run-history";
import { LeadgenFilters } from "./components/leadgen-filters";
import { LeadgenTable } from "./components/leadgen-table";
import { LeadgenDetailDrawer } from "./components/leadgen-detail-drawer";
import { restoreFocus } from "./lib/restore-focus";
import type {
  Lead,
  LeadDetail,
  LeadgenConfig,
  LeadgenRun,
  LeadgenValidation,
} from "./lib/types";

export default function LeadgenPage() {
  usePageView({ resource_id: "/leadgen" });
  const qc = useQueryClient();
  const [cfg, setCfg] = useState<LeadgenConfig>({
    region: "",
    industry: "",
    icp: "",
    quantity: 20,
    source: "demo",
  });
  const [validating, setValidating] = useState(false);
  const [validation, setValidation] = useState<LeadgenValidation | null>(null);
  const [search, setSearch] = useState("");
  const [outreachFilter, setOutreachFilter] = useState("");
  const [inquiryFilter, setInquiryFilter] = useState("");
  const [sort, setSort] = useState("score");
  const [detail, setDetail] = useState<LeadDetail | null>(null);
  /** 正在加载详情的线索 id（用于行级 pending 与重试） */
  const [detailId, setDetailId] = useState<number | null>(null);
  /** U-P0B6/X2：详情改为右侧抽屉（列表不再被内联面板下推） */
  const [detailOpen, setDetailOpen] = useState(false);
  /** 关闭抽屉后把焦点还给触发它的「详情」按钮（键盘用户不丢位置） */
  const detailOpenerRef = useRef<HTMLElement | null>(null);
  const [manualLeadOpen, setManualLeadOpen] = useState(false);
  const [crawling, setCrawling] = useState<number | null>(null);

  const { data: regionsData } = useQuery({
    queryKey: ["leadgen-regions"],
    queryFn: async () =>
      (await apiClient.get<{ items: string[] }>("/leadgen/regions")).data,
  });
  const regions = regionsData?.items ?? [];

  const { data: runsData, refetch: refetchRuns } = useQuery({
    queryKey: ["leadgen-runs"],
    queryFn: async () =>
      (await apiClient.get<{ items: LeadgenRun[] }>("/leadgen/runs")).data,
  });

  const leadsQuery = useQuery({
    queryKey: ["leads", search, outreachFilter, inquiryFilter, sort],
    queryFn: async () => {
      const params = new URLSearchParams({ sort, page_size: "100" });
      if (search) params.set("search", search);
      if (outreachFilter) params.set("outreach_status", outreachFilter);
      if (inquiryFilter) params.set("inquiry_status", inquiryFilter);
      return (
        await apiClient.get<{ items: Lead[]; total: number }>(
          `/leads?${params}`,
        )
      ).data;
    },
  });
  const leads = leadsQuery.data?.items ?? [];

  const validate = async () => {
    setValidating(true);
    try {
      const { data } = await apiClient.post<{
        result: { valid: boolean; issues: string[] };
        path: string;
      }>("/leadgen/validate", {
        region: cfg.region,
        industry: cfg.industry,
        icp: cfg.icp || null,
        quantity: cfg.quantity,
        source: cfg.source,
      });
      setValidation({ ...data.result, path: data.path });
    } catch {
      toast.error("校验失败");
    } finally {
      setValidating(false);
    }
  };

  /**
   * P0-B4：「开始抓取」（批量抓取）走 useAsyncAction（pending 防重）+ 失败页内出口。
   */
  const runAction = useAsyncAction(
    async () => {
      const { data } = await apiClient.post<LeadgenRun>("/leadgen/runs", {
        region: cfg.region,
        industry: cfg.industry,
        icp: cfg.icp || null,
        quantity: cfg.quantity,
        source: cfg.source,
      });
      return data;
    },
    {
      onSuccess: (data) => {
        if (data.deduplicated) toast.info("相同配置已跑过 — 返回上次结果");
        else toast.success(`抓取完成：保留 ${data.leads_kept ?? 0} 条新线索`);
        qc.invalidateQueries({ queryKey: ["leads"] });
        refetchRuns();
      },
    },
  );

  const run = () => {
    // CSV 数据源必须走 multipart 上传端点；JSON 端点收到 source=csv 会 422 CSV_REQUIRED
    if (cfg.source === "csv") {
      toast.error("CSV 数据源请用下方「导入 CSV 线索」上传文件");
      return;
    }
    void runAction.run();
  };

  /** P0-B2/L4：「扫描已回复→询盘」pending 防重 + 失败出口。 */
  const scan = useAsyncAction(
    async () => {
      const { data } = await apiClient.post<{
        scanned: number;
        created: number;
      }>("/leads/scan-replied");
      return data;
    },
    {
      onSuccess: (data) => {
        toast.success(
          `已扫描 ${data.scanned} 条已回复线索，创建 ${data.created} 条询盘`,
        );
        qc.invalidateQueries({ queryKey: ["leads"] });
      },
    },
  );

  /** P0-B2/L3：详情失败不再是死路（抽屉内 ErrorState + 重试）。 */
  const detailAction = useAsyncAction(
    async (id: number) => {
      const { data } = await apiClient.get<LeadDetail>(`/leads/${id}`);
      return data;
    },
    { onSuccess: (data) => setDetail(data) },
  );

  const openDetail = (id: number, opener?: HTMLElement | null) => {
    detailOpenerRef.current = opener ?? null;
    setDetailId(id);
    setDetail(null);
    setDetailOpen(true);
    void detailAction.run(id);
  };

  const retryDetail = () => {
    if (detailId !== null) void detailAction.run(detailId);
  };

  const closeDetail = () => {
    setDetailOpen(false);
    setDetail(null);
    // 抽屉卸载后归还焦点（处理 base-ui finalFocus 的时序竞争）
    restoreFocus(detailOpenerRef.current);
  };

  /* ── 爬官网（产品信息唯一来源；Google Places 看不到产品）───────────── */
  const crawlOne = async (id: number) => {
    setCrawling(id);
    try {
      const { data } = await apiClient.post<{
        result: { status: string; error: string | null };
        lead: LeadDetail;
      }>(`/leads/${id}/crawl`);
      const st = data.result.status;
      if (st === "success") toast.success("爬取完成：已提取产品信息");
      else if (st === "no_website") toast.info("该线索没有官网");
      else toast.error(`爬取失败：${data.result.error ?? "未知"}`);
      qc.invalidateQueries({ queryKey: ["leads"] });
      if (detail?.id === id) setDetail(data.lead);
    } catch {
      toast.error("爬取请求失败");
    } finally {
      setCrawling(null);
    }
  };

  /** P0-B4：「爬取网站 (10)」= 批量爬取 mutation（非单行 crawlOne）。 */
  const crawlBatch = useAsyncAction(
    async () => {
      const { data } = await apiClient.post<{
        crawled: number;
        success: number;
        failed: number;
        blocked: number;
        no_website: number;
      }>("/leads/crawl-batch", { only_pending: true, limit: 10 });
      return data;
    },
    {
      onSuccess: (data) => {
        toast.success(
          `已爬取 ${data.crawled}：成功 ${data.success}，失败 ${data.failed}，` +
            `无官网 ${data.no_website}${data.blocked ? `，被拦截 ${data.blocked}` : ""}`,
        );
        qc.invalidateQueries({ queryKey: ["leads"] });
      },
    },
  );

  /* ── 能否提供：由用户判定，不由 AI 推断 ── */
  const setSupply = async (id: number, value: boolean | null) => {
    try {
      await apiClient.patch(`/leads/${id}`, { can_supply: value });
      qc.invalidateQueries({ queryKey: ["leads"] });
      if (detail?.id === id) setDetail({ ...detail, can_supply: value });
    } catch {
      toast.error("更新失败");
    }
  };

  const setNum = (v: string) =>
    setCfg({ ...cfg, quantity: Math.max(1, parseInt(v || "1", 10)) });

  /**
   * FormField 收编：把「属于行业关键词」的校验问题挂到该字段上
   * （aria-invalid + aria-describedby）。不认识的问题仍由下方校验徽标整体展示。
   */
  const industryError =
    validation && !validation.valid
      ? (validation.issues.find((issue) => /industry|行业/i.test(issue)) ??
        null)
      : null;

  return (
    <RouteGuard>
      <PageHeader
        title="线索开发"
        description="抓取潜在客户，AI 打分后进入共享线索池"
      />
      <div className="space-y-6 p-6">
        {/* config */}
        <SectionCard title="抓取配置">
          <LeadgenConfigFields
            cfg={cfg}
            regions={regions}
            onChange={(patch) => setCfg({ ...cfg, ...patch })}
            onQuantityChange={setNum}
            industryError={industryError}
          />
          <LeadgenRunActions
            validating={validating}
            validation={validation}
            onValidate={validate}
            onRun={run}
            runPending={runAction.pending}
            runError={runAction.error}
            onScan={() => void scan.run()}
            scanPending={scan.pending}
            scanError={scan.error}
            onCrawlBatch={() => void crawlBatch.run()}
            crawlBatchPending={crawlBatch.pending}
            crawlBatchError={crawlBatch.error}
            crawling={crawling}
          />
          <p className="mt-2 text-xs text-muted-foreground">
            CSV 文件可直接导入线索；地图搜索等更多数据源正在规划中。
          </p>
          {cfg.source === "csv" && (
            <LeadgenCsvImport onImported={() => void refetchRuns()} />
          )}
        </SectionCard>

        {/* runs history */}
        <LeadgenRunHistory runs={runsData?.items ?? []} />

        {/* lead pool */}
        <SectionCard title={`线索池 (${leadsQuery.data?.total ?? 0})`}>
          <LeadgenFilters
            search={search}
            onSearchChange={setSearch}
            outreachFilter={outreachFilter}
            onOutreachFilterChange={setOutreachFilter}
            inquiryFilter={inquiryFilter}
            onInquiryFilterChange={setInquiryFilter}
            sort={sort}
            onSortChange={setSort}
            onCreateManual={() => setManualLeadOpen(true)}
          />

          <LeadgenTable
            leads={leads}
            crawling={crawling}
            detailPending={detailAction.pending}
            detailId={detailId}
            onCrawlOne={crawlOne}
            onOpenDetail={openDetail}
          />

          {/*
            U-P0B6/X2：线索详情 = 右侧 DetailDrawer（拆到 components/leadgen-detail-drawer）。
            加载/失败复用 useAsyncAction（LoadingBlock / ErrorState + 重试）。
          */}
          <LeadgenDetailDrawer
            open={detailOpen}
            detail={detail}
            pending={detailAction.pending}
            error={detailAction.error}
            onRetry={retryDetail}
            onClose={closeDetail}
            crawling={crawling}
            onCrawl={crawlOne}
            onSetSupply={setSupply}
          />
        </SectionCard>
        <ManualLeadDialog
          open={manualLeadOpen}
          onOpenChange={setManualLeadOpen}
        />
      </div>
    </RouteGuard>
  );
}
