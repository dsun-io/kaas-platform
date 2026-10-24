"use client";

/**
 * 开单前「成品预览」（2026-10-24，问题 6）—— 提交落库**之前**先看成品。
 *
 * 用户要解决的问题：开单是一个"填完才知道长什么样"的动作，落库后才发现版式/内容不对，
 * 就得改单据或重开。这里在提交之前用**当前表单已填数据**把该类型的成品渲染出来
 * （前端 `renderTradeDoc` + iframe，与已落库单据的预览同一套渲染器），确认无误再开单。
 *
 * 三条硬边界
 * ----------
 * - **不写库、不产生业务记录**：本组件只做本地渲染，没有任何请求；关闭即丢弃。
 * - **不伪造后端调用**：数据来自 `buildCreatePreviewData`（样板底稿 + 表单已填值），
 *   **不**调用 `/trade-docs/{id}/render-data`（开单前根本没有 id）。
 * - **只读**：不提供签发/归档/上传入口（那些需要真实单据 id），只校对版式与内容。
 *
 * 数据不足时（表单必填没填全）入口直接禁用，并把缺哪几项如实列出来 ——
 * 不让用户点开一个空单据猜"是我没填还是系统没带过来"。
 */
import { useMemo, useState } from "react";
import { AlertTriangle, Eye } from "lucide-react";

import { StatusBadge } from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { findMissingRequiredFields } from "@/lib/trade-doc/compliance";
import { renderTradeDoc } from "@/lib/trade-doc/render";
import type { CreatePreview } from "@/lib/trade-doc/create-preview";

export interface DocCreatePreviewProps {
  /** 用当前表单值装配好的预览数据；`null` = 连单证类型都还没选 */
  preview: CreatePreview | null;
  /** 当前预览的单证类型中文名（对话框标题用） */
  docLabel: string;
  /** 表单还缺哪些必填项（中文名）；非空 ⇒ 入口禁用并列出 */
  blockers: string[];
}

export function DocCreatePreview({
  preview,
  docLabel,
  blockers,
}: DocCreatePreviewProps) {
  const [open, setOpen] = useState(false);
  const blocked = blockers.length > 0 || preview === null;
  const blockedReason =
    blockers.length > 0
      ? `成品预览不可用：还缺必填「${blockers.join("、")}」`
      : "成品预览不可用：请先选择单证类型";

  // 只在对话框打开时才渲染：既省掉无谓计算，也让「只 mock 了模板清单」的既有单测不受影响
  const html = useMemo(() => {
    if (!open || !preview) return "";
    try {
      return renderTradeDoc(preview.docType, preview.data);
    } catch {
      // 未知类型不该让整个表单崩掉（与 DocPreview 同一口径）
      return `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:40px">
        <h2>无法渲染该单证</h2><p>该单证类型没有对应模板，请换一种类型再预览。</p></body></html>`;
    }
  }, [open, preview]);

  const missing = useMemo(
    () =>
      open && preview
        ? findMissingRequiredFields(preview.docType, preview.data)
        : [],
    [open, preview],
  );

  const fromFormText = preview?.fromForm.length
    ? `「${preview.fromForm.join("、")}」`
    : "数据";

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={blocked}
          onClick={() => setOpen(true)}
          title={
            blocked
              ? blockedReason
              : "用当前表单已填数据预览成品（不写库、不产生业务记录）"
          }
        >
          <Eye className="mr-1 h-4 w-4" aria-hidden="true" />
          成品预览
        </Button>
        <span className="text-xs text-muted-foreground" role="status">
          {blocked
            ? blockedReason
            : "开单前先看成品：按当前表单已填数据渲染，不写库、不产生业务记录"}
        </span>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[92vh] w-full overflow-y-auto sm:max-w-5xl">
          <DialogHeader>
            <DialogTitle>成品预览 · {docLabel}</DialogTitle>
            <DialogDescription>
              把当前表单已填的{fromFormText}
              套在这张单据的成品版式上，供开单前检查。
              货物明细、单号、日期等开单后才由系统带入的字段按内置样板占位显示；
              预览不写库、不产生业务记录，关闭即丢弃。
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge
              tone={missing.length === 0 ? "success" : "warning"}
              dot
            >
              {missing.length === 0
                ? "版式必填项齐全"
                : `还差 ${missing.length} 项必填`}
            </StatusBadge>
            <span className="text-xs text-muted-foreground">
              只读预览：不能签发 / 归档，正式单据请开单后在单据预览里处理
            </span>
          </div>

          {missing.length > 0 && (
            <div className="rounded-md border border-warning/40 bg-warning-muted p-3 text-sm text-warning-muted-foreground">
              <div className="mb-1 flex items-center gap-1 font-medium">
                <AlertTriangle className="h-4 w-4" aria-hidden="true" />
                以下必填项在当前预览数据里仍为空
              </div>
              <ul className="ml-5 list-disc space-y-0.5">
                {missing.map((item) => (
                  <li key={item.field}>
                    {item.label}
                    <span className="ml-1 opacity-80">({item.field})</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="overflow-hidden rounded-md border bg-white">
            <iframe
              title={`成品预览 ${docLabel}`}
              srcDoc={html}
              className="h-[900px] w-full"
              sandbox="allow-same-origin"
            />
          </div>

          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>
              关闭
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
