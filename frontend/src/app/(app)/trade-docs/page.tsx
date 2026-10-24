"use client";

/**
 * 单证工位 —— 外贸出口全套单据的开具、预览、打印与导出台账。
 *
 * 业务动作（按一票真实出口的节奏）
 * -------------------------------
 *   ① 开单：选类型 + 选上游（订单/报价单）→ 自动继承货物、金额与贸易条款
 *   ② 校对：预览英文单据，系统点出还差哪些必填（缺 HS Code / 收货人地址会清关卡住）
 *   ③ 签发：draft → issued（签发后彻底冻结，上游再改也不影响这张单据）
 *   ④ 交付：打印 / 导出 PDF / 批量合并打印（一票货的发票+装箱单+提单一起打）
 *   ⑤ 留档：台账导出 CSV / Excel
 *
 * 一致性策略：开单时把上游内容**冻结成快照**。draft 阶段可「从上游重新带入」；
 * issued 之后任何上游变更都不再影响已签发单据（它是法律凭证）。
 */
import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Download,
  FileSpreadsheet,
  FileText,
  Layers,
  Printer,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { toast } from "sonner";

import { DocTypeLabel, docTypeMeta } from "@/components/doc-chip";
import { CopyButton } from "@/components/shared/copy-button";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge } from "@/components/shared/status-badge";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { NumberEditDialog } from "@/components/shared/number-edit-dialog";
import { PaginationBar } from "@/components/shared/pagination-bar";
import { Button } from "@/components/ui/button";
import { usePageView } from "@/lib/events/use-page-view";
import { usePersistentState } from "@/lib/hooks/use-persistent-state";
import { cn } from "@/lib/utils";
import { renderTradeDoc } from "@/lib/trade-doc/render";
import {
  parseConfirmBlocked,
  type ConfirmBlocked,
} from "@/lib/trade-doc/hardening";
import { autoArchiveIssuedDoc } from "@/lib/trade-doc/auto-archive";
import { exportCsv, exportExcel, printMerged } from "@/lib/trade-doc/export";

import { DocCreateForm } from "./components/doc-create-form";
import { DocConfirmGate } from "./components/doc-confirm-gate";
import { DocContentVersions } from "./components/doc-content-versions";
import { DocCustomForm } from "./components/doc-custom-form";
import { DocItemsBatchEditor } from "./components/doc-items-batch-editor";
import {
  buildItemsOverridePayload,
  readItemsOverride,
  type ItemsOverrideEntry,
} from "@/lib/trade-doc/item-batch";
import {
  DocHardeningSection,
  type HardeningTab,
} from "./components/doc-hardening-section";
import { DocRenderCheckBadge } from "./components/doc-render-check-badge";
import { DocStampReturn } from "./components/doc-stamp-return";
import { DocVoidButton } from "./components/doc-void-button";
import { DocPreview, renderMetaOf } from "./components/doc-preview";
import { SamplePreviewEntry } from "./components/sample-preview-entry";
import { DOC_TYPE_GROUPS } from "./lib/doc-type-groups";
import {
  TRADE_DOCS_PAGE_SIZE,
  fetchAllTradeDocs,
  useRefreshSources,
  useTradeDocRenderData,
  useUpdateTradeDoc,
  type PdfArchiveResult,
  type TradeDocRow,
} from "./hooks/use-trade-docs";
import { useTradeDocsLedger } from "./hooks/use-trade-docs-ledger";

const STATUS_TONE: Record<
  string,
  "default" | "success" | "warning" | "danger" | "info"
> = {
  draft: "warning",
  issued: "success",
  void: "danger",
};

const STATUS_LABEL: Record<string, string> = {
  draft: "草稿",
  issued: "已签发",
  void: "已作废",
};

const DOC_COLUMNS = [
  { key: "doc_no", label: "单证编号" },
  { key: "type", label: "类型" },
  { key: "status", label: "状态" },
  { key: "amount", label: "金额" },
  { key: "upstream", label: "上游" },
] as const;
type DocColumnKey = (typeof DOC_COLUMNS)[number]["key"];

/**
 * 类型筛选项 —— 顺序取自 `DOC_TYPE_GROUPS`（报价单排在第一位：它是业务链的第一张单据），
 * 中文名与图标取自 `components/doc-chip.tsx` 的元数据表。
 * 类型筛选、台账标签、客户往来记录树三处**必须**用同一份元数据，否则又会出现
 * "树里叫报价单、台账里叫 quotation"这种同一事物两个名字的问题。
 */
const DOC_TYPE_FILTER_OPTIONS = DOC_TYPE_GROUPS.flatMap((group) =>
  group.types.map((type) => ({ value: type, label: docTypeMeta(type).label })),
);

function money(amount: number | null, currency: string) {
  if (amount === null || amount === undefined) return "—";
  return `${currency} ${amount.toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
}

export default function TradeDocsPage() {
  usePageView({ resource_id: "/trade-docs" });

  // 台账筛选/分页：筛选进 URL（doc_type/status），页码本地；
  // 切筛选自动回第 1 页（见 use-trade-docs-ledger.ts）
  const {
    docType: docTypeFilter,
    status: statusFilter,
    setDocType: setDocTypeFilter,
    setStatus: setStatusFilter,
    page: ledgerPage,
    setPage: setLedgerPage,
    list,
    rows,
    total: ledgerTotal,
  } = useTradeDocsLedger();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [docNoEdit, setDocNoEdit] = useState<TradeDocRow | null>(null);
  const [docNoError, setDocNoError] = useState<string | null>(null);
  // A7 加固：签发被事实层闸门拦下时的阻断清单（不是 toast —— 要能逐条看、能跳去确认）
  const [confirmBlocked, setConfirmBlocked] = useState<ConfirmBlocked | null>(
    null,
  );
  const [hardeningTab, setHardeningTab] = useState<HardeningTab>("facts");
  const [density, setDensity] = usePersistentState<"cozy" | "compact">(
    "ui:trade-docs:density",
    "cozy",
  );
  const [visibleCols, setVisibleCols] = usePersistentState<DocColumnKey[]>(
    "ui:trade-docs:columns",
    DOC_COLUMNS.map((c) => c.key),
  );

  // 深链预览：客户详情「询盘 → 后续单证」点击后带 ?doc=<id> 打开本页并直接选中该单证。
  // 不用 useSearchParams：静态导出下它需要 Suspense 边界（与 quotes 页同一口径）。
  useEffect(() => {
    if (typeof window === "undefined") return;
    const raw = new URLSearchParams(window.location.search).get("doc");
    const id = raw ? Number(raw) : NaN;
    if (Number.isFinite(id) && id > 0) setSelectedId(id);
  }, []);

  const renderData = useTradeDocRenderData(selectedId);
  const update = useUpdateTradeDoc();
  const refresh = useRefreshSources();

  // 换单证时清掉上一张的阻断清单：在选中事件里清（见列表「预览」按钮），
  // 不用 useEffect —— effect 里 setState 会触发 react-hooks/set-state-in-effect
  // 告警、且多跑一轮渲染。

  const saveDocNo = async (value: string) => {
    if (!docNoEdit) return;
    setDocNoError(null);
    try {
      await update.mutateAsync({ id: docNoEdit.id, doc_no: value });
      setDocNoEdit(null);
    } catch (e) {
      const msg =
        (e as { response?: { data?: { detail?: { detail?: string } } } })
          ?.response?.data?.detail?.detail ?? "修改失败，请重试";
      setDocNoError(msg);
    }
  };

  /** 导出时的筛选（与列表相同；导出取**全部筛选结果**，不是当前页） */
  const exportFilters = {
    doc_type: docTypeFilter || undefined,
    status: statusFilter || undefined,
  };

  /** 台账导出列（与页面展示保持一致，避免"看到的"和"导出的"不一致） */
  const exportColumns = useMemo(
    () => [
      { header: "单证编号", value: (r: TradeDocRow) => r.doc_no, width: 22 },
      {
        header: "单证类型",
        // 导出用中文名，与页面上看到的一致（报价单 / 形式发票 / …）
        value: (r: TradeDocRow) => docTypeMeta(r.doc_type).label,
        width: 20,
      },
      {
        header: "状态",
        value: (r: TradeDocRow) => STATUS_LABEL[r.status] ?? r.status,
        width: 10,
      },
      { header: "币种", value: (r: TradeDocRow) => r.currency, width: 8 },
      {
        header: "金额",
        value: (r: TradeDocRow) => r.total_amount ?? "",
        width: 16,
      },
      {
        header: "上游订单号",
        value: (r: TradeDocRow) =>
          r.raw_payload?.sources?.order?.order_no ?? "",
        width: 20,
      },
      {
        header: "上游报价号",
        value: (r: TradeDocRow) =>
          r.raw_payload?.sources?.quote?.quote_no ?? "",
        width: 20,
      },
      {
        header: "签发时间",
        value: (r: TradeDocRow) => r.issued_at ?? "",
        width: 22,
      },
      {
        header: "创建时间",
        value: (r: TradeDocRow) => r.created_at ?? "",
        width: 22,
      },
    ],
    [],
  );

  const toggleCheck = (id: number) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  /** 批量合并打印：一票货的多份单据一次打完，每份之间自动分页 */
  const batchPrint = async () => {
    if (checked.size === 0) return toast.error("请先勾选要打印的单据");
    toast.info(`正在准备 ${checked.size} 份单据…`);
    try {
      // 逐份取渲染数据（渲染在前端完成，后端只给数据）
      const ids = [...checked];
      const htmls: string[] = [];
      for (const id of ids) {
        const { default: apiClient } = await import("@/lib/api/client");
        const { data } = await apiClient.get<{
          doc: TradeDocRow;
          data: Record<string, unknown>;
        }>(`/trade-docs/${id}/render-data`);
        htmls.push(renderTradeDoc(data.doc.doc_type, data.data));
      }
      printMerged(htmls);
    } catch {
      toast.error("准备打印失败，请重试");
    }
  };

  /**
   * 签发：draft → issued（法律凭证，签发后冻结）。
   * 「作废（issued → void）」是破坏性动作，统一走 `DocVoidButton`（二次确认 + 防重）。
   */
  const issueDoc = (row: TradeDocRow) => {
    // 签发即上传（TODO(TODO:F1) 方案 A）：把**预览用的同一份 HTML** 随 PATCH 一起提交，
    // 服务端出 PDF 并归档为 render_pdf —— 不再依赖"签发完成后再由前端单独上传"。
    // 失败不回滚签发：后端在响应里带 pdf_archive{ok:false}，这里如实提示并保留
    // 手动上传兜底（渲染器未配置时自动归档接口同样会 503，不假装成功）。
    void (async () => {
      try {
        const { default: apiClient } = await import("@/lib/api/client");
        const { data } = await apiClient.get<{
          doc: TradeDocRow;
          data: Record<string, unknown>;
        }>(`/trade-docs/${row.id}/render-data`);
        const html = renderTradeDoc(data.doc.doc_type, data.data);
        update.mutate(
          { id: row.id, status: "issued", html, pdf_name: row.doc_no },
          {
            onSuccess: (doc) => {
              setConfirmBlocked(null);
              const archived = (doc as { pdf_archive?: PdfArchiveResult })
                .pdf_archive;
              if (archived?.ok) {
                toast.success("已签发，单证 PDF 已自动归档");
                return;
              }
              toast.error("已签发，但 PDF 自动归档失败（手动上传入口仍可用）");
              // 兼容旧后端（不认识 html）：仍走一次前端归档接口；同样失败就只保留提示
              void autoArchiveIssuedDoc(row.id).then((result) => {
                if (result.ok) toast.success(result.message);
              });
            },
            onError: (error) => {
              // A7：签发闸门返回 422 + `detail.blocking` ⇒ 展开阻断清单，
              // **不**只弹一句"签发失败"（否则用户不知道去确认哪项事实）
              const blocked = parseConfirmBlocked(error);
              if (blocked) {
                setConfirmBlocked(blocked);
                return;
              }
              toast.error("签发失败，请重试");
            },
          },
        );
      } catch {
        toast.error("准备签发失败，请重试");
      }
    })();
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="单证"
        description="外贸出口全套单据：开单 → 校对 → 签发 → 打印/导出。单据自动继承上游订单的货物与贸易条款。"
      />

      {/*
        页面层级（2026-10-24，问题 6）：开单是**一等公民** —— 紧跟页头、第一屏可见；
        样板预览不常用，收成一行入口（默认收起，点开才是对话框），不再占顶部大块空间。
      */}
      <SectionCard
        title="开单（第一步）"
        description="先开单：选单证类型 + 上游，货物、金额与贸易条款会自动带入；开单前可用「成品预览」检查版式。"
        className="border-primary/40"
      >
        <DocCreateForm onCreated={(id) => setSelectedId(id)} />
      </SectionCard>

      <SamplePreviewEntry />

      <SectionCard
        title="单证台账"
        action={
          <div className="flex flex-wrap items-center gap-2">
            <details className="relative">
              <summary className="cursor-pointer list-none rounded-md border px-2 py-1.5 text-xs hover:bg-muted">
                列配置
              </summary>
              <div className="absolute right-0 z-20 mt-1 w-40 rounded-lg border bg-white p-2 shadow-lg">
                {DOC_COLUMNS.map((c) => (
                  <label
                    key={c.key}
                    className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs hover:bg-muted"
                  >
                    <input
                      type="checkbox"
                      checked={visibleCols.includes(c.key)}
                      onChange={() => {
                        const next = visibleCols.includes(c.key)
                          ? visibleCols.filter((k) => k !== c.key)
                          : [...visibleCols, c.key];
                        if (next.length > 0) setVisibleCols(next);
                      }}
                    />
                    {c.label}
                  </label>
                ))}
              </div>
            </details>
            <div
              className="flex items-center gap-1"
              role="group"
              aria-label="表格密度"
            >
              <Button
                size="sm"
                variant={density === "cozy" ? "secondary" : "ghost"}
                onClick={() => setDensity("cozy")}
                aria-pressed={density === "cozy"}
              >
                舒适
              </Button>
              <Button
                size="sm"
                variant={density === "compact" ? "secondary" : "ghost"}
                onClick={() => setDensity("compact")}
                aria-pressed={density === "compact"}
              >
                紧凑
              </Button>
            </div>
            <select
              className="h-9 rounded-md border border-input bg-background px-2 text-sm"
              value={docTypeFilter}
              onChange={(e) => setDocTypeFilter(e.target.value)}
              aria-label="按单证类型筛选"
            >
              <option value="">全部类型</option>
              {DOC_TYPE_FILTER_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <select
              className="h-9 rounded-md border border-input bg-background px-2 text-sm"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
            >
              <option value="">全部状态</option>
              <option value="draft">草稿</option>
              <option value="issued">已签发</option>
              <option value="void">已作废</option>
            </select>
            <Button size="sm" variant="outline" onClick={batchPrint}>
              <Layers className="mr-1 h-4 w-4" />
              合并打印{checked.size > 0 ? `（${checked.size}）` : ""}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                void (async () => {
                  try {
                    const all = await fetchAllTradeDocs(exportFilters);
                    exportCsv("单证台账.csv", all, exportColumns);
                    toast.success(`CSV 已导出（${all.length} 条）`);
                  } catch {
                    toast.error("导出 CSV 失败，请重试");
                  }
                })();
              }}
              disabled={rows.length === 0}
            >
              <Download className="mr-1 h-4 w-4" />
              导出 CSV
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={rows.length === 0}
              onClick={async () => {
                try {
                  // 分页后不能再导当前页：先取全部筛选结果（否则台账会悄悄缺行）
                  const all = await fetchAllTradeDocs(exportFilters);
                  await exportExcel(
                    "单证台账.xlsx",
                    "单证台账",
                    all,
                    exportColumns,
                  );
                  toast.success(`Excel 已导出（${all.length} 条）`);
                } catch {
                  toast.error("导出 Excel 失败");
                }
              }}
            >
              <FileSpreadsheet className="mr-1 h-4 w-4" />
              导出 Excel
            </Button>
          </div>
        }
      >
        {list.isLoading ? (
          <div
            className="space-y-2"
            aria-busy="true"
            aria-label="单证台账加载中"
          >
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full rounded-md" />
            ))}
          </div>
        ) : list.isError ? (
          <div className="space-y-1 py-8 text-sm">
            <div className="flex items-center gap-2 text-destructive">
              <AlertCircle className="h-4 w-4" />
              读取单证台账失败：暂时连不上数据服务。
            </div>
            <p className="text-muted-foreground">
              台账数据需要连上服务后才能显示。想先看单据长什么样、校对版式，
              请用上方的「样板预览」—— 它不需要真实单据。
            </p>
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={FileText}
            title="还没有单证"
            description="先在上面开一张单，单据会自动带上订单里的货物与贸易条款。"
          />
        ) : (
          <>
            <div
              className={cn(
                "hidden overflow-x-auto md:block",
                density === "compact" &&
                  "[&_td]:py-1 [&_th]:h-8 [&_tr]:text-xs",
              )}
            >
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th scope="col" className="w-8 p-2">
                      <span className="sr-only">选择</span>
                    </th>
                    {DOC_COLUMNS.filter((c) => visibleCols.includes(c.key)).map(
                      (c) => (
                        <th key={c.key} scope="col" className="p-2">
                          {c.label}
                        </th>
                      ),
                    )}
                    <th scope="col" className="p-2">
                      操作
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr
                      key={row.id}
                      className="border-b last:border-0 hover:bg-muted/40"
                    >
                      <td className="p-2">
                        <input
                          type="checkbox"
                          checked={checked.has(row.id)}
                          onChange={() => toggleCheck(row.id)}
                          aria-label={`选择 ${row.doc_no}`}
                        />
                      </td>
                      {visibleCols.includes("doc_no") && (
                        <td className="p-2 font-medium">
                          <span className="inline-flex items-center gap-1">
                            {row.doc_no}
                            <CopyButton
                              value={row.doc_no}
                              label="复制单证编号"
                            />
                          </span>
                        </td>
                      )}
                      {visibleCols.includes("type") && (
                        <td className="p-2">
                          <DocTypeLabel docType={row.doc_type} />
                        </td>
                      )}
                      {visibleCols.includes("status") && (
                        <td className="p-2">
                          <div className="flex flex-wrap items-center gap-1">
                            <StatusBadge
                              tone={STATUS_TONE[row.status] ?? "default"}
                            >
                              {STATUS_LABEL[row.status] ?? row.status}
                            </StatusBadge>
                            {/* 定时对账标识（A8/A9）：只在"被改过/模板漂移/待复核"时出现 */}
                            <DocRenderCheckBadge check={row.render_check} />
                          </div>
                        </td>
                      )}
                      {visibleCols.includes("amount") && (
                        <td className="p-2">
                          {money(row.total_amount, row.currency)}
                        </td>
                      )}
                      {visibleCols.includes("upstream") && (
                        <td className="p-2 text-muted-foreground">
                          {row.raw_payload?.sources?.order?.order_no ??
                            row.raw_payload?.sources?.quote?.quote_no ??
                            "—"}
                        </td>
                      )}
                      <td className="p-2">
                        <div className="flex flex-wrap gap-1">
                          {row.doc_no_editable !== false && (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => {
                                setDocNoError(null);
                                setDocNoEdit(row);
                              }}
                            >
                              改编号
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              // 换一张单证就清掉上一张的阻断清单（否则 A 单的阻断会挂在 B 单下面；
                              // 用事件里清而不是 useEffect —— effect 里 setState 会触发
                              // react-hooks/set-state-in-effect 告警且多一轮渲染）
                              setConfirmBlocked(null);
                              setSelectedId(row.id);
                            }}
                          >
                            预览
                          </Button>
                          {row.status === "draft" && (
                            <>
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={refresh.isPending}
                                onClick={() =>
                                  refresh.mutate(row.id, {
                                    onSuccess: () =>
                                      toast.success("已从上游重新带入"),
                                  })
                                }
                              >
                                <RefreshCw className="mr-1 h-3.5 w-3.5" />
                                重新带入
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => issueDoc(row)}
                              >
                                <ShieldCheck className="mr-1 h-3.5 w-3.5" />
                                签发
                              </Button>
                            </>
                          )}
                          {/* P0-B1/T1：作废已签发单证不可恢复 ⇒ 二次确认 + 防重 */}
                          {row.status === "issued" && (
                            <DocVoidButton doc={row} />
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* T3：台账分页（原来写死 page_size=100、total 取了不用 ⇒ 100 条之后看不到） */}
            <PaginationBar
              page={ledgerPage}
              pageSize={list.data?.page_size ?? TRADE_DOCS_PAGE_SIZE}
              total={ledgerTotal}
              currentCount={rows.length}
              loading={list.isFetching}
              onPageChange={setLedgerPage}
              ariaLabel="单证台账分页"
            />

            {/* 窄屏卡片：DOM 在表格之后，避免隐藏节点干扰文本定位 */}
            <div className="divide-y divide-border/60 md:hidden">
              {rows.map((row) => (
                <div key={row.id} className="flex items-start gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1">
                      <span className="truncate font-medium">{row.doc_no}</span>
                      <CopyButton value={row.doc_no} label="复制单证编号" />
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <DocTypeLabel docType={row.doc_type} />
                      <StatusBadge tone={STATUS_TONE[row.status] ?? "default"}>
                        {STATUS_LABEL[row.status] ?? row.status}
                      </StatusBadge>
                      {/* 定时对账标识（A8/A9） */}
                      <DocRenderCheckBadge check={row.render_check} />
                    </div>
                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                      <span>{money(row.total_amount, row.currency)}</span>
                      <span className="truncate">
                        {row.raw_payload?.sources?.order?.order_no ??
                          row.raw_payload?.sources?.quote?.quote_no ??
                          "—"}
                      </span>
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      // 换一张单证就清掉上一张的阻断清单（否则 A 单的阻断会挂在 B 单下面；
                      // 用事件里清而不是 useEffect —— effect 里 setState 会触发
                      // react-hooks/set-state-in-effect 告警且多一轮渲染）
                      setConfirmBlocked(null);
                      setSelectedId(row.id);
                    }}
                  >
                    预览
                  </Button>
                </div>
              ))}
            </div>
          </>
        )}
      </SectionCard>

      {selectedId !== null && (
        <SectionCard
          title={`单据预览 · ${renderData.data?.doc.doc_no ?? ""}`}
          description="打印与「导出 PDF」都走浏览器打印，版面与屏幕上看到的一致。"
          action={
            <div className="flex gap-2">
              {renderData.data?.doc.status === "draft" && (
                <Button
                  size="sm"
                  onClick={() => issueDoc(renderData.data!.doc)}
                  disabled={update.isPending}
                >
                  <ShieldCheck className="mr-1 h-4 w-4" />
                  签发
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                onClick={() => setSelectedId(null)}
              >
                关闭
              </Button>
            </div>
          }
        >
          {renderData.isLoading ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              正在装配单据数据…
            </p>
          ) : renderData.isError ? (
            <div className="flex items-center gap-2 py-8 text-sm text-destructive">
              <AlertCircle className="h-4 w-4" />
              读取单据数据失败。
            </div>
          ) : renderData.data ? (
            <>
              {renderData.data.doc.status === "issued" && (
                <p className="mb-3 flex items-center gap-1 text-sm text-muted-foreground">
                  <Printer className="h-4 w-4" />
                  该单据已签发并冻结，上游订单再变动也不会改变这张单据的内容。
                </p>
              )}
              <DocCustomForm
                docId={renderData.data.doc.id}
                docType={renderData.data.doc.doc_type}
                status={renderData.data.doc.status}
                payload={renderData.data.doc.raw_payload}
                // A5-W3：金额摘要条读装配后的数据（items/currency），编辑中的 custom 由表单自己叠
                data={renderData.data.data}
              />
              {/* A5-W2：行项批量编辑（一次 PATCH 写 `custom.items_override`；撤销=再 PATCH 回旧值） */}
              <DocItemsBatchEditor
                docType={renderData.data.doc.doc_type}
                status={renderData.data.doc.status}
                data={renderData.data.data}
                initialOverride={readItemsOverride(
                  renderData.data.doc.raw_payload as Record<
                    string,
                    unknown
                  > | null,
                )}
                onSave={async (override: ItemsOverrideEntry[]) => {
                  const payload = buildItemsOverridePayload(
                    renderData.data.doc.raw_payload as Record<
                      string,
                      unknown
                    > | null,
                    override,
                  );
                  await update.mutateAsync({
                    id: renderData.data.doc.id,
                    raw_payload: payload,
                  });
                }}
              />
              {/* 内容版本（A1）：草稿期每次保存/带入/翻译都留一版，可回看与恢复 */}
              <DocContentVersions
                docId={renderData.data.doc.id}
                docType={renderData.data.doc.doc_type}
                status={renderData.data.doc.status}
              />
              {/* 盖章回传不受"已签发冻结"限制：客户是签发**之后**才盖章回传的 */}
              <DocStampReturn docId={renderData.data.doc.id} />
              {/* A7 加固：签发被事实层闸门拦下时，在这里逐条列出阻断项 */}
              <DocConfirmGate
                blocked={confirmBlocked}
                onGoToFacts={() => setHardeningTab("facts")}
                onDismiss={() => setConfirmBlocked(null)}
              />
              {/* A7 加固：事实确认 / 一致性 / 收款 / 单证清单 */}
              <DocHardeningSection
                docId={renderData.data.doc.id}
                status={renderData.data.doc.status}
                currency={renderData.data.doc.currency}
                tab={hardeningTab}
                onTabChange={setHardeningTab}
              />
              <DocPreview
                docType={renderData.data.doc.doc_type}
                docNo={renderData.data.doc.doc_no}
                data={renderData.data.data}
                docId={renderData.data.doc.id}
                renderMeta={renderMetaOf(renderData.data.doc.raw_payload)}
                companyProfileConfigured={
                  renderData.data.company_profile_configured
                }
              />
            </>
          ) : null}
        </SectionCard>
      )}

      <NumberEditDialog
        open={docNoEdit !== null}
        onOpenChange={(open) => {
          if (!open) setDocNoEdit(null);
        }}
        title="修改单证编号"
        label="单证编号"
        currentValue={docNoEdit?.doc_no ?? ""}
        description="单证编号默认自动生成；同一链条上尚未生成更晚单证时可以修改。"
        warning="确认后编号会立即生效。一旦生成后续单证，该编号将自动锁定，不能再改。"
        pending={update.isPending}
        error={docNoError}
        onConfirm={saveDocNo}
      />
    </div>
  );
}
