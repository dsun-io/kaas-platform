/**
 * 情报货运 CSV 导入的纯函数（C36 #15）。
 *
 * 契约：`POST /api/v1/intel/import/csv`（`backend/worker/src/main.py:1005`）是 **multipart**，
 * 文件字段名固定 `file`（`file: UploadFile = File(...)`，名字不对 ⇒ 422）。
 * 后端**内置固定列映射**（英文/中文别名 → canonical 字段，见 `main.py` 的 `col_map`），
 * 没有"自定义列映射"参数；所以前端做的是「识别 + 预览 + 预报必填缺失」，
 * 不做假的下拉映射控件（那会让人以为能改，其实后端不读）。
 *
 * 返回 `{status, processed, inserted, errors, error_details?}`（`error_details` 最多 10 条，
 * 每条 `{row, error}`）；逐行失败不会中断整批。
 */
import { normalizeApiError } from "@/lib/api/api-error";

/** multipart 字段名：与后端 `file: UploadFile = File(...)` 逐字一致 */
export const INTEL_CSV_FIELD = "file";

/** 后端 kick 掉整行的三个必填 canonical 字段 */
export const INTEL_CSV_REQUIRED = ["shipper", "consignee", "product_desc"] as const;

/**
 * 列别名 → canonical 字段（**逐字镜像** `main.py:1013-1029` 的 `col_map`）。
 * 键统一用小写；中文键原样（中文没有大小写）。
 */
export const INTEL_CSV_COLUMN_ALIASES: Readonly<Record<string, string>> = {
  shipper: "shipper",
  发货人: "shipper",
  exporter: "shipper",
  consignee: "consignee",
  收货人: "consignee",
  importer: "consignee",
  product_desc: "product_desc",
  产品描述: "product_desc",
  产品: "product_desc",
  goods: "product_desc",
  ship_date: "ship_date",
  日期: "ship_date",
  date: "ship_date",
  dest_country: "dest_country",
  目的国: "dest_country",
  destination: "dest_country",
  origin_country: "origin_country",
  原产国: "origin_country",
  hs_code: "hs_code",
  hs编码: "hs_code",
  qty: "qty",
  数量: "qty",
  qty_unit: "qty_unit",
  单位: "qty_unit",
  carrier: "carrier",
  承运人: "carrier",
  bl_no: "bl_no",
  提单号: "bl_no",
};

export interface IntelCsvColumn {
  raw: string;
  /** canonical 字段；`null` = 后端不认识（会被忽略，不报错） */
  field: string | null;
}

export interface IntelCsvRowPreview {
  /** CSV 行号（表头是第 1 行，数据从 2 开始） */
  row: number;
  values: Record<string, string>;
}

export interface IntelCsvAnalysis {
  /** 能进入"确认导入"（表头可解析且至少识别出一列） */
  ok: boolean;
  error?: string;
  columns: IntelCsvColumn[];
  /** 后端必填而表头缺失的字段（为真时后端会逐行报错，不建议上传） */
  missingRequired: string[];
  /** 后端不认识的列（预览里标注，不阻塞） */
  unknownColumns: string[];
  /** 前 N 行预览（canonical 字段 → 值；行号从 2 开始） */
  preview: IntelCsvRowPreview[];
  /** 数据行数（不含表头；空行不计） */
  totalRows: number;
}

export interface IntelCsvImportResult {
  status: string;
  processed: number;
  inserted: number;
  errors: number;
  error_details?: Array<{ row?: number; error?: string }>;
}

/** 极简 CSV 解析：支持引号包裹、字段内逗号/换行、`""` 转义、CRLF、BOM。 */
export function parseIntelCsv(text: string): {
  header: string[];
  rows: string[][];
} {
  const src = text.replace(/^\uFEFF/, "");
  const records: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      records.push(row);
      row = [];
      field = "";
    } else if (ch === "\r") {
      // \r\n 由 \n 分支处理；孤立的 \r 也当换行
      if (src[i + 1] !== "\n") {
        row.push(field);
        records.push(row);
        row = [];
        field = "";
      }
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    records.push(row);
  }

  const nonEmpty = records.filter((cells) =>
    cells.some((cell) => cell.trim() !== ""),
  );
  const header = (nonEmpty[0] ?? []).map((cell) => cell.trim());
  const rows = nonEmpty.slice(1).map((cells) =>
    header.map((_, idx) => (cells[idx] ?? "").trim()),
  );
  return { header, rows };
}

function mapHeader(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return (
    INTEL_CSV_COLUMN_ALIASES[trimmed.toLowerCase()] ??
    INTEL_CSV_COLUMN_ALIASES[trimmed] ??
    null
  );
}

/**
 * 解析 CSV 文本 → 列映射 + 必填缺失 + 前 N 行预览。
 * 纯函数、不抛（坏 CSV 也只返回 `ok:false` + 中文原因）。
 */
export function analyzeIntelCsv(
  text: string,
  options: { previewRows?: number } = {},
): IntelCsvAnalysis {
  const previewRows = options.previewRows ?? 5;
  const { header, rows } = parseIntelCsv(text ?? "");
  if (header.length === 0 || header.every((cell) => cell === "")) {
    return {
      ok: false,
      error: "CSV 没有表头（第一行应为列名）",
      columns: [],
      missingRequired: [...INTEL_CSV_REQUIRED],
      unknownColumns: [],
      preview: [],
      totalRows: 0,
    };
  }

  const columns: IntelCsvColumn[] = header.map((raw) => ({
    raw,
    field: mapHeader(raw),
  }));
  const unknownColumns = columns
    .filter((column) => column.field === null && column.raw !== "")
    .map((column) => column.raw);
  const knownCount = columns.filter((column) => column.field !== null).length;
  if (knownCount === 0) {
    return {
      ok: false,
      error:
        "未识别到任何已知列；需要 shipper/consignee/product_desc（或中文表头：发货人/收货人/产品描述）",
      columns,
      missingRequired: [...INTEL_CSV_REQUIRED],
      unknownColumns,
      preview: [],
      totalRows: rows.length,
    };
  }

  const missingRequired = INTEL_CSV_REQUIRED.filter(
    (field) => !columns.some((column) => column.field === field),
  );
  const preview = rows.slice(0, previewRows).map((cells, index) => {
    const values: Record<string, string> = {};
    columns.forEach((column, columnIndex) => {
      if (!column.field) return;
      values[column.field] = cells[columnIndex] ?? "";
    });
    return { row: index + 2, values };
  });

  return {
    ok: true,
    columns,
    missingRequired: [...missingRequired],
    unknownColumns,
    preview,
    totalRows: rows.length,
  };
}

/** 本地预检：只拦"一定失败"的输入，不发请求（后端没有声明大小上限，这里不编一个）。 */
export function validateIntelCsvFile(file: File | null): string | null {
  if (!file) return "请选择要导入的 CSV 文件";
  if (!file.name.trim().toLowerCase().endsWith(".csv")) {
    return "只支持 .csv 文件（xlsx 请先另存为 CSV）";
  }
  if (file.size === 0) return "CSV 文件是空的，请检查后重新导出";
  return null;
}

/** 构造 multipart 请求体（字段名固定 `file`）。 */
export function buildIntelCsvForm(file: File): FormData {
  const form = new FormData();
  form.append(INTEL_CSV_FIELD, file, file.name);
  return form;
}

/** 导入失败原因（422/403/网络）—— 后端 message/detail 原样给人看。 */
export function intelImportErrorMessage(error: unknown): string {
  return normalizeApiError(error).message;
}
