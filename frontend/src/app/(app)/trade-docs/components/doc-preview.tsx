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
  Fingerprint,
  Printer,
  RefreshCw,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StatusBadge } from "@/components/shared/status-badge";
import { normalizeApiError } from "@/lib/api/api-error";
import { findMissingRequiredFields } from "@/lib/trade-doc/compliance";
import { downloadHtml, printHtml } from "@/lib/trade-doc/export";
import { findBlankPlaceholders, renderTradeDoc } from "@/lib/trade-doc/render";

import {
  useArchiveRenderedPdf,
  useCheckTradeDocRenderFingerprint,
  useUploadTradeDocFile,
  type RenderFingerprintCheck,
} from "../hooks/use-trade-docs";

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
    return `只接受 PDF：这个文件浏览器上报的类型是 ${file.type || "(空)"}，请在打印对话框里选「另存为 PDF」再上传`;
  }
  if (file.size <= 0) return "这个文件是空的（0 字节），请重新导出后再上传";
  if (file.size > RENDER_PDF_MAX_BYTES) {
    const mb = RENDER_PDF_MAX_BYTES / (1024 * 1024);
    return `超过 ${mb}MB 上限（实际 ${(file.size / (1024 * 1024)).toFixed(1)}MB）`;
  }
  return null;
}

/**
 * 签发时冻结的渲染指纹（= 后端 `raw_payload._render`）。形状由共享内核
 * `kaas_common.trade_doc.render_fingerprint.render_fingerprint` 决定（两端一致）。
 *
 * 只有**已签发**的单据才有这个键：它在 `confirm` 成功那一刻写入。
 * 所以"有它"就等价于"签发过"，前端不必再单独判状态（少一处可能与真实状态不同步的输入）。
 */
export interface RenderFingerprintMeta {
  /** 渲染器/模板版本：模板或渲染器改动时 +1（bump 纪律见内核注释） */
  render_version?: number;
  /** 渲染输入的 sha256；`null` = 签发时装配失败（后端如实标注，不伪造摘要） */
  input_sha256?: string | null;
  /** 冻结时刻（UTC ISO） */
  frozen_at?: string;
  /** `input_unavailable` = 装配失败时后端留的说明 */
  note?: string;
}

/**
 * 从 `raw_payload` 里安全取出指纹（= 内核 `read_render_fingerprint` 的前端对应物）。
 *
 * 为什么需要它：`TradeDocRow.raw_payload` 的类型只声明了 `sources`/`custom`，
 * 而 `_render` 是**后端在签发时追加的保留键** —— 与其在调用点写一个 `as any`，
 * 不如在这里收窄一次。
 *
 * 形状不对一律 `null`（**不渲染**那一行）：坏形状若照渲染，界面会出现
 * `渲染指纹 v? · 未冻结` 这种"看起来像真的、其实是坏的"指纹 —— 比不显示更糟。
 * 注意 `Array.isArray`：数组的 `typeof` 也是 `"object"`，只判 null 会把它放进来。
 */
export function renderMetaOf(
  rawPayload: unknown,
): RenderFingerprintMeta | null {
  if (typeof rawPayload !== "object" || rawPayload === null) return null;
  const meta = (rawPayload as Record<string, unknown>)["_render"];
  if (typeof meta !== "object" || meta === null || Array.isArray(meta))
    return null;
  // 内核**必定**写 `render_version`；没有它就不是我们冻结的那份指纹（宁可不显示）
  if (typeof (meta as RenderFingerprintMeta).render_version !== "number")
    return null;
  return meta as RenderFingerprintMeta;
}

/** 对账结论的语气：决定颜色（绿=一致／红=被改／黄=模板升级／灰=说不出结论）。 */
export type FingerprintVerdictTone =
  | "matched"
  | "changed"
  | "drift"
  | "unknown";

/**
 * 对账结论 → 一行展示文案（**只按服务端返回的 `reason` 判断**）。
 *
 * 为什么不在前端自己比对 `current_sha256` 与冻结值：那会漏掉"版本"这一维 ——
 * 模板升级与数据被改是**两件不同的事**，只有服务端（同一内核）才知道怎么区分。
 * 前端重推一遍必然与服务端漂移（G1 的同一理由）。
 *
 * 未知 `reason` 一律落到"无法判定"：将来服务端加结论码时，界面宁可说不出话，
 * 也不能凭空显示"一致"或"已变更"。
 */
export function fingerprintVerdict(result: RenderFingerprintCheck): {
  tone: FingerprintVerdictTone;
  text: string;
} {
  switch (result.reason) {
    case "matched":
      return { tone: "matched", text: "与签发时一致" };
    case "data_changed":
      return { tone: "changed", text: "签发后数据已被修改" };
    case "version_drift":
      return { tone: "drift", text: "渲染模板已升级（数据未变）" };
    case "no_fingerprint":
      // 有 renderMeta 才有入口，理论上到不了这里；兜底也**不能**说成"一致"
      return { tone: "unknown", text: "没有签发时的指纹（无法比对）" };
    case "frozen_unavailable":
      return {
        tone: "unknown",
        text: `无法判定（签发时未冻结成功：${result.frozen_note ?? "原因未记录"}）`,
      };
    case "current_unavailable":
      return {
        tone: "unknown",
        text: `无法判定（${result.current_note ?? "装配失败"}）`,
      };
    default:
      return { tone: "unknown", text: "无法判定（未知结论）" };
  }
}

const VERDICT_TONE_CLASS: Record<FingerprintVerdictTone, string> = {
  matched: "text-success",
  changed: "text-destructive font-medium",
  drift: "text-warning",
  unknown: "text-muted-foreground",
};

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
  /** 签发时冻结的渲染指纹；不传/为 null ⇒ 这一行不渲染（草稿与历史单据都没有） */
  renderMeta?: RenderFingerprintMeta | null;
}

export function DocPreview({
  docType,
  docNo,
  data,
  companyProfileConfigured,
  docId,
  renderMeta,
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

  // 字段体检（TODO(TODO:A3)）：模板引用了却渲染为空的字段。签名口径「缺失键渲染为空串」
  // 保证了不留 `$placeholder`，代价是拼错/漏登记只是静静空白 —— 这里把它显式化。
  const audit = useMemo(() => {
    try {
      return findBlankPlaceholders(docType, data);
    } catch {
      // 未知单证类型（上面渲染已给可读提示）不应让预览整块崩掉
      return { undeclared: [], blankRequired: [], blankOptional: [] };
    }
  }, [docType, data]);
  const blankHint = useMemo(() => {
    const parts: string[] = [];
    if (audit.undeclared.length > 0) {
      parts.push(
        `模板引用了未登记字段（请查占位符拼写或补 manifest）：${audit.undeclared
          .map((x) => x.key)
          .join("、")}`,
      );
    }
    if (audit.blankOptional.length > 0) {
      parts.push(
        `可选字段当前为空（如需可填写）：${audit.blankOptional
          .map((x) => x.label)
          .join("、")}`,
      );
    }
    return parts.join("\n");
  }, [audit]);

  const [pdfPicked, setPdfPicked] = useState<File | null>(null);
  const [pdfName, setPdfName] = useState("");
  const pdfInputRef = useRef<HTMLInputElement>(null);
  // hook 必须无条件调用（React 规则）；docId 缺失时这个 mutation 永远不会被触发
  const archive = useUploadTradeDocFile(docId ?? 0);
  const autoPdf = useArchiveRenderedPdf(docId ?? 0);
  // 对账用 mutation（**不会**在预览时自动请求，见 hook 注释）
  const fingerprintCheck = useCheckTradeDocRenderFingerprint(docId ?? 0);

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
    const label = (
      pdfName.trim() || defaultArchivePdfName(docNo, docType)
    ).trim();
    if (label.length > ARCHIVE_NAME_MAX_LEN) {
      toast.error(`名称最长 ${ARCHIVE_NAME_MAX_LEN} 个字符`);
      return;
    }
    try {
      await archive.mutateAsync({
        file: pdfPicked,
        role: "render_pdf",
        name: label,
      });
      // 文案与后端语义一致：旧件不是被物理删掉，而是挂 render_pdf_superseded 留档
      toast.success("已上传；再次上传会覆盖当前件，旧版留档");
      setPdfPicked(null);
      setPdfName("");
      if (pdfInputRef.current) pdfInputRef.current.value = "";
    } catch {
      toast.error("上传失败（类型/大小不合规时后端会明确拒绝）");
    }
  };

  /**
   * 自动出 PDF 并归档：把**预览用的同一份 HTML** 交给服务端，
   * 由 Cloudflare Browser Rendering 出字节后走同一套落档链路（版本让位、旧版留档）。
   *
   * 服务端未配置渲染器时后端返回 503 `PDF_RENDERER_NOT_CONFIGURED` ——
   * 这里**如实把后端的可执行提示给用户**（要开通/配置什么），
   * 绝不假装成功，也不静默降级；下方「上传本版 PDF」仍是随时可用的兜底。
   */
  const archiveAutoPdf = async () => {
    if (docId === undefined) return;
    const label = (
      pdfName.trim() || defaultArchivePdfName(docNo, docType)
    ).trim();
    try {
      const res = await autoPdf.mutateAsync({ html, name: label });
      const kb = Math.max(1, Math.round((res?.bytes ?? 0) / 1024));
      toast.success(
        `已自动生成并上传（${kb} KB，渲染器 ${res?.renderer ?? "?"}）；再次上传会覆盖当前件，旧版留档`,
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
      toast.error(
        `${message || "自动出 PDF 失败"}；可以用下方「上传本版 PDF」人工上传兜底`,
      );
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
        {/*
          字段体检（TODO(TODO:A3)）：把「会留空的地方」显式化。
          - 模板引用了未登记字段 = 占位符拼错/模板漏登记（代码问题，危险色提示）
          - 可选字段留空 = 业务可选，填不填由用户判断（只做提示，不拦签发）
        */}
        {blankHint && (
          <span
            className="cursor-help text-xs text-muted-foreground underline decoration-dotted underline-offset-2"
            title={blankHint}
          >
            {audit.undeclared.length > 0
              ? `模板字段未登记 ${audit.undeclared.length} 项`
              : ""}
            {audit.undeclared.length > 0 && audit.blankOptional.length > 0
              ? " · "
              : ""}
            {audit.blankOptional.length > 0
              ? `可选字段留空 ${audit.blankOptional.length} 项`
              : ""}
          </span>
        )}
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
              {autoPdf.isPending ? "生成中…" : "自动出 PDF 并上传"}
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

      {/*
        签发时冻结的渲染指纹（C 方案）：一行，`v1 · a1b2c3d4`。
        作用是事后可追溯 —— "这份归档 PDF 是用哪版渲染器、哪份数据出的"。
        没有这个键 = 还没签发过（草稿/历史单据）⇒ 整行不渲染。
      */}
      {renderMeta && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <p
            className="flex flex-wrap items-center gap-1"
            title={
              "渲染输入指纹（签发时冻结）\n" +
              `渲染版本：v${renderMeta.render_version ?? "?"}\n` +
              `输入 sha256：${renderMeta.input_sha256 ?? "未冻结（签发时装配失败）"}\n` +
              `冻结时刻：${renderMeta.frozen_at ?? "未知"}`
            }
          >
            <Fingerprint className="h-3 w-3" />
            <span>渲染指纹 v{renderMeta.render_version ?? "?"} ·</span>
            <span className="font-mono">
              {renderMeta.input_sha256
                ? renderMeta.input_sha256.slice(0, 8)
                : "未冻结"}
            </span>
          </p>

          {/*
            对账入口：**用户点了才查**（`useMutation`，预览时不自动拉）——
            对账要重新装配一遍渲染输入，有成本；而且它回答的是按需问题。
          */}
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-xs"
            disabled={fingerprintCheck.isPending}
            onClick={() => fingerprintCheck.mutate()}
          >
            <RefreshCw className="mr-1 h-3 w-3" />
            {fingerprintCheck.isPending ? "核对中…" : "核对指纹"}
          </Button>

          {/*
            只在"这一次核对成功"时显示结论：**失败或正在重查时都不显示**旧结论 ——
            否则第二次核对失败后，界面会同时挂着上一次的"一致"，等于把过期结论当现状。
          */}
          {fingerprintCheck.data &&
            !fingerprintCheck.isPending &&
            !fingerprintCheck.isError && (
              <span
                className={
                  VERDICT_TONE_CLASS[
                    fingerprintVerdict(fingerprintCheck.data).tone
                  ]
                }
              >
                {fingerprintVerdict(fingerprintCheck.data).text}
              </span>
            )}
          {/*
            失败（404/500/网络）**不能**显示成"已变更"或"一致" —— 那是把"没查成"
            说成了结论。只说失败，并让按钮可以再点一次（mutation 重新触发即可重试）。
          */}
          {fingerprintCheck.isError && (
            <span className="text-warning">核对失败，请重试</span>
          )}
        </div>
      )}

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
            <span className="text-sm font-medium">上传本版 PDF</span>
            <span className="text-xs text-muted-foreground">
              在「打印 / 导出 PDF」里选「另存为 PDF」，把导出的那份选回来 ——
              存的就是客户看到的那一版；再次上传会覆盖当前件，旧版留档（不删除）。
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
                上传名称（可留空，默认用单证号）
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
              {archive.isPending ? "上传中…" : "上传本版 PDF"}
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
