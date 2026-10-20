/**
 * 导出后自检的**前端抽取层**（C21）：PDF 文本 + 图片计数 + 要核对的文本清单。
 *
 * 职责边界（重要）
 * ----------------
 * - **前端只抽事实**：从用户导出的 PDF 里抽文本、数图片；从"这份单据的渲染数据"
 *   里算出应该有哪些文本、应该有几张图。抽取结果是**原始材料**。
 * - **裁决只在后端**：`POST /trade-docs/{id}/verify-export`
 *   （`backend/worker/src/ws_docs_hardening.py`）做 "文本 ⊆ PDF、图片计数相符" 的判定，
 *   默认 422 阻断、`allow_override` 才放行并落审计。本模块**绝不**自己判 PASS/FAIL，
 *   也不在 UI 上伪造"通过"。
 *
 * pdf.js 为什么必须动态 import
 * ---------------------------
 * `pdfjs-dist` 的浏览器构建 ≈ 459 KB（gzip ≈ 132 KB）+ worker ≈ 1.26 MB（gzip ≈ 374 KB）。
 * 只有用户真的点「自检」才需要它 ⇒ 这里用 `await import("pdfjs-dist")`，
 * 让它进**异步 chunk**，绝不进首屏包（首屏影响 = 0）。
 *
 * 图片计数口径（与后端入参的对应关系）
 * ----------------------------------
 * 后端默认期望 `{"stamp": 1}`（"一份单证的公章恰好 1 张"），但 PDF 抽取无法把
 * "公章"和"产品图"从语义上区分开。本系统的单证里**只可能有两种图**：
 * 公章（`company_stamp`，至多 1 张）与产品图（`product_photos`，N 张），
 * 且两者的期望值都能从渲染数据（服务器装配的真值）直接算出 ⇒
 *   · `expected_image_counts.stamp` 提交 = 渲染数据里**公章**的期望张数（0/1）；
 *   · `image_counts.stamp`          提交 = 抽取总数 − 渲染数据里**产品图**张数
 *                                        （即"非产品图的图片数"，只可能是公章）。
 * 两者相等 ⟺ "PDF 里的图片总数 == 这份渲染数据应该渲染的图片总数"，
 * 仍由后端做相等裁决。口径写在 `docs/TRADE_DOC_HARDENING.md` 的「导出后自检 UI」一节。
 */
import type { VerifyExportRequest } from "./hardening";
import { safeImageSrc } from "./render";

/** 与内核 `MAX_BYTES['render_pdf']`（32MB）一致：单份归档件上限。 */
export const PDF_SELF_CHECK_MAX_BYTES = 32 * 1024 * 1024;

export type PdfExtractErrorCode =
  | "NOT_PDF"
  | "ENCRYPTED"
  | "TOO_LARGE"
  | "EXTRACT_FAILED";

/** PDF 抽取失败（**不是**自检失败：还没到后端裁决那一步）。 */
export class PdfExtractError extends Error {
  readonly code: PdfExtractErrorCode;

  constructor(code: PdfExtractErrorCode, message: string) {
    super(message);
    this.name = "PdfExtractError";
    this.code = code;
  }
}

export interface PdfFacts {
  pageCount: number;
  /** PDF 里画了几次图片（同一张图跨页重复绘制会各算一次 —— 这正是"公章劈页"的信号） */
  imageCount: number;
  /** 抽取出的整份文本（后端按"去掉全部空白"比对） */
  text: string;
}

type PdfjsModule = typeof import("pdfjs-dist");

/**
 * 配置 pdf.js 的 worker 地址（幂等：已设置就不覆盖）。
 *
 * `new URL(..., import.meta.url)` 交给打包器（webpack / Turbopack）把 worker 作为
 * 静态资源发射 —— 这是 Next.js + pdf.js 的通行写法。**若打包器不支持该形式**，
 * workerSrc 会保持为空，`getDocument` 会抛错 ⇒ 面板如实显示"解析失败"，
 * 不会退化成假成功。生产构建时的 worker 资产是否发射需在发布检查单里复核
 * （本任务按约定未跑 build）。
 */
export function configurePdfWorker(pdfjs: PdfjsModule): void {
  if (pdfjs.GlobalWorkerOptions.workerSrc) return;
  try {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL(
      "pdfjs-dist/build/pdf.worker.min.mjs",
      import.meta.url,
    ).toString();
  } catch {
    // 保留空值：让 getDocument 明确报错，由调用方展示为"解析失败"
  }
}

/** 计为"一张图"的绘制操作（遮罩/纯色填充不算内容图片，避免装饰被误计）。 */
function contentImageOps(pdfjs: PdfjsModule): Set<number> {
  const ops = pdfjs.OPS as Record<string, number | undefined>;
  const names = [
    "paintImageXObject",
    "paintInlineImageXObject",
    "paintImageXObjectRepeat",
  ];
  const set = new Set<number>();
  for (const name of names) {
    const value = ops[name];
    if (typeof value === "number") set.add(value);
  }
  return set;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 抽取 PDF 的事实（文本 / 图片计数 / 页数）。
 *
 * 失败时抛 `PdfExtractError`（NOT_PDF / ENCRYPTED / TOO_LARGE / EXTRACT_FAILED）——
 * 调用方必须显示"解析失败"，**不得**继续调用后端、更不得显示通过。
 */
export async function extractPdfFacts(
  bytes: ArrayBuffer,
  opts: { maxBytes?: number } = {},
): Promise<PdfFacts> {
  const maxBytes = opts.maxBytes ?? PDF_SELF_CHECK_MAX_BYTES;
  if (!bytes || bytes.byteLength === 0) {
    throw new PdfExtractError("NOT_PDF", "PDF 文件是空的");
  }
  if (bytes.byteLength > maxBytes) {
    throw new PdfExtractError(
      "TOO_LARGE",
      `PDF 超过 ${Math.round(maxBytes / 1048576)}MB 上限，请检查是否选错了文件`,
    );
  }

  const pdfjs = await import("pdfjs-dist");
  configurePdfWorker(pdfjs);

  // v6：清理/销毁走 loadingTask（PDFDocumentProxy 上已没有 destroy()）
  const loadingTask = pdfjs.getDocument({
    // pdf.js 会接管/转移 buffer：给副本，避免影响调用方（File 的 ArrayBuffer 只能读一次）
    data: new Uint8Array(bytes.slice(0)),
    useSystemFonts: true,
    disableAutoFetch: true,
  });
  let doc: Awaited<typeof loadingTask.promise>;
  try {
    doc = await loadingTask.promise;
  } catch (err) {
    const name = (err as { name?: string } | null)?.name ?? "";
    if (name === "PasswordException") {
      throw new PdfExtractError("ENCRYPTED", "PDF 有密码保护，无法抽取文本");
    }
    if (name === "InvalidPDFException") {
      throw new PdfExtractError("NOT_PDF", "文件不是有效的 PDF");
    }
    throw new PdfExtractError("EXTRACT_FAILED", `PDF 解析失败：${errorMessage(err)}`);
  }

  try {
    const imageOps = contentImageOps(pdfjs);
    const chunks: string[] = [];
    let imageCount = 0;
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      const textContent = await page.getTextContent();
      for (const item of textContent.items) {
        const text = (item as { str?: unknown }).str;
        if (typeof text === "string") chunks.push(text);
      }
      // 页间补一个换行：只为可读性，后端会按"去空白"比对
      chunks.push("\n");
      const ops = await page.getOperatorList();
      for (const fn of ops.fnArray) {
        if (imageOps.has(fn)) imageCount += 1;
      }
      page.cleanup();
    }
    return { pageCount: doc.numPages, imageCount, text: chunks.join("") };
  } catch (err) {
    throw new PdfExtractError("EXTRACT_FAILED", `PDF 解析失败：${errorMessage(err)}`);
  } finally {
    await loadingTask.destroy();
  }
}

// ── 要核对的文本：从"与预览同源"的渲染 HTML 里取 ─────────────────────────────

/** 段落级元素：这些元素的 `textContent` 就是用户会在 PDF 上看到的一整块文字。 */
const BLOCK_SELECTOR =
  "td,th,h1,h2,h3,h4,h5,h6,p,li,dt,dd,caption,figcaption,blockquote,label,button";

/**
 * 从渲染 HTML 里抽出"应当出现在 PDF 里"的文本清单。
 *
 * 用**渲染后的 HTML**（`renderTradeDoc(docType, data)`）而不是原始数据：
 * 单据上写的是格式化后的字符串（千分位、金额大写、日期格式…），拿原始数字去比对
 * 会整批假报警。按段落元素取 `textContent`，去掉空白后去重。
 */
export function collectDocTexts(html: string): string[] {
  if (typeof DOMParser === "undefined") return [];
  const parsed = new DOMParser().parseFromString(html, "text/html");
  parsed.querySelectorAll("style,script,noscript,template").forEach((el) => {
    el.remove();
  });
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (raw: string): void => {
    const text = raw.replace(/\s+/g, " ").trim();
    if (!text) return;
    if (seen.has(text)) return;
    seen.add(text);
    out.push(text);
  };
  parsed.querySelectorAll(BLOCK_SELECTOR).forEach((el) => {
    push(el.textContent ?? "");
  });
  // 模板外的散文本（极少见）：兜底取 body 整段，避免"一个字都没抽到"导致空跑
  if (out.length === 0 && parsed.body) push(parsed.body.textContent ?? "");
  return out;
}

// ── 期望图片数：从渲染数据（服务器装配的真值）算 ─────────────────────────────

export interface ExpectedImages {
  /** 产品图张数（`product_photos` 里能真正渲染的那些） */
  photos: number;
  /** 公章张数（`company_stamp` 能渲染则为 1） */
  stamp: number;
  /** 这份单据总共应该出现几张图 */
  total: number;
}

/**
 * 从 `render-data` 的 `data` 里算期望图片数。
 *
 * 只认会真正渲染出来的图（与 `render.ts` 的 `safeImageSrc` 同一白名单）：
 * 白名单挡掉的数据 URI/相对路径不会生成 `<img>`，不能算进期望值。
 */
export function expectedImageCounts(
  data: Record<string, unknown>,
): ExpectedImages {
  const photosRaw = data["product_photos"];
  const photos = Array.isArray(photosRaw)
    ? photosRaw.filter((entry) => {
        if (typeof entry !== "object" || entry === null) return false;
        const record = entry as Record<string, unknown>;
        return safeImageSrc(record["image"] ?? record["src"]) !== "";
      }).length
    : 0;
  const stamp = safeImageSrc(data["company_stamp"]) !== "" ? 1 : 0;
  return { photos, stamp, total: photos + stamp };
}

/**
 * 组装 `verify-export` 的请求体（**只组装事实，不裁决**）。
 *
 * 图片计数的翻译见模块头注释：后端只认 `stamp` 这个 key，提交的是
 * "非产品图图片数"（= 抽取总数 − 期望产品图数），期望值 = 渲染数据里的公章数。
 */
export function buildVerifyExportRequest(input: {
  pdfText: string;
  texts: string[];
  imageCount: number;
  expected: ExpectedImages;
}): VerifyExportRequest {
  const stampDetected = Math.max(0, input.imageCount - input.expected.photos);
  return {
    texts: input.texts,
    pdf_text: input.pdfText,
    image_counts: { stamp: stampDetected },
    expected_image_counts: { stamp: input.expected.stamp },
    // allow_override **不提交**：越过自检是管理员/留痕动作，普通 UI 不提供入口
    // （后端若回 422 就如实展示阻断项，不在这里"替用户决定"）。
  };
}
