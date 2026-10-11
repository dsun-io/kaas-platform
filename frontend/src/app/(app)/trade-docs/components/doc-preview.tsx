"use client";

/**
 * 单证预览：把业务数据渲染成可打印的英文单据，并给出「合规缺口」提示。
 *
 * 关键点
 * ------
 * - 渲染在**前端**完成（零网络往返，点开即见），后端只给数据。
 * - 预览用 iframe + srcDoc：单据 HTML 自带完整样式与 @page 规则，
 *   与最终打印出来的效果一致（所见即所得），不会两边各写一套排版。
 * - 缺字段不是「加载失败」，而是明确列出还差哪几项 ——
 *   否则用户看到的是空白单据，不知道是自己没填还是系统没带过来。
 *
 * PDF 留档（用户要求「pdf 要存」）
 * --------------------------------
 * `window.print()` 只把页面交给打印对话框、**拿不回字节**，而生产是 Pyodide Worker
 * （没有无头浏览器）⇒ 系统自己出不了这一版 PDF（见 docs/TRADE_DOC_PDF_ARCHIVAL.md）。
 * 所以走**保真度最高、零新依赖**的一条路：用户在打印对话框里「另存为 PDF」导出的那份，
 * 就是客户看到的那一份 —— 让他选回来归档（`POST /trade-docs/{id}/files/upload`，
 * `role="render_pdf"`，字节进 `file_objects`）。重复归档 = 新版本上位、旧版挂
 * `render_pdf_superseded` 留档（版本让位在后端，已实现，前端只负责送字节）。
 * **仍未做**：服务端自动出字节（Browser Rendering / 无头 Chrome）。
 * `docId` 是归档的前提：不传（如「样板预览」没有真实单据）时归档区块完全不渲染。
 */
import { useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FileCheck2,
  FileUp,
  Printer,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StatusBadge } from "@/components/shared/status-badge";
import { normalizeApiError } from "@/lib/api/api-error";
import { findMissingRequiredFields } from "@/lib/trade-doc/compliance";
import { downloadHtml, printHtml } from "@/lib/trade-doc/export";
import { renderTradeDoc } from "@/lib/trade-doc/render";

import { useArchiveRenderedPdf, useUploadTradeDocFile } from "../hooks/use-trade-docs";

/**
 * 单份归档件的上限，**必须与内核一致**：`MAX_BYTES['render_pdf']`
 * （backend/kaas_common/files/rules.py）。前端先拦是为了不让用户拿一个 422 去猜哪里错了；
 * 真正的守门人仍然是服务端（前端能伪造 mime/大小）。
 */
export const RENDER_PDF_MAX_BYTES = 32 * 1024 * 1024;

/** 服务端 `NAME_TOO_LONG` 的阈值（80 字符）—— 同样前端先拦，别把 422 丢给用户猜。 */
export const ARCHIVE_NAME_MAX_LEN = 80;

const PDF_MIME = "application/pdf";

/**
 * 归档件默认名称：用单证号（服务端 `NAME_REQUIRED` 只在**既没传 name 也没文件名**时才触发，
 * 这里给一个可读默认值）。超长时截断但**保留 .pdf 后缀**，否则对象存储 key 会丢扩展名。
 */
export function defaultArchivePdfName(docNo: string, docType: string): string {
  const base = (docNo || docType || "trade-doc").trim() || "trade-doc";
  if (base.toLowerCase().endsWith(".pdf"))
    return base.slice(0, ARCHIVE_NAME_MAX_LEN);
  return `${base.slice(0, ARCHIVE_NAME_MAX_LEN - 4).trimEnd()}.pdf`;
}

/**
 * 归档前的前端校验：**不合规返回给用户看的中文原因**，合规返回 `null`。
 *
 * 为什么连 `size <= 0` 也拦：空文件在服务端同样是 `BAD_SIZE` 422 —— 与其让用户猜，
 * 不如当场说「这个文件是空的」。
 */
export function validateArchivePdf(file: File): string | null {
  if (file.type !== PDF_MIME) {
    return `只接受 PDF：这个文件浏览器上报的类型是 ${file.type || "(空)"}，请在打印对话框里选「另存为 PDF」再归档`;
  }
  if (file.size <= 0) return "这个文件是空的（0 字节），请重新导出后再归档";
  if (file.size > RENDER_PDF_MAX_BYTES) {
    const mb = RENDER_PDF_MAX_BYTES / (1024 * 1024);
    return `超过 ${mb}MB 上限（实际 ${(file.size / (1024 * 1024)).toFixed(1)}MB）`;
  }
  return null;
}

interface DocPreviewProps {
  docType: string;
  docNo: string;
  data: Record<string, unknown>;
  /** 是否已配置企业主体（未配置时卖方抬头是空的，必须显式提示） */
  companyProfileConfigured: boolean;
  /**
   * 单据 id：有了它才能归档 PDF（`POST /trade-docs/{id}/files/upload`）。
   * 「样板预览」这类没有真实单据的调用方不传 ⇒ 归档区块完全不渲染。
   */
  docId?: number;
}

export function DocPreview({
  docType,
  docNo,
  data,
  companyProfileConfigured,
  docId,
}: DocPreviewProps) {
  const html = useMemo(() => {
    try {
      return renderTradeDoc(docType, data);
    } catch {
      // 未知类型不应该让整个工位崩掉：给出可读提示，其余单据照常可看
      return `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:40px">
        <h2>无法渲染该单证</h2><p>单证类型「${docType}」没有对应模板。</p></body></html>`;
    }
  }, [docType, data]);

  const missing = useMemo(
    () => findMissingRequiredFields(docType, data),
    [docType, data],
  );

  const [pdfPicked, setPdfPicked] = useState<File | null>(null);
  const [pdfName, setPdfName] = useState("");
  const pdfInputRef = useRef<HTMLInputElement>(null);
  // hook 必须无条件调用（React 规则）；docId 缺失时这个 mutation 永远不会被触发
  const archive = useUploadTradeDocFile(docId ?? 0);
  const autoPdf = useArchiveRenderedPdf(docId ?? 0);

  /** 选文件即校验（当场提示），不合规就不进入"已选"状态 */
  const pickPdf = (file: File | null) => {
    if (!file) {
      setPdfPicked(null);
      return;
    }
    const problem = validateArchivePdf(file);
    if (problem) {
      toast.error(problem);
      setPdfPicked(null);
      // 清掉 input：否则用户修好文件后重选同一个名字不会触发 change
      if (pdfInputRef.current) pdfInputRef.current.value = "";
      return;
    }
    setPdfPicked(file);
  };

  const archivePdf = async () => {
    if (docId === undefined) return;
    if (!pdfPicked) {
      toast.error("先选一份 PDF（就是「打印 / 导出 PDF」里另存下来的那份）");
      return;
    }
    // 再校验一次：状态可能在选中之后被外部改动，且这里要覆盖"直接调函数"的路径
    const problem = validateArchivePdf(pdfPicked);
    if (problem) {
      toast.error(problem);
      return;
    }
    const label = (pdfName.trim() || defaultArchivePdfName(docNo, docType)).trim();
    if (label.length > ARCHIVE_NAME_MAX_LEN) {
      toast.error(`名称最长 ${ARCHIVE_NAME_MAX_LEN} 个字符`);
      return;
    }
    try {
      await archive.mutateAsync({ file: pdfPicked, role: "render_pdf", name: label });
      // 文案与后端语义一致：旧件不是被物理删掉，而是挂 render_pdf_superseded 留档
      toast.success("已归档；再归档会覆盖当前件，旧版留档");
      setPdfPicked(null);
      setPdfName("");
      if (pdfInputRef.current) pdfInputRef.current.value = "";
    } catch {
      toast.error("归档失败（类型/大小不合规时后端会明确拒绝）");
    }
  };

  /**
   * 自动出 PDF 并归档：把**预览用的同一份 HTML** 交给服务端，
   * 由 Cloudflare Browser Rendering 出字节后走同一套落档链路（版本让位、旧版留档）。
   *
   * 服务端未配置渲染器时后端返回 503 `PDF_RENDERER_NOT_CONFIGURED` ——
   * 这里**如实把后端的可执行提示给用户**（要开通/配置什么），
   * 绝不假装成功，也不静默降级；下方「归档本版 PDF」仍是随时可用的兜底。
   */
  const archiveAutoPdf = async () => {
    if (docId === undefined) return;
    const label = (pdfName.trim() || defaultArchivePdfName(docNo, docType)).trim();
    try {
      const res = await autoPdf.mutateAsync({ html, name: label });
      const kb = Math.max(1, Math.round((res?.bytes ?? 0) / 1024));
      toast.success(
        `已自动生成并归档（${kb} KB，渲染器 ${res?.renderer ?? "?"}）；再归档会覆盖当前件，旧版留档`,
      );
    } catch (err) {
      const { code, message } = normalizeApiError(err);
      if (code === "PDF_RENDERER_NOT_CONFIGURED") {
        toast.error(
          message ||
            "服务端未配置 PDF 渲染器：请先开通 Browser Rendering 并配置 browser binding（见 docs/TRADE_DOC_PDF_ARCHIVAL.md）",
        );
        return;
      }
      // 其它失败：保留后端原文（便于定位），但**必须**指向人工兜底 —— 否则用户以为没救了
      toast.error(`${message || "自动出 PDF 失败"}；可以用下方「归档本版 PDF」人工归档兜底`);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge tone={missing.length === 0 ? "success" : "warning"} dot>
          {missing.length === 0
            ? "必填齐全，可签发"
            : `还差 ${missing.length} 项必填`}
        </StatusBadge>
        {!companyProfileConfigured && (
          <StatusBadge tone="danger" dot>
            未配置企业主体信息 —— 单据卖方抬头为空
          </StatusBadge>
        )}
        <div className="ml-auto flex gap-2">
          {docId !== undefined && (
            <Button
              size="sm"
              variant="outline"
              disabled={autoPdf.isPending}
              onClick={archiveAutoPdf}
            >
              <FileCheck2 className="mr-1 h-4 w-4" />
              {autoPdf.isPending ? "生成中…" : "自动出 PDF 并归档"}
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={() => printHtml(html)}>
            <Printer className="mr-1 h-4 w-4" />
            打印 / 导出 PDF
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => downloadHtml(`${docNo || docType}.html`, html)}
          >
            <Download className="mr-1 h-4 w-4" />
            下载 HTML
          </Button>
        </div>
      </div>

      {missing.length > 0 && (
        <div className="rounded-md border border-warning/40 bg-warning-muted p-3 text-sm text-warning-muted-foreground">
          <div className="mb-1 flex items-center gap-1 font-medium">
            <AlertTriangle className="h-4 w-4" />
            这张单据还不能直接发给客户 / 报关（以下必填项为空）
          </div>
          <ul className="ml-5 list-disc space-y-0.5">
            {missing.map((item) => (
              <li key={item.field}>
                {item.label}
                <span className="ml-1 opacity-80">({item.field})</span>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-xs opacity-80">
            常见原因：企业主体信息未填（卖方抬头）、客户档案缺地址/联系人、上游订单未填贸易条款。
          </p>
        </div>
      )}

      {missing.length === 0 && (
        <div className="flex items-center gap-1 text-sm text-success">
          <CheckCircle2 className="h-4 w-4" />
          必填项齐全，可直接打印或签发。
        </div>
      )}

      <div className="overflow-hidden rounded-md border bg-white">
        <iframe
          title={`单证预览 ${docNo}`}
          srcDoc={html}
          className="h-[900px] w-full"
          sandbox="allow-same-origin"
        />
      </div>

      {docId !== undefined && (
        <div className="rounded-md border border-dashed p-3">
          <div className="flex flex-wrap items-center gap-2">
            <FileUp className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">归档本版 PDF</span>
            <span className="text-xs text-muted-foreground">
              在「打印 / 导出 PDF」里选「另存为 PDF」，把导出的那份选回来 ——
              存的就是客户看到的那一版；再归档会覆盖当前件，旧版留档（不删除）。
            </span>
          </div>
          <div className="mt-2 flex flex-wrap items-end gap-3">
            <label className="space-y-1">
              <span className="text-xs font-medium">
                PDF 文件（≤ {RENDER_PDF_MAX_BYTES / (1024 * 1024)}MB）
              </span>
              <input
                ref={pdfInputRef}
                type="file"
                accept="application/pdf"
                className="block text-xs"
                onChange={(e) => pickPdf(e.target.files?.[0] ?? null)}
              />
            </label>
            <label className="min-w-[220px] flex-1 space-y-1">
              <span className="text-xs font-medium">
                归档名称（可留空，默认用单证号）
              </span>
              <Input
                className="h-8 text-xs"
                value={pdfName}
                placeholder={defaultArchivePdfName(docNo, docType)}
                onChange={(e) => setPdfName(e.target.value)}
              />
            </label>
            <Button
              size="sm"
              variant="outline"
              disabled={archive.isPending}
              onClick={archivePdf}
            >
              <FileUp className="mr-1 h-3.5 w-3.5" />
              {archive.isPending ? "归档中…" : "归档本版 PDF"}
            </Button>
          </div>
          {pdfPicked && (
            <p className="mt-1 text-xs text-muted-foreground">
              已选：{pdfPicked.name}（{(pdfPicked.size / 1024).toFixed(0)} KB）
            </p>
          )}
        </div>
      )}
    </div>
  );
}
