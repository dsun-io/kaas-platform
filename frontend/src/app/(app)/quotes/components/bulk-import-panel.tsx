"use client";

import { useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  Loader2,
  Upload,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  describeIssue,
  groupIssues,
  issuesToCsv,
  issuesToText,
  triggerBlobDownload,
  validateFile,
} from "@/lib/export-quote/import-file";
import { ORDER_TEMPLATE_NOTES_SHEET } from "@/lib/export-quote/import-order-template-xlsx";
import { handleApiError } from "@/lib/api/error-handler";
import type {
  OrderImportPreviewResponse,
  OrderImportRow,
} from "@contracts/export-quote";

import {
  useDownloadOrderTemplate,
  useImportOrderPreview,
  useOrderImportTemplateInfo,
} from "../hooks/use-export-quote-import";

function errText(err: unknown): string {
  if (err instanceof Error && "response" in err) {
    return handleApiError(err as Parameters<typeof handleApiError>[0]);
  }
  return err instanceof Error ? err.message : "未知错误，请稍后重试";
}

const COST_BASIS_LABEL: Record<string, string> = {
  pretax: "不含税",
  incl_tax: "含税",
};

/**
 * 批量导入面板（R-D，2026-10-23 整单化）。
 *
 * 用户口径（2026-10-23 拍板）：
 *  · **不区分产品**：一张整单表导入整个订单的 N 个产品行（规格列 = 各产品模板列并集）；
 *  · 导入结果**直接填入报价工作台**（不再「只算不落库」）——算价/落库都走工作台既有链路。
 *
 * 本面板只做三件事：下载整单模板 → 上传解析预览（行级校验）→ 填入工作台。
 */
export function BulkImportPanel({
  onFillRows,
}: {
  /** 把解析成功的行填入工作台（父组件负责生成行草稿） */
  onFillRows: (rows: OrderImportRow[]) => void;
}) {
  const productKeys = useMemo<string[]>(() => [], []);
  const template = useOrderImportTemplateInfo(productKeys);
  const download = useDownloadOrderTemplate();
  const preview = useImportOrderPreview();

  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<OrderImportPreviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const issues = result?.issues ?? [];
  const grouped = groupIssues(issues);
  const usableRows = result?.usable_rows ?? 0;

  const onPick = (next: File | null) => {
    setFile(next);
    setResult(null);
    setError(null);
    setNotice(null);
    if (!next) return;
    const problem = validateFile(next, { maxMb: template.data?.max_mb ?? 2 });
    if (problem) {
      setError(problem);
      setFile(null);
    }
  };

  const runPreview = async () => {
    if (!file) return;
    setError(null);
    setResult(null);
    try {
      const data = await preview.mutateAsync({ file });
      setResult(data);
      setNotice(
        data.usable_rows > 0
          ? `解析到 ${data.usable_rows} 个产品行（${data.products.length} 个产品），可以填入工作台`
          : "没有可用行，请按下面的问题清单修改后重传",
      );
    } catch (e) {
      setError(errText(e));
    }
  };

  const fill = () => {
    const rows = result?.rows ?? [];
    if (rows.length === 0) return;
    onFillRows(rows);
    toast.success(`已填入 ${rows.length} 个产品行，请在工作台核对后保存`);
  };

  const copyIssues = async () => {
    const text = issuesToText(issues);
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`已复制 ${issues.length} 条问题`);
    } catch {
      toast.error("复制失败（浏览器未授权剪贴板），请用「下载 CSV」");
    }
  };

  const downloadIssues = () => {
    triggerBlobDownload(
      new Blob([issuesToCsv(issues)], { type: "text/csv;charset=utf-8" }),
      `import-order-issues-${new Date().toISOString().slice(0, 10)}.csv`,
    );
  };

  return (
    <div className="space-y-4">
      {/* ── 一、整单模板 ── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <FileSpreadsheet className="size-4" />
            第一步：下载整单模板
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            整单一张表：每行一个产品（第一列「产品」），规格列是各产品列的并集
            —— 与该行产品无关的列留空即可。导入后整单直接填入报价工作台。
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <Button
              type="button"
              disabled={download.isPending}
              onClick={() =>
                download.mutate(
                  { productKeys },
                  {
                    onError: (e) =>
                      toast.error(errText(e), {
                        description: "模板生成失败，请稍后重试",
                      }),
                  },
                )
              }
            >
              {download.isPending ? (
                <Loader2 className="mr-2 size-4 animate-spin" />
              ) : (
                <Download className="mr-2 size-4" />
              )}
              下载 Excel 整单模板
            </Button>
            {download.isSuccess && (
              <span className="text-xs text-muted-foreground">
                已下载 {download.data}
              </span>
            )}
          </div>
          {template.data && (
            <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
              模板含「{template.data.data_sheet}」「{ORDER_TEMPLATE_NOTES_SHEET}
              」两张表； 共 {template.data.headers.length} 列（整单公共 +
              各产品规格列并集）， 单表上限 {template.data.max_rows} 行 /{" "}
              {template.data.max_mb} MB。
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── 二、上传整单表 ── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Upload className="size-4" />
            第二步：上传整单表并预览
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[260px] flex-1 space-y-1">
              <Label className="text-xs">整单表（.xlsx / .csv）</Label>
              <Input
                ref={inputRef}
                type="file"
                accept=".xlsx,.xlsm,.csv,.txt"
                onChange={(e) => onPick(e.target.files?.[0] ?? null)}
                className="h-9 text-xs"
              />
            </div>
            <Button
              type="button"
              disabled={!file || preview.isPending}
              onClick={runPreview}
            >
              {preview.isPending ? (
                <Loader2 className="mr-2 size-4 animate-spin" />
              ) : (
                <CheckCircle2 className="mr-2 size-4" />
              )}
              解析预览
            </Button>
          </div>

          {error && (
            <div
              role="alert"
              className="flex gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive"
            >
              <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {result && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-3 text-xs">
                <span className="font-medium">
                  共 {result.total_data_rows} 行 / 可用 {usableRows} 行
                </span>
                {result.error_count > 0 && (
                  <span className="text-destructive">
                    {result.error_count} 处错误
                  </span>
                )}
                {result.warning_count > 0 && (
                  <span className="text-warning-muted-foreground">
                    {result.warning_count} 处提醒
                  </span>
                )}
                <span className="text-muted-foreground">
                  工作表：{result.sheet || result.source_name || "—"}
                </span>
              </div>

              {result.products.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  {result.products.map((p) => (
                    <Badge
                      key={p.product_key}
                      variant="secondary"
                      className="text-[11px]"
                    >
                      {p.product_name} × {p.rows}
                    </Badge>
                  ))}
                </div>
              )}

              {usableRows > 0 && (
                <div className="overflow-x-auto rounded-lg border">
                  <div className="min-w-[640px] border-b bg-muted/40 px-3 py-1.5 text-[11px] font-medium text-muted-foreground">
                    <span className="inline-block w-[52px]">行号</span>
                    <span className="inline-block w-[140px]">产品</span>
                    <span className="inline-block w-[80px]">件数（卷）</span>
                    <span className="inline-block w-[90px]">成本</span>
                    <span className="inline-block w-[72px]">成本口径</span>
                    <span className="inline-block w-[130px]">包装方式</span>
                    <span>规格</span>
                  </div>
                  {result.rows.slice(0, 50).map((row) => (
                    <div
                      key={`${row.row}-${row.product_key}`}
                      className="flex flex-wrap items-baseline gap-x-2 gap-y-1 border-b px-3 py-1.5 text-[11px] last:border-0"
                    >
                      <span className="inline-block w-[52px] tabular-nums">
                        {row.row}
                      </span>
                      <span className="inline-block w-[140px] font-medium">
                        {row.product_name}
                      </span>
                      <span className="inline-block w-[80px] tabular-nums">
                        {row.pieces}
                      </span>
                      <span className="inline-block w-[90px] tabular-nums">
                        {row.cost}
                      </span>
                      <span className="inline-block w-[72px]">
                        {COST_BASIS_LABEL[row.cost_basis] ?? row.cost_basis}
                      </span>
                      <span className="inline-block w-[130px]">
                        {row.packaging_method || "（默认）"}
                      </span>
                      <span className="text-muted-foreground">
                        {Object.values(row.spec ?? {})
                          .filter((v) => v !== null && v !== "")
                          .join(" × ") || "—"}
                      </span>
                    </div>
                  ))}
                  {result.rows.length > 50 && (
                    <div className="px-3 py-1.5 text-[11px] text-muted-foreground">
                      仅预览前 50 行；填入工作台时会带入全部{" "}
                      {result.rows.length} 行。
                    </div>
                  )}
                </div>
              )}

              {grouped.length > 0 && (
                <div className="space-y-2 rounded-lg border border-warning/40 bg-warning-muted/40 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs font-medium text-warning-muted-foreground">
                      问题清单（{issues.length}）
                    </span>
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-7 px-2 text-[11px]"
                        onClick={copyIssues}
                      >
                        复制
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-7 px-2 text-[11px]"
                        onClick={downloadIssues}
                      >
                        下载 CSV
                      </Button>
                    </div>
                  </div>
                  <div className="max-h-56 space-y-2 overflow-y-auto text-[11px]">
                    {grouped.map((group) => (
                      <div key={group.row}>
                        <p className="font-medium text-muted-foreground">
                          [{group.label}]
                        </p>
                        <ul className="ml-3 list-disc space-y-0.5">
                          {group.items.map((item, i) => (
                            <li
                              key={i}
                              className={cn(
                                item.severity === "error"
                                  ? "text-destructive"
                                  : "text-warning-muted-foreground",
                              )}
                            >
                              {describeIssue(item)}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {notice && (
                <p className="text-xs text-muted-foreground">{notice}</p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── 三、填入工作台 ── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <CheckCircle2 className="size-4" />
            第三步：填入报价工作台
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-sm text-muted-foreground">
            把解析成功的 {usableRows}{" "}
            个产品行填入工作台；在工作台里可继续核对规格、
            调整成本/包装/利润率，再保存报价单与生成单证。
          </p>
          <Button type="button" disabled={usableRows === 0} onClick={fill}>
            填入工作台（{usableRows} 行）
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
