/**
 * 产品图上传的前端预校验（纯函数）—— 口径**对齐后端**
 * `backend/kaas_common/files/rules.py`：
 *  · `KIND_MIME["product_photo"]` = png / jpeg / webp
 *  · `MAX_BYTES["product_photo"]` = 8 MB
 *  · 名称必填、最长 80 字符
 *
 * 为什么前端要再校验一遍（后端明明会拒）：
 * 后端拒绝要等一个完整往返（大图上传完才 422），用户白等且错误只在 toast 里一闪；
 * 这里在**入队时**就拦住，把「哪个文件、为什么不行」贴在那一行上。
 *
 * 为什么不在这里做压缩/转码：产品图要保真（尺寸图上的标注文字是业务信息），
 * 静默转码会让用户以为传上去的就是原图。超限就明说，让用户自己处理。
 */

export const MEDIA_MIME = ["image/png", "image/jpeg", "image/webp"] as const;
export type MediaMime = (typeof MEDIA_MIME)[number];

/** `<input accept>` 用 */
export const MEDIA_ACCEPT = MEDIA_MIME.join(",");

/** 8 MB —— 与后端 `MAX_BYTES["product_photo"]` 保持一致，改一处必须改两处 */
export const MEDIA_MAX_BYTES = 8 * 1024 * 1024;

/** 名称上限 —— 后端 `NAME_TOO_LONG` 是 80 */
export const MEDIA_NAME_MAX = 80;

const EXT_TO_MIME: Record<string, MediaMime> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

export interface MediaFileLike {
  name: string;
  type: string;
  size: number;
}

export type MediaReject = {
  code: "BAD_CONTENT_TYPE" | "FILE_TOO_LARGE" | "BAD_SIZE";
  /** 直接给用户看的一句话（含实际值，别只说"不合法"） */
  message: string;
};

/** 人类可读的大小（1.2 MB / 340 KB） */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 取可信的 content-type：浏览器给空（某些系统/截图工具会）时按扩展名兜底。
 *
 * 为什么重要：后端按 `content_type` 判类型；空类型会被 `BAD_CONTENT_TYPE` 拒。
 * 上传时也用这个值（见 `useUploadProductMedia` 的 `contentType` 入参），
 * 否则会出现「前端校验过了、后端还是拒」的割裂。
 */
export function resolveMediaContentType(file: MediaFileLike): MediaMime | null {
  const declared = file.type.split(";")[0]?.trim().toLowerCase();
  if (declared && (MEDIA_MIME as readonly string[]).includes(declared)) {
    return declared as MediaMime;
  }
  const dot = file.name.lastIndexOf(".");
  const ext = dot >= 0 ? file.name.slice(dot + 1) : "";
  return EXT_TO_MIME[ext.toLowerCase()] ?? null;
}

/** 默认名称 = 文件名去掉扩展名（截到 80 字符），用户可改 */
export function defaultMediaName(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, "").trim();
  return (base || "未命名图片").slice(0, MEDIA_NAME_MAX);
}

/**
 * 校验一个待上传文件；通过返回 `null`，不通过返回可执行原因。
 *
 * 顺序：空文件 → 类型 → 大小（先给最根本的问题，避免"类型对了但还是传不上去"）。
 */
export function validateMediaFile(file: MediaFileLike): MediaReject | null {
  if (!file.size || file.size <= 0) {
    return { code: "BAD_SIZE", message: "文件是空的（0 字节），换一张试试" };
  }
  if (!resolveMediaContentType(file)) {
    const actual = file.type || "未知类型";
    return {
      code: "BAD_CONTENT_TYPE",
      message: `只支持 PNG / JPG / WebP（这个是 ${actual}）`,
    };
  }
  if (file.size > MEDIA_MAX_BYTES) {
    return {
      code: "FILE_TOO_LARGE",
      message: `超过 ${formatBytes(MEDIA_MAX_BYTES)}（这个是 ${formatBytes(file.size)}）`,
    };
  }
  return null;
}

/** 名称校验（队列里手改后可能超长/清空） */
export function validateMediaName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "给图片起个名字，单证引用时能认出来";
  if (trimmed.length > MEDIA_NAME_MAX) return `名称最长 ${MEDIA_NAME_MAX} 个字符`;
  return null;
}
