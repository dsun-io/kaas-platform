/**
 * 已有单证导入（外部单证台账）—— §13.3 追加需求。
 *
 * 与「订单附件」的区别（用户口径，两者分开展示）：
 * - **导入已有单证**：客户/第三方已经开好的单据（合同、PO、发票、装箱单、原产地证…），
 *   上传后进 `external_doc_uploads` 台账（draft/issued/void 状态机），可从详情下载；
 * - **订单附件**：随单文件（合同/PO/信用证扫描件），走 `file_objects`，
 *   是建单资料，不进单证台账。
 *
 * 后端契约（`backend/worker/src/ws_extras.py`，ts-worker 透传）：
 * - `POST /api/v1/external-docs` multipart：file 必填（≤20MB）、doc_type、
 *   order_id、customer_id（都可选）、notes；→ 201 `{id, file_name}`；
 * - `GET /api/v1/external-docs?order_id={id}` → **数组**（不是 {items}）；
 *   每项：id/doc_type/file_name/content_type/file_size/order_id/customer_id/
 *   status/notes/uploaded_by/created_at；
 * - `GET /api/v1/external-docs/{id}/download` → 二进制（Content-Disposition 文件名）。
 */
import { formatFileSize } from "./order-attachments";

export interface ExternalDocType {
  value: string;
  label: string;
}

/**
 * 单证类型白名单：值与后端 DOC_TYPE 枚举对齐（contract/ci/pl/co/other），
 * PO 用 `po`（外部单证 doc_type 是自由文本，后端不拒绝）。
 */
export const EXTERNAL_DOC_TYPES: ExternalDocType[] = [
  { value: "contract", label: "合同" },
  { value: "po", label: "采购订单 PO" },
  { value: "ci", label: "发票" },
  { value: "pl", label: "装箱单" },
  { value: "co", label: "原产地证" },
  { value: "other", label: "其他" },
];

/** 常见系统单证类型的中文名（历史/外部数据可能带别的 doc_type，尽量翻成人话）。 */
const DOC_TYPE_LABELS: Record<string, string> = {
  contract: "合同",
  po: "采购订单 PO",
  pi: "形式发票",
  ci: "发票",
  pl: "装箱单",
  co: "原产地证",
  bl: "提单",
  insurance: "保险单",
  customs_declaration: "报关单",
  other: "其他",
};

export function externalDocTypeLabel(type: string | null | undefined): string {
  if (!type) return "未分类";
  return DOC_TYPE_LABELS[type] ?? type;
}

/** 导入的单证以 PDF/图片/Office 文档为主（后端不限制类型，前端只拦明显的乱文件）。 */
export const EXTERNAL_DOC_ACCEPT =
  ".pdf,.jpg,.jpeg,.png,.doc,.docx,.xls,.xlsx";
export const EXTERNAL_DOC_MAX_BYTES = 20 * 1024 * 1024;

const ALLOWED_EXTENSIONS = [
  ".pdf",
  ".jpg",
  ".jpeg",
  ".png",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
];

const ALLOWED_MIME_PREFIXES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "application/msword",
  "application/vnd.openxmlformats-officedocument",
  "application/vnd.ms-excel",
];

/** 文件类型/大小校验；返回 null = 可上传，否则是人话原因。 */
export function validateExternalDocFile(
  file: Pick<File, "name" | "type" | "size">,
): string | null {
  const lower = file.name.toLowerCase();
  const type = (file.type || "").toLowerCase();
  const extOk = ALLOWED_EXTENSIONS.some((ext) => lower.endsWith(ext));
  const mimeOk = ALLOWED_MIME_PREFIXES.some((prefix) => type.startsWith(prefix));
  if (!extOk && !mimeOk) {
    return "支持 PDF / JPG / PNG / Word / Excel 单证文件";
  }
  if (file.size > EXTERNAL_DOC_MAX_BYTES) {
    return `文件太大（${formatFileSize(file.size)}），请控制在 20MB 以内`;
  }
  return null;
}

/** `GET /external-docs?order_id=` 返回的台账行。 */
export interface ExternalDoc {
  id: number;
  doc_type: string | null;
  file_name: string;
  content_type: string | null;
  file_size: number | null;
  order_id: number | null;
  quote_order_id?: number | null;
  inquiry_id?: number | null;
  customer_id?: string | number | null;
  status?: string | null;
  notes: string | null;
  uploaded_by?: string | null;
  created_at: string | null;
}

export interface ExternalDocUploadInput {
  file: File;
  doc_type: string;
  order_id: number;
  customer_id?: number | string | null;
  notes?: string;
}

/**
 * 组 `POST /external-docs` 的 multipart。
 * 只 append 有值的可选字段 —— 空字符串会被后端当成真实的空 customer_id。
 */
export function buildExternalDocForm(input: ExternalDocUploadInput): FormData {
  const form = new FormData();
  form.append("file", input.file);
  form.append("doc_type", input.doc_type);
  form.append("order_id", String(input.order_id));
  if (
    input.customer_id !== undefined &&
    input.customer_id !== null &&
    String(input.customer_id).trim() !== ""
  ) {
    form.append("customer_id", String(input.customer_id));
  }
  if ((input.notes ?? "").trim()) form.append("notes", input.notes!.trim());
  return form;
}

/** 列表接口兼容：worker 返回数组；若某层包装成 {items} 也认。 */
export function normalizeExternalDocList(
  data: ExternalDoc[] | { items: ExternalDoc[] } | null | undefined,
): ExternalDoc[] {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.items)) return data.items;
  return [];
}

/** 单证大小展示（未知返回「—」）。 */
export function formatExternalDocSize(size: number | null | undefined): string {
  if (typeof size !== "number" || !Number.isFinite(size)) return "—";
  return formatFileSize(size);
}
