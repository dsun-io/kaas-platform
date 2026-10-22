"use client";

/**
 * Leadgen「CSV 导入」面板（C36 #17）。
 *
 * 页面文案早就承诺了 `POST /leadgen/runs/from-csv`（multipart），但一直没有上传控件。
 * 这里补上：选文件 → 本地预检（扩展名/空文件，不发请求）→ 上传 → 成功刷新线索池与运行历史；
 * 失败把后端原因（422/402/网络）**原样**显示在面板里，不只弹一句"导入失败"。
 */
import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { FileUp, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import apiClient from "@/lib/api/client";
import {
  buildLeadgenCsvForm,
  leadgenImportErrorMessage,
  validateLeadgenCsvFile,
} from "@/lib/leadgen/csv-import";

export interface LeadgenCsvRunResult {
  id: number;
  status: string;
  leads_found: number | null;
  leads_kept: number | null;
  error?: string | null;
  deduplicated?: boolean;
}

export function LeadgenCsvImport({
  onImported,
}: {
  /** 导入成功回调（页面用它刷新「运行历史」） */
  onImported?: (run: LeadgenCsvRunResult) => void;
}) {
  const qc = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    const invalid = validateLeadgenCsvFile(file);
    if (invalid) {
      setError(invalid);
      return;
    }
    const target = file as File;
    setPending(true);
    try {
      const { data } = await apiClient.post<LeadgenCsvRunResult>(
        "/leadgen/runs/from-csv",
        buildLeadgenCsvForm(target),
        {
          headers: { "Content-Type": "multipart/form-data" },
          silent: true,
        },
      );
      if (data.deduplicated) {
        toast.info("相同 CSV 已导入过 — 返回上次结果");
      } else {
        toast.success(`CSV 导入完成：保留 ${data.leads_kept ?? 0} 条线索`);
      }
      setFile(null);
      if (inputRef.current) inputRef.current.value = "";
      qc.invalidateQueries({ queryKey: ["leads"] });
      onImported?.(data);
    } catch (err) {
      setError(leadgenImportErrorMessage(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="mt-3 space-y-2 rounded-lg border border-dashed p-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={inputRef}
          type="file"
          accept=".csv,text/csv"
          aria-label="选择 CSV 文件"
          className="text-xs"
          disabled={pending}
          onChange={(e) => {
            setError(null);
            setFile(e.target.files?.[0] ?? null);
          }}
        />
        <Button
          size="sm"
          onClick={() => void submit()}
          disabled={pending || file === null}
        >
          {pending ? (
            <Loader2 className="mr-1 h-4 w-4 animate-spin" />
          ) : (
            <FileUp className="mr-1 h-4 w-4" />
          )}
          {pending ? "导入中…" : "导入 CSV 线索"}
        </Button>
        {file ? (
          <span className="text-xs text-muted-foreground">
            已选：{file.name}（{(file.size / 1024).toFixed(1)} KB）
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">
            支持公司名称、国家、城市、网站等列（按首行表头自动识别）
          </span>
        )}
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
