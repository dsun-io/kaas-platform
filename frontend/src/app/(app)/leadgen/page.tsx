"use client";

import { useRef, useState } from "react";
import { usePageView } from "@/lib/events/use-page-view";
import { RouteGuard } from "@/components/route-guard";
import { LeadgenCsvImport } from "./components/csv-import-panel";
import { ManualLeadDialog } from "./components/manual-lead-dialog";
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
  ErrorState,
  AsyncButton,
  DetailDrawer,
} from "@/components/shared";
import { LoadingBlock } from "@/components/shared/loading-block";
import { useAsyncAction } from "@/lib/hooks/use-async-action";
import {
  CRAWL_STATUS_TONES,
  INQUIRY_STATUS_TONES,
  OUTREACH_STATUS_TONES,
  RUN_STATUS_TONES,
  scoreTone,
  toneForStatus,
} from "@/lib/status-tones";
import { toast } from "sonner";
import {
  Play,
  ShieldCheck,
  RefreshCw,
  Globe,
  ImageOff,
  CheckCircle2,
  XCircle,
} from "lucide-react";

/** 关闭抽屉/弹窗后把焦点还给触发按钮。
 *  base-ui 在卸载 popup 时会执行自己的 finalFocus，可能与我们的 focus() 抢时序
 *  （并发/动画下必现）⇒ 这里"重试到生效"，而不是一次性 setTimeout。 */
function restoreFocus(target: HTMLElement | null) {
  if (!target) return;
  let attempts = 0;
  const tick = () => {
    target.focus();
    if (document.activeElement !== target && attempts < 10) {
      attempts += 1;
      window.setTimeout(tick, 16);
    }
  };
  window.setTimeout(tick, 0);
}

/* ── types ─────────────────────────────────────────────────────────────── */
interface LeadgenRun {
  id: number;
  status: string;
  leads_found: number | null;
  leads_kept: number | null;
  error: string | null;
  deduplicated?: boolean;
  started_at: string | null;
  finished_at: string | null;
}

interface Lead {
  id: number;
  place_id: string | null;
  company_name: string;
  country: string | null;
  region: string | null;
  city: string | null;
  email: string | null;
  website: string | null;
  phone: string | null;
  industry: string | null;
  google_rating: number | null;
  google_reviews: number | null;
  fit_score: number | null;
  fit_reasons: string[] | null;
  opening_line: string | null;
  outreach_status: string;
  inquiry_status: string;
  demand_index: number | null;
  blank_index: number | null;
  created_at: string;
  // 产品信息（Google Places 拿不到，来自爬官网 / CSV 导入）
  shop_type: string | null;
  product_name: string | null;
  product_name_cn: string | null;
  product_image_url: string | null;
  spec_raw: string | null;
  link_url: string | null;
  can_supply: boolean | null;
  supply_notes: string | null;
  crawl_status: string | null;
  crawled_at: string | null;
}

interface LeadDetail extends Lead {
  outreach_history: {
    id: number;
    status: string;
    error: string | null;
    sent_at: string | null;
  }[];
  inquiry_history: { id: number; status: string; created_at: string }[];
}

/* 状态 tone 单一来源：`@/lib/status-tones`（P1-D 三份重复映射合并）。
   本页只保留中文文案映射（STATUS_CN），不再自建 tone 表 / 自写 scoreTone。 */

/* 状态显示文案映射（仅改展示文本，不改枚举值与 tone） */
const CRAWL_STATUS_CN: Record<string, string> = {
  pending: "待爬取",
  success: "成功",
  failed: "失败",
  blocked: "被拦截",
  no_website: "无官网",
};
const OUTREACH_STATUS_CN: Record<string, string> = {
  none: "无",
  sent: "已发送",
  delivered: "已送达",
  opened: "已打开",
  replied: "已回复",
  bounced: "退信",
};
const INQUIRY_STATUS_CN: Record<string, string> = {
  new: "新询盘",
  following: "跟进中",
  won: "已成交",
  lost: "已丢单",
};
const RUN_STATUS_CN: Record<string, string> = {
  succeeded: "成功",
  failed: "失败",
  running: "运行中",
  pending: "待运行",
};

function supplyCell(v: boolean | null) {
  if (v === true) return <StatusBadge tone="success">是</StatusBadge>;
  if (v === false) return <StatusBadge tone="danger">否</StatusBadge>;
  return <span className="text-xs text-muted-foreground">—</span>;
}

/* ── page ──────────────────────────────────────────────────────────────── */
export default function LeadgenPage() {
  usePageView({ resource_id: "/leadgen" });
  const qc = useQueryClient();
  const [cfg, setCfg] = useState({
    region: "",
    industry: "",
    icp: "",
    quantity: 20,
    source: "demo",
  });
  const [validating, setValidating] = useState(false);
  const [validation, setValidation] = useState<{
    valid: boolean;
    issues: string[];
    path: string;
  } | null>(null);
  const [search, setSearch] = useState("");
  const [outreachFilter, setOutreachFilter] = useState("");
  const [inquiryFilter, setInquiryFilter] = useState("");
  const [sort, setSort] = useState("score");
  const [detail, setDetail] = useState<LeadDetail | null>(null);
  /** 正在加载详情的线索 id（用于行级 pending 与重试） */
  const [detailId, setDetailId] = useState<number | null>(null);
  /** U-P0B6/X2：详情改为右侧抽屉（列表不再被 200 行内联面板下推） */
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
   * P0-B4：「开始抓取」（批量抓取）原实现只有 try/finally + 重复 toast
   * （拦截器已统一 toast），且没有 pending 防重 ⇒ 连点会重复发起抓取。
   * 现在：useAsyncAction（pending 期间按钮禁用）+ 失败页内 role="alert"。
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

  /**
   * P0-B2/L4：「扫描已回复→询盘」原本无 pending，可重复提交（重复建询盘）。
   * 走 `useAsyncAction`：pending 期间按钮禁用；失败写页内错误（拦截器已 toast，不重复）。
   */
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

  /**
   * P0-B2/L3：「详情」按钮原本失败即死路（裸 `apiClient.get` 无 catch/无状态，
   * 用户只看到按钮没反应）。现在：pending 行级禁用 + 失败 ErrorState（含原因与重试）。
   */
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

  /**
   * P0-B4：「爬取网站 (10)」= 批量爬取 mutation（非单行爬取 crawlOne）。
   * 同样补 pending 防重 + 失败页内出口（拦截器已 toast，不重复）。
   */
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

  return (
    <RouteGuard>
      <PageHeader
        title="线索开发"
        description="抓取潜在客户，AI 打分后进入共享线索池"
      />
      <div className="space-y-6 p-6">
        {/* config */}
        <SectionCard title="抓取配置">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            <select
              className="rounded-md border bg-background px-3 py-2 text-sm"
              value={cfg.source}
              onChange={(e) => setCfg({ ...cfg, source: e.target.value })}
            >
              <option value="demo">演示数据源</option>
              <option value="csv">CSV 导入</option>
            </select>
            <select
              className="rounded-md border bg-background px-3 py-2 text-sm"
              value={cfg.region}
              onChange={(e) => setCfg({ ...cfg, region: e.target.value })}
            >
              <option value="">全部地区</option>
              {regions.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
            <Input
              placeholder="行业关键词"
              value={cfg.industry}
              onChange={(e) => setCfg({ ...cfg, industry: e.target.value })}
            />
            <Input
              placeholder="ICP 备注（可选）"
              value={cfg.icp}
              onChange={(e) => setCfg({ ...cfg, icp: e.target.value })}
            />
            <Input
              type="number"
              min={1}
              value={cfg.quantity}
              onChange={(e) => setNum(e.target.value)}
            />
          </div>
          <div className="mt-3 flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={validate}
              disabled={validating}
            >
              <ShieldCheck className="mr-1 h-4 w-4" /> 校验
            </Button>
            <AsyncButton
              size="sm"
              onClick={run}
              pending={runAction.pending}
              pendingLabel="运行中…"
            >
              <Play className="mr-1 h-4 w-4" /> 开始抓取
            </AsyncButton>
            <AsyncButton
              variant="outline"
              size="sm"
              onClick={() => void scan.run()}
              pending={scan.pending}
              pendingLabel={
                <>
                  <RefreshCw className="mr-1 h-4 w-4" /> 扫描中…
                </>
              }
            >
              <RefreshCw className="mr-1 h-4 w-4" /> 扫描已回复 → 询盘
            </AsyncButton>
            <AsyncButton
              variant="outline"
              size="sm"
              onClick={() => void crawlBatch.run()}
              pending={crawlBatch.pending}
              pendingLabel={
                <>
                  <Globe className="mr-1 h-4 w-4" /> 爬取中…
                </>
              }
              disabled={crawling !== null}
            >
              <Globe className="mr-1 h-4 w-4" /> 爬取网站 (10)
            </AsyncButton>
            {validation && (
              <div className="flex items-center gap-2 text-sm">
                {validation.valid ? (
                  <Badge className="bg-success-muted text-success-muted-foreground">
                    配置正常
                  </Badge>
                ) : (
                  <Badge className="bg-destructive/10 text-destructive">
                    {validation.issues.length} 个问题：
                    {validation.issues.join("; ")}
                  </Badge>
                )}
              </div>
            )}
          </div>
          {/* P0-B4：开始抓取 / 批量爬取失败都有页内出口（拦截器已 toast，不重复） */}
          {runAction.error ? (
            <p
              role="alert"
              className="mt-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
            >
              抓取失败：{runAction.error}（可修正配置后重试）
            </p>
          ) : null}
          {crawlBatch.error ? (
            <p
              role="alert"
              className="mt-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
            >
              批量爬取失败：{crawlBatch.error}（可重试）
            </p>
          ) : null}
          {/* P0-B2/L4：扫描失败要有出口（拦截器已 toast，这里保留原因便于重试） */}
          {scan.error ? (
            <p
              role="alert"
              className="mt-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
            >
              扫描失败：{scan.error}（可重试）
            </p>
          ) : null}
          <p className="mt-2 text-xs text-muted-foreground">
            CSV 文件可直接导入线索；地图搜索等更多数据源正在规划中。
          </p>
          {cfg.source === "csv" && (
            <LeadgenCsvImport onImported={() => void refetchRuns()} />
          )}
        </SectionCard>

        {/* runs history */}
        <SectionCard title="运行历史">
          {(runsData?.items ?? []).length === 0 ? (
            <EmptyState title="暂无运行记录" />
          ) : (
            <div className="space-y-1 text-sm">
              {(runsData?.items ?? []).slice(0, 10).map((r) => (
                <div
                  key={r.id}
                  className="flex items-center gap-3 rounded border px-3 py-2"
                >
                  <StatusBadge tone={toneForStatus(RUN_STATUS_TONES, r.status)}>
                    {RUN_STATUS_CN[r.status] ?? r.status}
                  </StatusBadge>
                  <span className="text-muted-foreground">#{r.id}</span>
                  <span>找到 {r.leads_found ?? "-"}</span>
                  <span>保留 {r.leads_kept ?? "-"}</span>
                  {r.deduplicated && <Badge variant="outline">已去重</Badge>}
                  <span className="ml-auto text-xs text-muted-foreground">
                    {r.started_at?.slice(0, 19) ?? ""}
                  </span>
                </div>
              ))}
            </div>
          )}
        </SectionCard>

        {/* lead pool */}
        <SectionCard title={`线索池 (${leadsQuery.data?.total ?? 0})`}>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Input
              className="w-56"
              placeholder="搜索公司 / 城市…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <select
              className="rounded-md border bg-background px-3 py-2 text-sm"
              value={outreachFilter}
              onChange={(e) => setOutreachFilter(e.target.value)}
            >
              <option value="">触达：全部</option>
              {[
                "none",
                "sent",
                "delivered",
                "opened",
                "replied",
                "bounced",
              ].map((s) => (
                <option key={s} value={s}>
                  {OUTREACH_STATUS_CN[s] ?? s}
                </option>
              ))}
            </select>
            <select
              className="rounded-md border bg-background px-3 py-2 text-sm"
              value={inquiryFilter}
              onChange={(e) => setInquiryFilter(e.target.value)}
            >
              <option value="">询盘：全部</option>
              {["new", "following", "won", "lost"].map((s) => (
                <option key={s} value={s}>
                  {INQUIRY_STATUS_CN[s] ?? s}
                </option>
              ))}
            </select>
            <select
              className="rounded-md border bg-background px-3 py-2 text-sm"
              value={sort}
              onChange={(e) => setSort(e.target.value)}
            >
              <option value="score">排序：匹配分</option>
              <option value="recent">排序：最近</option>
              <option value="name">排序：名称</option>
            </select>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setManualLeadOpen(true)}
            >
              新建线索
            </Button>
          </div>

          {leads.length === 0 ? (
            <EmptyState
              title="暂无线索"
              description="先运行一次抓取来填充线索池"
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th scope="col" className="p-2">
                      图片
                    </th>
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
                      产品（本地 / 中文）
                    </th>
                    <th scope="col" className="p-2">
                      规格
                    </th>
                    <th scope="col" className="p-2">
                      爬取
                    </th>
                    <th scope="col" className="p-2">
                      可供货
                    </th>
                    <th scope="col" className="p-2">
                      评分
                    </th>
                    <th scope="col" className="p-2">
                      触达
                    </th>
                    <th scope="col" className="p-2" />
                  </tr>
                </thead>
                <tbody>
                  {leads.map((l) => (
                    <tr key={l.id} className="border-b hover:bg-muted/40">
                      <td className="p-2">
                        {l.product_image_url ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={l.product_image_url}
                            alt={l.product_name ?? "产品"}
                            className="h-10 w-10 rounded object-cover"
                            loading="lazy"
                          />
                        ) : (
                          <div className="flex h-10 w-10 items-center justify-center rounded bg-secondary">
                            <ImageOff className="h-3.5 w-3.5 text-muted-foreground" />
                          </div>
                        )}
                      </td>
                      <td className="p-2">
                        <div className="font-medium">{l.company_name}</div>
                        <div className="text-xs text-muted-foreground">
                          {l.email ?? "—"}
                        </div>
                      </td>
                      <td className="p-2 text-xs">
                        {[l.city, l.region, l.country]
                          .filter(Boolean)
                          .join(", ") || "—"}
                      </td>
                      <td className="p-2 text-xs">
                        {l.shop_type ?? l.industry ?? "—"}
                      </td>
                      <td className="p-2 text-xs">
                        <div>{l.product_name ?? "—"}</div>
                        <div className="text-muted-foreground">
                          {l.product_name_cn ?? ""}
                        </div>
                      </td>
                      <td className="p-2 max-w-[180px] truncate text-xs text-muted-foreground">
                        {l.spec_raw ?? "—"}
                      </td>
                      <td className="p-2">
                        <div className="flex items-center gap-1">
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
                          {(l.crawl_status === "pending" ||
                            l.crawl_status === "failed") &&
                            l.website && (
                              <Button
                                variant="ghost"
                                size="sm"
                                title="爬取官网获取产品信息"
                                disabled={crawling !== null}
                                onClick={() => crawlOne(l.id)}
                              >
                                <Globe className="h-4 w-4" />
                              </Button>
                            )}
                        </div>
                      </td>
                      <td className="p-2">{supplyCell(l.can_supply)}</td>
                      <td className="p-2">
                        <StatusBadge tone={scoreTone(l.fit_score)}>
                          {l.fit_score ?? "—"}
                        </StatusBadge>
                      </td>
                      <td className="p-2">
                        <StatusBadge
                          tone={toneForStatus(
                            OUTREACH_STATUS_TONES,
                            l.outreach_status,
                          )}
                        >
                          {OUTREACH_STATUS_CN[l.outreach_status] ??
                            l.outreach_status}
                        </StatusBadge>
                      </td>
                      <td className="p-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={(e) => openDetail(l.id, e.currentTarget)}
                          disabled={detailAction.pending && detailId === l.id}
                        >
                          {detailAction.pending && detailId === l.id
                            ? "加载中…"
                            : "详情"}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/*
            U-P0B6/X2：线索详情从「列表下方 200 行内联面板」改为右侧 DetailDrawer。
            · 列表不再被详情整体下推；
            · 加载/失败复用 useAsyncAction（LoadingBlock / ErrorState + 重试）；
            · 关闭后焦点归还触发它的「详情」按钮。
          */}
          <DetailDrawer
            open={detailOpen}
            onOpenChange={(open) => {
              if (!open) closeDetail();
            }}
            title={detail?.company_name ?? "线索详情"}
            description={
              detail
                ? `${detail.country ?? "—"}${detail.city ? ` · ${detail.city}` : ""} · 线索 #${detail.id}`
                : "正在加载…"
            }
            footer={
              <Button variant="outline" size="sm" onClick={closeDetail}>
                关闭
              </Button>
            }
          >
            {detailAction.pending && !detail ? <LoadingBlock rows={5} /> : null}
            {detailAction.error ? (
              <ErrorState
                title="线索详情加载失败"
                message={detailAction.error}
                onRetry={retryDetail}
              />
            ) : null}
            {detail && (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm md:grid-cols-3">
                  <div>
                    <span className="text-muted-foreground">官网：</span>{" "}
                    {detail.website ? (
                      <a
                        className="text-blue-600 underline"
                        href={detail.website}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {detail.website}
                      </a>
                    ) : (
                      "—"
                    )}
                  </div>
                  <div>
                    <span className="text-muted-foreground">电话：</span>{" "}
                    {detail.phone ?? "—"}
                  </div>
                  <div>
                    <span className="text-muted-foreground">店铺类型：</span>{" "}
                    {detail.shop_type ?? detail.industry ?? "—"}
                  </div>
                  <div>
                    <span className="text-muted-foreground">Google 评分：</span>{" "}
                    {detail.google_rating ?? "—"} (共{" "}
                    {detail.google_reviews ?? 0} 条评价)
                  </div>
                  <div>
                    <span className="text-muted-foreground">匹配理由：</span>{" "}
                    {(detail.fit_reasons ?? []).join(", ") || "—"}
                  </div>
                </div>

                {/* 产品信息（爬官网）：Google Places 拿不到产品 */}
                <div className="mt-4 rounded-md border p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <h4 className="text-sm font-semibold">
                      产品信息（来自官网爬取）
                    </h4>
                    <div className="flex items-center gap-2">
                      <StatusBadge
                        tone={toneForStatus(
                          CRAWL_STATUS_TONES,
                          detail.crawl_status,
                        )}
                      >
                        {CRAWL_STATUS_CN[detail.crawl_status ?? "pending"] ??
                          detail.crawl_status ??
                          "pending"}
                      </StatusBadge>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={crawling !== null}
                        onClick={() => crawlOne(detail.id)}
                      >
                        <Globe className="mr-1 h-4 w-4" /> 爬取
                      </Button>
                    </div>
                  </div>
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
                    <div>
                      {detail.product_image_url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={detail.product_image_url}
                          alt={detail.product_name ?? "product"}
                          className="h-28 w-28 rounded object-cover"
                        />
                      ) : (
                        <div className="flex h-28 w-28 items-center justify-center rounded bg-secondary">
                          <ImageOff className="h-5 w-5 text-muted-foreground" />
                        </div>
                      )}
                    </div>
                    <div className="md:col-span-3 space-y-1 text-sm">
                      <div>
                        <span className="text-muted-foreground">
                          本地名称：
                        </span>{" "}
                        {detail.product_name ?? "—"}
                      </div>
                      <div>
                        <span className="text-muted-foreground">
                          中文名称：
                        </span>{" "}
                        {detail.product_name_cn ?? "—"}
                      </div>
                      <div>
                        <span className="text-muted-foreground">规格：</span>{" "}
                        {detail.spec_raw ?? "—"}
                      </div>
                      <div>
                        <span className="text-muted-foreground">链接：</span>{" "}
                        {detail.link_url ? (
                          <a
                            className="text-blue-600 underline"
                            href={detail.link_url}
                            target="_blank"
                            rel="noreferrer"
                          >
                            打开
                          </a>
                        ) : (
                          "—"
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-muted-foreground">
                          可供货（由你判定）：
                        </span>
                        <Button
                          variant={
                            detail.can_supply === true ? "default" : "outline"
                          }
                          size="sm"
                          onClick={() => setSupply(detail.id, true)}
                        >
                          <CheckCircle2 className="mr-1 h-3.5 w-3.5" /> 是
                        </Button>
                        <Button
                          variant={
                            detail.can_supply === false ? "default" : "outline"
                          }
                          size="sm"
                          onClick={() => setSupply(detail.id, false)}
                        >
                          <XCircle className="mr-1 h-3.5 w-3.5" /> 否
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setSupply(detail.id, null)}
                        >
                          清除
                        </Button>
                      </div>
                    </div>
                  </div>
                </div>
                {detail.opening_line && (
                  <div className="mt-3 rounded bg-muted p-2 text-sm italic">
                    “{detail.opening_line}”
                  </div>
                )}
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  <div>
                    <div className="mb-1 text-xs font-medium text-muted-foreground">
                      触达历史（只读，由触达工位维护）
                    </div>
                    {detail.outreach_history.length === 0 ? (
                      <div className="text-xs text-muted-foreground">无</div>
                    ) : (
                      detail.outreach_history.map((m) => (
                        <div key={m.id} className="flex gap-2 text-xs">
                          <StatusBadge
                            tone={toneForStatus(
                              OUTREACH_STATUS_TONES,
                              m.status,
                            )}
                          >
                            {OUTREACH_STATUS_CN[m.status] ?? m.status}
                          </StatusBadge>
                          <span className="text-muted-foreground">
                            {m.sent_at?.slice(0, 19) ?? ""}
                          </span>
                          {m.error && (
                            <span className="text-destructive">{m.error}</span>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                  <div>
                    <div className="mb-1 text-xs font-medium text-muted-foreground">
                      询盘历史（只读，由询盘工位维护）
                    </div>
                    {detail.inquiry_history.length === 0 ? (
                      <div className="text-xs text-muted-foreground">无</div>
                    ) : (
                      detail.inquiry_history.map((i) => (
                        <div key={i.id} className="flex gap-2 text-xs">
                          <StatusBadge
                            tone={toneForStatus(INQUIRY_STATUS_TONES, i.status)}
                          >
                            {INQUIRY_STATUS_CN[i.status] ?? i.status}
                          </StatusBadge>
                          <span className="text-muted-foreground">
                            询盘 #{i.id} · {i.created_at.slice(0, 19)}
                          </span>
                        </div>
                      ))
                    )}
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  线索池里的评分与联系方式可在此页维护；触达与询盘状态由对应工位自动回写。
                </p>
              </div>
            )}
          </DetailDrawer>
        </SectionCard>
        <ManualLeadDialog
          open={manualLeadOpen}
          onOpenChange={setManualLeadOpen}
        />
      </div>
    </RouteGuard>
  );
}
