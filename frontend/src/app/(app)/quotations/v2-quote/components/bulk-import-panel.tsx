"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useLatestFxRate } from "@/lib/fx/use-latest-fx";
import {
  canCalculate,
  describeIssue,
  groupIssues,
  resultToCsv,
  summarizeResult,
  triggerBlobDownload,
  validateFile,
} from "@/lib/export-quote/import-file";
import { IMPORT_TEMPLATE_NOTES_SHEET } from "@/lib/export-quote/import-template-xlsx";
import { handleApiError } from "@/lib/api/error-handler";
import type {
  ImportPreviewResponse,
  ImportCalculateResponse,
} from "@contracts/export-quote";
import {
  useDownloadTemplate,
  useExportProducts,
  useExportRateSets,
  useImportCalculate,
  useImportPreview,
  useImportTemplateInfo,
} from "../hooks/use-export-quote-import";

const today = () => new Date().toISOString().slice(0, 10);

function errText(err: unknown): string {
  if (err instanceof Error && "response" in err) {
    return handleApiError(err as Parameters<typeof handleApiError>[0]);
  }
  return err instanceof Error ? err.message : "未知错误，请稍后重试";
}

/**
 * 批量导入面板：下载模板 → 填表 → 上传 → 预览 → 一次算完。
 *
 * 放在报价工位里而不是单独开一个页面 —— 报价前的一次性批量试算
 * 和单条试算是同一件事，分成两个入口只会让人找不到。
 */
export function BulkImportPanel() {
  const products = useExportProducts();
  const rateSets = useExportRateSets();
  const download = useDownloadTemplate();
  const preview = useImportPreview();
  const calculate = useImportCalculate();

  const [productKey, setProductKey] = useState<string>("");
  const [rateSetCode, setRateSetCode] = useState<string>("");
  const [orderTotal, setOrderTotal] = useState("30000");
  // 汇率不写死：默认留空，由 useLatestFxRate 自动带入最新汇率，用户手填可覆盖
  const [fxRate, setFxRate] = useState("");
  const [fxTouched, setFxTouched] = useState(false);
  // 政策参数一律按【百分比】填写（10 = 10%），提交前除以 100 —— 与「产品报价」页同一口径
  const [giveRatioPct, setGiveRatioPct] = useState("80");
  const [inputVatRatePct, setInputVatRatePct] = useState("10");
  const [outputVatRatePct, setOutputVatRatePct] = useState("0");
  const [quoteDate, setQuoteDate] = useState(today());
  const [view, setView] = useState<"customer" | "internal">("customer");

  const [file, setFile] = useState<File | null>(null);
  const [previewResult, setPreviewResult] =
    useState<ImportPreviewResponse | null>(null);
  const [result, setResult] = useState<ImportCalculateResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // 最新汇率：用户没手填时自动带入（手填优先，不覆盖）
  const latestFx = useLatestFxRate();
  useEffect(() => {
    if (fxTouched) return;
    const rate = latestFx.data?.rate;
    if (typeof rate === "number" && Number.isFinite(rate) && rate > 0) {
      setFxRate(String(rate));
    }
  }, [fxTouched, latestFx.data?.rate]);

  // 产品/档案列表回来之前保持空选择，避免用错档案算出错价
  const effectiveProduct = productKey || products.data?.products[0]?.key || "";
  const effectiveRateSet =
    rateSetCode || rateSets.data?.rate_sets[0]?.code || "";
  const template = useImportTemplateInfo(effectiveProduct || null);

  /** 上传时带的计算参数；税率默认值来自所选税务档案，不在前端写死。 */
  const payload = useMemo(
    () => ({
      product_key: effectiveProduct,
      rate_set_code: effectiveRateSet || undefined,
      fx_rate: Number(fxRate) || 0,
      quote_date: quoteDate,
      orders: [{ total: Number(orderTotal) || 0, unit: "m" }],
      validity_days: 7,
      policy: {
        input_vat_rate: (Number(inputVatRatePct) || 0) / 100,
        give_ratio: (Number(giveRatioPct) || 0) / 100,
        output_vat_rate: (Number(outputVatRatePct) || 0) / 100,
      },
    }),
    [
      effectiveProduct,
      effectiveRateSet,
      fxRate,
      quoteDate,
      orderTotal,
      inputVatRatePct,
      giveRatioPct,
      outputVatRatePct,
    ],
  );

  const resetResults = () => {
    setPreviewResult(null);
    setResult(null);
    setError(null);
    setNotice(null);
  };

  const pickFile = (f: File | null) => {
    resetResults();
    if (!f) {
      setFile(null);
      return;
    }
    const problem = validateFile(f, {
      maxMb: template.data?.max_mb ?? 2,
    });
    if (problem) {
      setFile(null);
      setError(problem);
      return;
    }
    setFile(f);
  };

  const runPreview = async () => {
    if (!file) return;
    setError(null);
    setResult(null);
    try {
      const data = await preview.mutateAsync({
        file,
        productKey: effectiveProduct,
        payload,
      });
      setPreviewResult(data);
      setNotice(
        data.usable_rows > 0
          ? `解析到 ${data.usable_rows} 行可用规格，可以计算`
          : "没有可用行，请按下面的问题清单修改后重传",
      );
    } catch (e) {
      setPreviewResult(null);
      setError(errText(e));
    }
  };

  const runCalculate = async () => {
    if (!file) return;
    setError(null);
    try {
      const data = await calculate.mutateAsync({
        file,
        productKey: effectiveProduct,
        payload,
        view,
      });
      setResult(data);
      setNotice(`已计算 ${data.import?.usable_rows ?? 0} 行`);
    } catch (e) {
      setError(errText(e));
    }
  };

  const exportResult = () => {
    if (!result) return;
    const table =
      view === "internal" && result.internal
        ? result.internal
        : result.customer;
    const csv = resultToCsv(table.header, table.rows);
    triggerBlobDownload(
      new Blob([csv], { type: "text/csv;charset=utf-8" }),
      `export-quote-import-${result.meta.quote_date ?? today()}.csv`,
    );
  };

  const loadingTemplate = download.isPending;
  const summary = summarizeResult(result, previewResult?.usable_rows ?? 0);
  const issues = previewResult?.issues ?? result?.import?.issues ?? [];
  const grouped = groupIssues(issues);

  return (
    <div className="space-y-4">
      {/* ── 一、模板：能不能用，先看这一步 ── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <FileSpreadsheet className="size-4" />
            第一步：下载模板
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            模板直接从系统下载，列名与系统导出的报价表一致 ——
            导出的表格也能原样上传重算，不用另对照列名。
          </p>

          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label className="text-xs">产品</Label>
              <Select
                value={effectiveProduct}
                onValueChange={(v) => v && setProductKey(v)}
              >
                <SelectTrigger className="w-48">
                  <SelectValue placeholder="选择产品" />
                </SelectTrigger>
                <SelectContent>
                  {(products.data?.products ?? []).map((p) => (
                    <SelectItem key={p.key} value={p.key}>
                      {p.name}（{p.combo_count} 个组合）
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* CSV 仍是主按钮：它是脚本/命令行批量生成最直接的目标格式（仅表头、无样式）。
                Excel 按钮给出前端用 exceljs 现生成的 .xlsx —— 带表头样式、必填标注、
                下拉与填写说明页，列定义仍来自后端模板信息接口，前端不写死产品列。
                两种格式都能被导入链路接受；主按钮语义不变。 */}
            <Button
              type="button"
              disabled={!effectiveProduct || loadingTemplate}
              onClick={() =>
                download.mutate(
                  { productKey: effectiveProduct, format: "csv" },
                  {
                    onError: (e) =>
                      toast.error(errText(e), {
                        description: "CSV 模板下载失败，请稍后重试",
                      }),
                  },
                )
              }
            >
              {loadingTemplate ? (
                <Loader2 className="mr-2 size-4 animate-spin" />
              ) : (
                <Download className="mr-2 size-4" />
              )}
              下载 CSV 模板（仅表头）
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={!effectiveProduct || loadingTemplate}
              onClick={() =>
                download.mutate(
                  { productKey: effectiveProduct, format: "xlsx" },
                  {
                    onError: (e) =>
                      toast.error(errText(e), {
                        description:
                          "Excel 模板生成失败，请稍后重试或改用 CSV 模板",
                      }),
                  },
                )
              }
            >
              <Download className="mr-2 size-4" />
              下载 Excel 模板（带说明）
            </Button>

            {download.isSuccess && (
              <span className="text-xs text-muted-foreground">
                已下载 {download.data}
              </span>
            )}
          </div>

          {template.data && (
            <div className="space-y-2 rounded-md border bg-muted/30 p-3">
              <div className="text-xs text-muted-foreground">
                Excel 模板含「{template.data.data_sheet}」「
                {IMPORT_TEMPLATE_NOTES_SHEET}」两张表：解析只读「
                {template.data.data_sheet}」，说明页不参与计算。 单表上限{" "}
                {template.data.max_rows} 行、 文件上限 {template.data.max_mb}{" "}
                MB。
              </div>
              <div className="flex flex-wrap gap-1.5">
                {template.data.columns.map((c) => (
                  <Badge
                    key={c.header}
                    variant={c.required ? "default" : "secondary"}
                    title={c.note}
                    className="font-normal"
                  >
                    {c.header}
                    {c.unit ? (
                      <span className="opacity-70">/{c.unit}</span>
                    ) : null}
                    {c.required ? " *" : ""}
                  </Badge>
                ))}
              </div>
              <div className="text-xs text-muted-foreground">
                带 <span className="font-medium">*</span> 的列必填；
                其余列留空表示按丝径方案自动带出，需要覆盖时才填。
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── 二、上传 ── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Upload className="size-4" />
            第二步：上传并计算
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <div className="space-y-1">
              <Label className="text-xs" htmlFor="bi-order">
                订单量（米）
              </Label>
              <Input
                id="bi-order"
                value={orderTotal}
                onChange={(e) => setOrderTotal(e.target.value)}
                inputMode="decimal"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs" htmlFor="bi-fx">
                汇率（1 USD = ? CNY）
              </Label>
              <Input
                id="bi-fx"
                value={fxRate}
                onChange={(e) => {
                  setFxTouched(true);
                  setFxRate(e.target.value);
                }}
                placeholder={
                  latestFx.isPending
                    ? "自动获取中…"
                    : latestFx.data
                      ? `自动带入 ${latestFx.data.rate}`
                      : "手动填写"
                }
                inputMode="decimal"
              />
              {latestFx.data?.is_stale && (
                <p className="text-xs text-muted-foreground">
                  汇率来自缓存（{latestFx.data.rate_date}），可手动改
                </p>
              )}
            </div>
            <div className="space-y-1">
              <Label className="text-xs">税务档案</Label>
              <Select
                value={effectiveRateSet}
                onValueChange={(v) => v && setRateSetCode(v)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="按报价日自动匹配" />
                </SelectTrigger>
                <SelectContent>
                  {(rateSets.data?.rate_sets ?? []).map((rs) => (
                    <SelectItem key={rs.code} value={rs.code}>
                      {rs.name || rs.code}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs" htmlFor="bi-vat">
                进项票税点（%）
              </Label>
              <Input
                id="bi-vat"
                value={inputVatRatePct}
                onChange={(e) => setInputVatRatePct(e.target.value)}
                inputMode="decimal"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs" htmlFor="bi-out">
                销项税率（%）
              </Label>
              <Input
                id="bi-out"
                value={outputVatRatePct}
                onChange={(e) => setOutputVatRatePct(e.target.value)}
                inputMode="decimal"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs" htmlFor="bi-give">
                让利比例（%）
              </Label>
              <Input
                id="bi-give"
                value={giveRatioPct}
                onChange={(e) => setGiveRatioPct(e.target.value)}
                inputMode="decimal"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs" htmlFor="bi-date">
                报价日期
              </Label>
              <Input
                id="bi-date"
                type="date"
                value={quoteDate}
                onChange={(e) => setQuoteDate(e.target.value)}
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            {/* 前端生成的 Excel 模板是 .xlsx，选择器必须放行，否则「下完传不上」；
                validateFile 也支持 .xlsx/.xlsm，老式 .xls 仍会给出另存为提示。 */}
            <input
              ref={inputRef}
              type="file"
              accept=".csv,.txt,.xlsx,.xlsm"
              className="hidden"
              onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
            />
            <Button
              type="button"
              variant="outline"
              onClick={() => inputRef.current?.click()}
            >
              <Upload className="mr-2 size-4" />
              选择表格文件
            </Button>
            {file && (
              <span className="text-sm">
                {file.name}
                <span className="ml-2 text-xs text-muted-foreground">
                  {(file.size / 1024).toFixed(0)} KB
                </span>
              </span>
            )}

            <Button
              type="button"
              variant="secondary"
              disabled={!file || preview.isPending}
              onClick={runPreview}
            >
              {preview.isPending && (
                <Loader2 className="mr-2 size-4 animate-spin" />
              )}
              先预览解析结果
            </Button>

            <Button
              type="button"
              disabled={
                !file || calculate.isPending || !canCalculate(previewResult)
              }
              onClick={runCalculate}
              title={
                previewResult && !canCalculate(previewResult)
                  ? "没有可用行，先按问题清单修改表格"
                  : undefined
              }
            >
              {calculate.isPending && (
                <Loader2 className="mr-2 size-4 animate-spin" />
              )}
              批量计算
            </Button>

            <div className="ml-auto flex items-center gap-2">
              <Label className="text-xs">视图</Label>
              <Select
                value={view}
                onValueChange={(v) => {
                  setView(v as "customer" | "internal");
                  setResult(null);
                }}
              >
                <SelectTrigger className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="customer">客户视图</SelectItem>
                  <SelectItem value="internal">内部核算</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {error && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
              <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
              <span>{error}</span>
            </div>
          )}

          {notice && !error && (
            <div className="flex items-start gap-2 rounded-md border bg-muted/40 p-3 text-sm">
              <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
              <span>{notice}</span>
            </div>
          )}

          {previewResult && (
            <div className="space-y-2 text-sm">
              <div className="flex flex-wrap gap-x-6 gap-y-1">
                <span>
                  数据行 <b>{previewResult.total_data_rows}</b>
                </span>
                <span className="text-emerald-600 dark:text-emerald-500">
                  可用 <b>{previewResult.usable_rows}</b>
                </span>
                <span
                  className={cn(
                    previewResult.error_count > 0 && "text-destructive",
                  )}
                >
                  错误 <b>{previewResult.error_count}</b>
                </span>
                <span className="text-muted-foreground">
                  提示 <b>{previewResult.warning_count}</b>
                </span>
                {previewResult.ignored_columns.length > 0 && (
                  <span className="text-muted-foreground">
                    已忽略列：{previewResult.ignored_columns.join("、")}
                  </span>
                )}
              </div>

              {grouped.length > 0 && (
                <div className="max-h-64 space-y-2 overflow-auto rounded-md border bg-muted/20 p-3">
                  {grouped.map((g) => (
                    <div key={`${g.row}`}>
                      <div className="text-xs font-medium">{g.label}</div>
                      <ul className="ml-4 list-disc text-xs text-muted-foreground">
                        {g.items.map((it, i) => (
                          <li
                            key={`${g.row}-${i}`}
                            className={cn(
                              it.severity === "error" && "text-destructive",
                            )}
                          >
                            {describeIssue(it)}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── 三、结果 ── */}
      {result && (
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
            <CardTitle className="text-base">
              计算结果
              <span className="ml-3 text-xs font-normal text-muted-foreground">
                报价有效至 {result.meta.valid_until ?? "—"}（
                {result.meta.validity_days} 天）
              </span>
            </CardTitle>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={exportResult}
            >
              <Download className="mr-2 size-4" />
              导出 CSV
            </Button>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Metric label="规格行数" value={summary.rows} />
              <Metric
                label="总净重"
                value={
                  summary.totalWeightKg === null
                    ? "—"
                    : `${summary.totalWeightKg.toFixed(2)} kg`
                }
              />
              <Metric
                label={`总售价（${result.meta.currency}）`}
                value={
                  summary.totalPrice === null
                    ? "—"
                    : summary.totalPrice.toFixed(2)
                }
              />
              <Metric
                label={`总售价（${result.meta.quote_currency}）`}
                value={
                  summary.totalPriceFx === null
                    ? "—"
                    : summary.totalPriceFx.toFixed(2)
                }
              />
            </div>

            {result.meta.diagnostics.length > 0 && (
              <ul className="list-disc space-y-1 rounded-md border bg-amber-50 p-3 pl-7 text-xs text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
                {result.meta.diagnostics.map((d, i) => (
                  <li key={i}>{d}</li>
                ))}
              </ul>
            )}

            <ResultTable result={result} view={view} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-md border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-medium tabular-nums">{value}</div>
    </div>
  );
}

/** 结果表：整表可能几百行，只渲染前 200 行，其余提示导出看。 */
const MAX_VISIBLE_ROWS = 200;

function ResultTable({
  result,
  view,
}: {
  result: ImportCalculateResponse;
  view: "customer" | "internal";
}) {
  const table =
    view === "internal" && result.internal ? result.internal : result.customer;
  const rows = table.rows.slice(0, MAX_VISIBLE_ROWS);

  return (
    <div className="space-y-2">
      <div
        className="overflow-auto rounded-md border"
        style={{ maxHeight: 480 }}
      >
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-muted">
            <tr>
              {table.header.map((h, i) => (
                <th
                  key={`${h}-${i}`}
                  className="whitespace-nowrap border-b px-2 py-1.5 text-left font-medium"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className="odd:bg-muted/20">
                {row.map((cell, j) => (
                  <td
                    key={j}
                    className="whitespace-nowrap border-b px-2 py-1 tabular-nums"
                  >
                    {cell === null || cell === undefined ? "" : String(cell)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {table.rows.length > MAX_VISIBLE_ROWS && (
        <p className="text-xs text-muted-foreground">
          共 {table.rows.length} 行，此处只显示前 {MAX_VISIBLE_ROWS} 行；
          完整结果请导出 CSV。
        </p>
      )}
    </div>
  );
}
