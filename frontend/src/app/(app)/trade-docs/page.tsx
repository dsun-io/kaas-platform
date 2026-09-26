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
import { useMemo, useState } from "react";
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

import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge } from "@/components/shared/status-badge";
import { EmptyState } from "@/components/shared/empty-state";
import { Button } from "@/components/ui/button";
import { usePageView } from "@/lib/events/use-page-view";
import { renderTradeDoc } from "@/lib/trade-doc/render";
import { exportCsv, exportExcel, printMerged } from "@/lib/trade-doc/export";

import { DocCreateForm } from "./components/doc-create-form";
import { DocPreview } from "./components/doc-preview";
import { SamplePreview } from "./components/sample-preview";
import {
  useRefreshSources,
  useTradeDocRenderData,
  useTradeDocs,
  useUpdateTradeDoc,
  type TradeDocRow,
} from "./hooks/use-trade-docs";

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

function money(amount: number | null, currency: string) {
  if (amount === null || amount === undefined) return "—";
  return `${currency} ${amount.toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
}

export default function TradeDocsPage() {
  usePageView({ resource_id: "/trade-docs" });

  const [statusFilter, setStatusFilter] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [checked, setChecked] = useState<Set<number>>(new Set());

  const list = useTradeDocs({
    status: statusFilter || undefined,
    page_size: 100,
  });
  const renderData = useTradeDocRenderData(selectedId);
  const update = useUpdateTradeDoc();
  const refresh = useRefreshSources();

  const rows = list.data?.items ?? [];

  /** 台账导出列（与页面展示保持一致，避免"看到的"和"导出的"不一致） */
  const exportColumns = useMemo(
    () => [
      { header: "单证编号", value: (r: TradeDocRow) => r.doc_no, width: 22 },
      { header: "单证类型", value: (r: TradeDocRow) => r.doc_type, width: 20 },
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

  const changeStatus = (row: TradeDocRow, status: string) => {
    update.mutate(
      { id: row.id, status },
      {
        onSuccess: () =>
          toast.success(status === "issued" ? "已签发" : "已作废"),
      },
    );
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="单证"
        description="外贸出口全套单据：开单 → 校对 → 签发 → 打印/导出。单据自动继承上游订单的货物与贸易条款。"
      />

      <SectionCard
        title="样板预览（不需要后端）"
        description="用固定样例数据渲染 18 类单据，用于校对版式、金额大写与日期写法。不写数据库、不产生业务记录。"
      >
        <SamplePreview />
      </SectionCard>

      <SectionCard
        title="开单"
        description="单证必须挂靠上游（订单/报价单），这样货物、金额与贸易条款才能自动带入，避免手工重填出错。"
      >
        <DocCreateForm onCreated={(id) => setSelectedId(id)} />
      </SectionCard>
      <SectionCard
        title="单证台账"
        action={
          <div className="flex flex-wrap gap-2">
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
                exportCsv("单证台账.csv", rows, exportColumns);
                toast.success("CSV 已导出");
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
                  await exportExcel(
                    "单证台账.xlsx",
                    "单证台账",
                    rows,
                    exportColumns,
                  );
                  toast.success("Excel 已导出");
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
          <p className="py-8 text-center text-sm text-muted-foreground">
            加载中…
          </p>
        ) : list.isError ? (
          <div className="space-y-1 py-8 text-sm">
            <div className="flex items-center gap-2 text-destructive">
              <AlertCircle className="h-4 w-4" />
              读取单证台账失败：连不上开发后端（默认 http://localhost:8000）。
            </div>
            <p className="text-muted-foreground">
              台账需要后端数据库。想先看单据长什么样、校对版式，请用下面的「样板预览」——
              它不需要后端。
            </p>
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={FileText}
            title="还没有单证"
            description="先在上面开一张单，单据会自动带上订单里的货物与贸易条款。"
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="w-8 p-2" />
                  <th className="p-2">单证编号</th>
                  <th className="p-2">类型</th>
                  <th className="p-2">状态</th>
                  <th className="p-2">金额</th>
                  <th className="p-2">上游</th>
                  <th className="p-2">操作</th>
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
                    <td className="p-2 font-medium">{row.doc_no}</td>
                    <td className="p-2">{row.doc_type}</td>
                    <td className="p-2">
                      <StatusBadge tone={STATUS_TONE[row.status] ?? "default"}>
                        {STATUS_LABEL[row.status] ?? row.status}
                      </StatusBadge>
                    </td>
                    <td className="p-2">
                      {money(row.total_amount, row.currency)}
                    </td>
                    <td className="p-2 text-muted-foreground">
                      {row.raw_payload?.sources?.order?.order_no ??
                        row.raw_payload?.sources?.quote?.quote_no ??
                        "—"}
                    </td>
                    <td className="p-2">
                      <div className="flex flex-wrap gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setSelectedId(row.id)}
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
                              onClick={() => changeStatus(row, "issued")}
                            >
                              <ShieldCheck className="mr-1 h-3.5 w-3.5" />
                              签发
                            </Button>
                          </>
                        )}
                        {row.status === "issued" && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => changeStatus(row, "void")}
                          >
                            作废
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
                  onClick={() => changeStatus(renderData.data!.doc, "issued")}
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
              <DocPreview
                docType={renderData.data.doc.doc_type}
                docNo={renderData.data.doc.doc_no}
                data={renderData.data.data}
                companyProfileConfigured={
                  renderData.data.company_profile_configured
                }
              />
            </>
          ) : null}
        </SectionCard>
      )}
    </div>
  );
}
