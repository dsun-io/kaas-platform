"use client";

/**
 * 抓取配置的动作条（校验 / 开始抓取 / 扫描已回复 / 批量爬取）+ 失败出口。
 *
 * 拆自 page.tsx：mutation 与 pending 状态仍由页面持有（状态编排），
 * 这里只负责按钮与错误展示（DOM/文案保持原样）。
 */
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AsyncButton } from "@/components/shared";
import { Globe, Play, RefreshCw, ShieldCheck } from "lucide-react";

import type { LeadgenValidation } from "../lib/types";

export function LeadgenRunActions({
  validating,
  validation,
  onValidate,
  onRun,
  runPending,
  runError,
  onScan,
  scanPending,
  scanError,
  onCrawlBatch,
  crawlBatchPending,
  crawlBatchError,
  crawling,
}: {
  validating: boolean;
  validation: LeadgenValidation | null;
  onValidate: () => void;
  onRun: () => void;
  runPending: boolean;
  runError: string | null;
  onScan: () => void;
  scanPending: boolean;
  scanError: string | null;
  onCrawlBatch: () => void;
  crawlBatchPending: boolean;
  crawlBatchError: string | null;
  /** 单行爬取进行中（有值时批量按钮也禁用，避免并发抓取同一批） */
  crawling: number | null;
}) {
  return (
    <>
      <div className="mt-3 flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={onValidate}
          disabled={validating}
        >
          <ShieldCheck className="mr-1 h-4 w-4" /> 校验
        </Button>
        <AsyncButton
          size="sm"
          onClick={onRun}
          pending={runPending}
          pendingLabel="运行中…"
        >
          <Play className="mr-1 h-4 w-4" /> 开始抓取
        </AsyncButton>
        <AsyncButton
          variant="outline"
          size="sm"
          onClick={onScan}
          pending={scanPending}
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
          onClick={onCrawlBatch}
          pending={crawlBatchPending}
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
              <Badge
                role="alert"
                className="bg-destructive/10 text-destructive"
              >
                {validation.issues.length} 个问题：
                {validation.issues.join("; ")}
              </Badge>
            )}
          </div>
        )}
      </div>
      {/* P0-B4：开始抓取 / 批量爬取失败都有页内出口（拦截器已 toast，不重复） */}
      {runError ? (
        <p
          role="alert"
          className="mt-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          抓取失败：{runError}（可修正配置后重试）
        </p>
      ) : null}
      {crawlBatchError ? (
        <p
          role="alert"
          className="mt-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          批量爬取失败：{crawlBatchError}（可重试）
        </p>
      ) : null}
      {/* P0-B2/L4：扫描失败要有出口（拦截器已 toast，这里保留原因便于重试） */}
      {scanError ? (
        <p
          role="alert"
          className="mt-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          扫描失败：{scanError}（可重试）
        </p>
      ) : null}
    </>
  );
}
