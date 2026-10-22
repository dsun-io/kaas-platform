/**
 * 订单附件 / 到账截图（§13.3）—— 上传前的前端规则与 FormData 组装。
 *
 * 后端口径（backend-money 2026-10-22 确认）：
 * - `POST /orders/{id}/files`（multipart）：file 必填、name 可选；**kind 恒为 "other"**，
 *   附件类别（合同/PO/信用证）编码进 name，后端不再区分用途；
 * - `POST /payment-receipts/{id}/files`（multipart）：file 必填，
 *   允许 PNG/JPG/PDF 且 ≤ 16MB；成功后自动把 `payment_receipts.file_id` 指到最新文件；
 * - 取图统一走 `GET /file-objects/{fileId}/content`（带 Bearer，已有用法）。
 */
export interface OrderAttachmentKind {
  value: string;
  label: string;
}

export const ORDER_ATTACHMENT_KINDS: OrderAttachmentKind[] = [
  { value: "contract", label: "合同" },
  { value: "po", label: "PO / 客户订单" },
  { value: "lc", label: "信用证" },
  { value: "other", label: "其他单证" },
];

/** 订单附件的接收类型（设计稿：PDF、JPG、PNG） */
export const ORDER_ATTACHMENT_ACCEPT = ".pdf,.jpg,.jpeg,.png";
/** 到账截图接收类型（后端 ≤ 16MB；前端按同一上限先拦） */
export const RECEIPT_IMAGE_ACCEPT = ".pdf,.jpg,.jpeg,.png";
export const RECEIPT_FILE_MAX_BYTES = 16 * 1024 * 1024;
export const ORDER_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;

const ALLOWED_MIME = ["application/pdf", "image/jpeg", "image/png"];

/** 附件类别 → 中文标签（未知值原样返回，历史数据不丢）。 */
export function attachmentKindLabel(kind: string | null | undefined): string {
  if (!kind) return "附件";
  return (
    ORDER_ATTACHMENT_KINDS.find((item) => item.value === kind)?.label ?? kind
  );
}

/**
 * 从文件名反推附件类别：上传时把类别写进 name（`合同 · xxx.pdf`），
 * 列表读回来就能显示类别；用户自定义名称后仍以 name 为准。
 */
export function attachmentKindFromName(name: string): string {
  const matched = ORDER_ATTACHMENT_KINDS.find((item) =>
    name.startsWith(`${item.label} · `),
  );
  return matched?.value ?? "other";
}

/** 上传时的展示名：类别前缀 + 用户命名（缺省用文件名）。 */
export function attachmentDisplayName(
  kind: string,
  customName: string,
  fileName: string,
): string {
  const label = attachmentKindLabel(kind);
  const base = customName.trim() || fileName;
  return `${label} · ${base}`;
}

/** 文件类型/大小校验；返回 null = 可上传，否则是人话原因。 */
export function validateAttachmentFile(
  file: Pick<File, "name" | "type" | "size">,
  options: { maxBytes?: number } = {},
): string | null {
  const maxBytes = options.maxBytes ?? ORDER_ATTACHMENT_MAX_BYTES;
  const type = (file.type || "").toLowerCase();
  const lower = file.name.toLowerCase();
  const typeOk =
    ALLOWED_MIME.includes(type) ||
    lower.endsWith(".pdf") ||
    lower.endsWith(".jpg") ||
    lower.endsWith(".jpeg") ||
    lower.endsWith(".png");
  if (!typeOk) {
    return "只支持 PDF / JPG / PNG 文件";
  }
  if (file.size > maxBytes) {
    return `文件太大（${formatFileSize(file.size)}），请控制在 ${formatFileSize(
      maxBytes,
    )} 以内`;
  }
  return null;
}

/** 到账截图校验：类型同上、上限 16MB。 */
export function validateReceiptFile(
  file: Pick<File, "name" | "type" | "size">,
): string | null {
  return validateAttachmentFile(file, { maxBytes: RECEIPT_FILE_MAX_BYTES });
}

/** 组订单附件 multipart（不传 kind：后端只接受 other，传别的会 422）。 */
export function buildOrderAttachmentForm(
  file: File,
  name: string,
): FormData {
  const form = new FormData();
  form.append("file", file);
  if (name.trim()) form.append("name", name.trim());
  return form;
}

/** 组到账截图 multipart（字段名固定 file）。 */
export function buildReceiptFileForm(file: File): FormData {
  const form = new FormData();
  form.append("file", file);
  return form;
}

/** 人类可读的文件大小。 */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
