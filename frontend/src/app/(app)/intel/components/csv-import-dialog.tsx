"use client";

import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";

/**
 * 情报货运 CSV 导入（C36 #15）。
 *
 * 契约：`POST /api/v1/intel/import/csv`（multipart，字段 `file`）。
 * 后端**内置固定列映射**（英文/中文别名，`main.py:1013-1029`）——没有"自定义映射"参数，
 * 所以这里做的是「识别表头 → 显示列映射 → 预览前几行 → 报必填缺失 → 上传 → 展示逐行错误」，
 * 不做一个后端根本不读的映射下拉。
 */
import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Upload } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import apiClient from "@/lib/api/client";
import {
  analyzeIntelCsv,
  buildIntelCsvForm,
  intelImportErrorMessage,
  validateIntelCsvFile,
  type IntelCsvAnalysis,
  type IntelCsvImportResult,
} from "@/lib/intel/csv-import";

export function IntelCsvImportDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const qc = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [analysis, setAnalysis] = useState<IntelCsvAnalysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<IntelCsvImportResult | null>(null);

  const resetFile = () => {
    setFile(null);
    setAnalysis(null);
    setError(null);
    setResult(null);
    if (inputRef.current) inputRef.current.value = "";
  };

  const choose = async (next: File | null) => {
    setFile(next);
    setAnalysis(null);
    setResult(null);
    const invalid = validateIntelCsvFile(next);
    if (invalid) {
      setError(invalid);
      return;
    }
    setError(null);
    try {
      const text = await (next as File).text();
      setAnalysis(analyzeIntelCsv(text));
    } catch {
      setError("读取 CSV 失败，请确认文件是 UTF-8 文本");
    }
  };

  const submit = async () => {
    if (!file || !analysis?.ok) return;
    if (analysis.missingRequired.length > 0) {
      setError(`缺少后端必填列：${analysis.missingRequired.join(", ")}`);
      return;
    }
    setPending(true);
    setError(null);
    try {
      const { data } = await apiClient.post<IntelCsvImportResult>(
        "/intel/import/csv",
        buildIntelCsvForm(file),
        {
          headers: { "Content-Type": "multipart/form-data" },
          silent: true,
        },
      );
      setResult(data);
      qc.invalidateQueries({ queryKey: ["intel", "shipments"] });
      toast.success(
        `CSV 导入完成：成功 ${data.inserted} 行 / 失败 ${data.errors} 行`,
      );
    } catch (err) {
      setError(intelImportErrorMessage(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) resetFile();
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>导入情报货运 CSV</DialogTitle>
          <DialogDescription>
            后端按内置列别名识别：shipper/consignee/product_desc（或
            发货人/收货人/产品描述）为必填；其余列见下方映射。逐行失败不会中断整批。
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={inputRef}
            type="file"
            accept=".csv,text/csv"
            aria-label="选择情报 CSV 文件"
            className="text-xs"
            disabled={pending}
            onChange={(e) => void choose(e.target.files?.[0] ?? null)}
          />
          {file ? (
            <span className="text-xs text-muted-foreground">
              已选：{file.name}（{(file.size / 1024).toFixed(1)} KB）
            </span>
          ) : null}
        </div>

        {analysis ? (
          <div className="max-h-[50vh] space-y-3 overflow-auto">
            <div>
              <p className="mb-1 text-xs font-medium">列映射（后端内置）</p>
              <div className="flex flex-wrap gap-1">
                {analysis.columns.map((column, index) => (
                  <span
                    key={`${column.raw}-${index}`}
                    className={
                      column.field
                        ? "rounded bg-muted px-2 py-0.5 text-xs"
                        : "rounded bg-destructive/10 px-2 py-0.5 text-xs text-destructive"
                    }
                  >
                    {column.raw || "(空列)"} →{" "}
                    {column.field ?? "未识别（忽略）"}
                  </span>
                ))}
              </div>
            </div>
            {analysis.missingRequired.length > 0 ? (
              <p className="text-xs text-destructive">
                缺少后端必填列：{analysis.missingRequired.join(", ")}
                —— 上传后每一行都会失败，请先补列。
              </p>
            ) : null}
            {analysis.unknownColumns.length > 0 ? (
              <p className="text-xs text-muted-foreground">
                未识别列（不会导入）：{analysis.unknownColumns.join(", ")}
              </p>
            ) : null}
            <div>
              <p className="mb-1 text-xs font-medium">
                预览前 {analysis.preview.length} 行 / 共 {analysis.totalRows} 行
              </p>
              <div className="overflow-x-auto rounded border">
                <Table className="w-full text-xs">
                  <TableHeader>
                    <TableRow className="border-b bg-muted/40 text-left">
                      <TableHead scope="col" className="p-2">
                        行
                      </TableHead>
                      {analysis.columns
                        .filter((column) => column.field)
                        .map((column) => (
                          <TableHead
                            scope="col"
                            key={column.raw}
                            className="p-2"
                          >
                            {column.field}
                          </TableHead>
                        ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {analysis.preview.map((row) => (
                      <TableRow
                        key={row.row}
                        className="border-b last:border-0"
                      >
                        <TableCell className="p-2 text-muted-foreground">
                          {row.row}
                        </TableCell>
                        {analysis.columns
                          .filter((column) => column.field)
                          .map((column) => (
                            <TableCell
                              key={column.raw}
                              className="max-w-48 truncate p-2"
                            >
                              {row.values[column.field as string] || "-"}
                            </TableCell>
                          ))}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          </div>
        ) : null}

        {result ? (
          <div className="rounded border p-3 text-sm">
            处理 <strong>{result.processed}</strong> 行，成功导入{" "}
            <strong>{result.inserted}</strong> 行，失败{" "}
            <strong>{result.errors}</strong> 行。
            {result.error_details && result.error_details.length > 0 ? (
              <ul className="mt-2 list-disc pl-5 text-xs text-destructive">
                {result.error_details.map((detail, index) => (
                  <li key={index}>
                    第 {detail.row ?? "?"} 行：{detail.error ?? "未知错误"}
                  </li>
                ))}
              </ul>
            ) : null}
            {result.errors > (result.error_details?.length ?? 0) ? (
              <p className="mt-1 text-xs text-muted-foreground">
                后端只回传前 {result.error_details?.length ?? 0} 条错误明细。
              </p>
            ) : null}
          </div>
        ) : null}

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        <div className="flex justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              resetFile();
              onOpenChange(false);
            }}
            disabled={pending}
          >
            关闭
          </Button>
          <Button
            size="sm"
            onClick={() => void submit()}
            disabled={
              pending ||
              !file ||
              !analysis?.ok ||
              (analysis?.missingRequired.length ?? 0) > 0
            }
          >
            {pending ? (
              <Loader2 className="mr-1 size-4 animate-spin" />
            ) : (
              <Upload className="mr-1 size-4" />
            )}
            {pending ? "导入中…" : "确认导入"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
