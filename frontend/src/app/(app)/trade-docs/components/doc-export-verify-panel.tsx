"use client";

/**
 * 导出后自检面板（C21）
 *
 * 职责划分（与后端 `verify_trade_doc_export` 的分工，写死在注释里防漂移）：
 * - **前端抽取**：选/取一份已导出的 PDF（优先用已归档的 `role=render_pdf`），用 pdf.js
 *   抽文本与图片张数；再从**与预览同源**的渲染 HTML 里抽出"应当出现在 PDF 上"的文本。
 * - **后端裁决**：`POST /trade-docs/{id}/verify-export` 判定"文本都出现 + 图片计数相符"，
 *   默认 422 阻断（`EXPORT_SELF_CHECK_FAILED`）；`allow_override` 是管理员留痕动作，
 *   **普通 UI 不提供入口** —— 面板只如实展示阻断项，不"替用户放行"。
 *
 * pdf.js 体积（≈459KB / gzip 132KB + worker 1.26MB / gzip 374KB）只在点「自检」时才
 * 动态加载，不进首屏包（见 `lib/trade-doc/pdf-extract.ts`）。
 */
import { useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  FileSearch,
  ShieldAlert,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/shared/status-badge";
import {
  parseVerifyExportBlocked,
  type VerifyExportBlocked,
  type VerifyExportResponse,
} from "@/lib/trade-doc/hardening";
import {
  PdfExtractError,
  buildVerifyExportRequest,
  collectDocTexts,
  expectedImageCounts,
  extractPdfFacts,
  type ExpectedImages,
  type PdfFacts,
} from "@/lib/trade-doc/pdf-extract";
import { renderTradeDoc } from "@/lib/trade-doc/render";

import { useVerifyExport } from "../hooks/use-doc-hardening";
import {
  fetchFileObjectBytes,
  useTradeDocFiles,
  useTradeDocRenderData,
} from "../hooks/use-trade-docs";

type Outcome =
  | {
      kind: "ok";
      response: VerifyExportResponse;
      facts: PdfFacts;
      expected: ExpectedImages;
      textCount: number;
      source: string;
    }
  | {
      kind: "blocked";
      blocked: VerifyExportBlocked;
      facts: PdfFacts;
      source: string;
    }
  | { kind: "error"; message: string; source: string };

const MAX_LISTED = 20;

function describeError(err: unknown): string {
  if (err instanceof PdfExtractError) return err.message;
  if (err instanceof Error && err.message.trim()) return err.message;
  return "未知错误";
}

export function DocExportVerifyPanel({ docId }: { docId: number }) {
  const files = useTradeDocFiles(docId);
  const renderData = useTradeDocRenderData(docId);
  const verify = useVerifyExport(docId);
  const localInputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<"archived" | "local" | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const archivedPdf =
    (files.data ?? []).find(
      (file) => file.role === "render_pdf" && file.is_current,
    ) ?? null;

  const run = async (
    load: () => Promise<ArrayBuffer>,
    source: string,
    kind: "archived" | "local",
  ) => {
    setBusy(kind);
    setOutcome(null);
    let facts: PdfFacts | null = null;
    try {
      const bytes = await load();
      facts = await extractPdfFacts(bytes);
      const rd = renderData.data;
      if (!rd) throw new Error("单据渲染数据尚未就绪，请稍后重试");
      const html = renderTradeDoc(rd.doc.doc_type, rd.data);
      const texts = collectDocTexts(html);
      if (texts.length === 0) {
        throw new Error("这份单据没有抽到可核对的文本，无法自检");
      }
      const expected = expectedImageCounts(rd.data);
      const response = await verify.mutateAsync(
        buildVerifyExportRequest({
          pdfText: facts.text,
          texts,
          imageCount: facts.imageCount,
          expected,
        }),
      );
      setOutcome({
        kind: "ok",
        response,
        facts,
        expected,
        textCount: texts.length,
        source,
      });
    } catch (err) {
      const blocked = parseVerifyExportBlocked(err);
      if (blocked && facts) {
        setOutcome({ kind: "blocked", blocked, facts, source });
      } else {
        setOutcome({ kind: "error", message: describeError(err), source });
      }
    } finally {
      setBusy(null);
    }
  };

  const runArchived = () => {
    if (!archivedPdf) return;
    const target = archivedPdf;
    void run(
      () => fetchFileObjectBytes(target.id),
      `归档 PDF：${target.name}`,
      "archived",
    );
  };

  const runLocal = async (file: File | undefined) => {
    if (!file) return;
    if (localInputRef.current) localInputRef.current.value = "";
    void run(() => file.arrayBuffer(), `本地文件：${file.name}`, "local");
  };

  return (
    <div className="space-y-3">
      <div className="rounded-md border px-3 py-2 text-xs text-muted-foreground">
        前端只做<b>抽取</b>（PDF 文本 / 图片张数，pdf.js
        在点按钮时才加载）；是否 通过由<b>后端裁决</b>。未通过默认<b>阻断</b>
        ，系统不会自动放行。
      </div>

      <div className="space-y-2 rounded-md border p-3">
        <div className="flex flex-wrap items-center gap-2">
          <FileSearch className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">自检对象</span>
          {archivedPdf ? (
            <StatusBadge tone="info">
              已归档：{archivedPdf.name}（v{archivedPdf.version}）
            </StatusBadge>
          ) : (
            <span className="text-xs text-muted-foreground">
              还没有归档的导出 PDF（可先打印另存为 PDF
              并归档，或直接选本地文件）
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            onClick={runArchived}
            disabled={!archivedPdf || busy !== null}
          >
            {busy === "archived" ? "正在解析 PDF…" : "自检最近归档的 PDF"}
          </Button>
          <span className="text-xs text-muted-foreground">或</span>
          <input
            ref={localInputRef}
            type="file"
            accept="application/pdf,.pdf"
            aria-label="选择本地导出的 PDF 自检"
            className="text-xs"
            disabled={busy !== null}
            onChange={(event) => void runLocal(event.target.files?.[0])}
          />
          {busy === "local" && (
            <span className="text-xs text-muted-foreground">正在解析 PDF…</span>
          )}
        </div>
        {files.isError && (
          <p className="text-xs text-warning-muted-foreground">
            读取单据文件列表失败：无法确定有没有归档 PDF，仍可用本地文件自检。
          </p>
        )}
      </div>

      {outcome?.kind === "ok" && (
        <div
          data-testid="export-verify-result"
          className="space-y-1 rounded-md border border-success/40 bg-success-muted px-3 py-2 text-sm text-success-muted-foreground"
        >
          <div className="flex flex-wrap items-center gap-2">
            <CheckCircle2 className="h-4 w-4" />
            <span className="font-medium">自检通过（后端裁决）</span>
            {outcome.response.overridden && (
              <StatusBadge tone="warning">已越过并留痕</StatusBadge>
            )}
          </div>
          <p className="text-xs">
            {outcome.facts.pageCount} 页 · 抽到图片 {outcome.facts.imageCount}{" "}
            张（期望 {outcome.expected.total} 张：产品图{" "}
            {outcome.expected.photos} + 公章 {outcome.expected.stamp}） ·
            核对文本 {outcome.textCount} 段全部命中
          </p>
          <p className="text-[11px] text-success-muted-foreground/70">
            {outcome.source}
          </p>
        </div>
      )}

      {outcome?.kind === "blocked" && (
        <div
          data-testid="export-verify-result"
          className="space-y-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          <div className="flex items-center gap-2">
            <ShieldAlert className="h-4 w-4" />
            <span className="font-medium">
              自检未通过 —— 已阻断（后端裁决）
            </span>
          </div>
          {outcome.blocked.message && (
            <p className="text-xs">{outcome.blocked.message}</p>
          )}
          {outcome.blocked.missingTexts.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs font-medium">
                文本缺失 {outcome.blocked.missingTexts.length} 处（PDF
                里找不到，常见于行高截断）
              </p>
              <ul className="space-y-0.5 text-xs">
                {outcome.blocked.missingTexts
                  .slice(0, MAX_LISTED)
                  .map((text) => (
                    <li key={text} className="truncate">
                      「{text}」
                    </li>
                  ))}
              </ul>
              {outcome.blocked.missingTexts.length > MAX_LISTED && (
                <p className="text-[11px] opacity-70">
                  仅列出前 {MAX_LISTED} 处，共{" "}
                  {outcome.blocked.missingTexts.length} 处
                </p>
              )}
            </div>
          )}
          {outcome.blocked.imageMismatches.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs font-medium">图片计数不符</p>
              <ul className="space-y-0.5 text-xs">
                {outcome.blocked.imageMismatches.map((item) => (
                  <li key={item.key}>
                    {item.key === "stamp" ? "非产品图（公章）" : item.key}：期望{" "}
                    {item.expected} 张 / 实际 {item.actual} 张
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="text-[11px] opacity-70">
            修正版式后重新导出并归档，再自检；越过自检需管理员留痕，普通界面不提供。
          </p>
          <p className="text-[11px] opacity-70">{outcome.source}</p>
        </div>
      )}

      {outcome?.kind === "error" && (
        <div
          data-testid="export-verify-result"
          className="space-y-1 rounded-md border border-warning/40 bg-warning-muted px-3 py-2 text-sm text-warning-muted-foreground"
        >
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" />
            <span className="font-medium">无法完成自检</span>
          </div>
          <p className="text-xs">{outcome.message}</p>
          <p className="text-[11px] opacity-70">
            未调用后端裁决（没有结论 = 没有通过，不会显示为通过）。
            {outcome.source}
          </p>
        </div>
      )}
    </div>
  );
}
