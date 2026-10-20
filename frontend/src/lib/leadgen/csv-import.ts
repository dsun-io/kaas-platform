/**
 * Leadgen CSV 导入的纯函数（C36 #17）—— 与页面解耦，便于单测。
 *
 * 契约：`POST /api/v1/leadgen/runs/from-csv`（`backend/worker/src/chain.py:1003`）
 * 是 **multipart**，文件字段名固定 `csv_file`（`UploadFile = File(...)`，名字不对 ⇒ 422）。
 * 返回 run 对象（`{id, status, leads_found, leads_kept, deduplicated?, error?}`）——
 * 注意与 `POST /leadgen/runs`（JSON）不同：这里 region/industry/quantity 由后端固定，
 * 文件名会进 config.filename 供审计。
 */
import { normalizeApiError } from "@/lib/api/api-error";

/** multipart 字段名：与后端 `csv_file: UploadFile = File(...)` 逐字一致 */
export const LEADGEN_CSV_FIELD = "csv_file";

/**
 * 本地预检：只拦"一定失败"的输入，不发请求。
 *
 * - 未选文件 ⇒ 提示选择；
 * - 扩展名不是 `.csv` ⇒ 提示（后端按文本解析，xlsx 传上去只会得到 0 条线索/乱码，
 *   与其让用户等一次失败，不如当场说清）；
 * - 空文件 ⇒ 提示（0 字节 CSV 没有任何表头/线索）。
 *
 * **不做大小上限**：后端该端点没有声明上限，前端凭空加一个阈值会变成"莫名拒绝"。
 */
export function validateLeadgenCsvFile(file: File | null): string | null {
  if (!file) return "请选择要导入的 CSV 文件";
  const name = file.name.trim().toLowerCase();
  if (!name.endsWith(".csv")) return "只支持 .csv 文件（xlsx 请先另存为 CSV）";
  if (file.size === 0) return "CSV 文件是空的，请检查后重新导出";
  return null;
}

/** 构造 multipart 请求体（字段名固定 `csv_file`）。 */
export function buildLeadgenCsvForm(file: File): FormData {
  const form = new FormData();
  form.append(LEADGEN_CSV_FIELD, file, file.name);
  return form;
}

/** 导入失败的原因（402 订阅 / 422 校验 / 网络错误），给人看的中文/后端原文。 */
export function leadgenImportErrorMessage(error: unknown): string {
  return normalizeApiError(error).message;
}
