/**
 * 表格批量导入的前端纯逻辑：拼表单、下模板、摘要、结果导出。
 *
 * 抽出来单独放，是因为这些是**可测的规则**，不该埋在 JSX 里：
 *   · 模板下载地址怎么拼（必须与后端路由一致，改一处不能漏另一处）
 *   · 上传用 multipart，必须清掉实例默认的 application/json
 *     —— axios 见到 JSON 默认头会把 FormData 转成 JSON，文件就传丢了
 *   · 结果表的摘要口径（行数/总净重/总售价/美元）要能独立核对
 */
import type {
  ImportIssue,
  ImportPreviewResponse,
  ImportCalculateResponse,
  ImportTemplateFormat,
} from "@contracts/export-quote";

export const EXPORT_QUOTE_BASE = "/export-quote";

/** 模板下载地址。后端路由：GET /import/template?product_key=…&format=… */
export function templateUrl(
  productKey: string,
  format: ImportTemplateFormat,
  extra: Record<string, string | number> = {},
): string {
  const params = new URLSearchParams({
    product_key: productKey,
    format,
    ...Object.fromEntries(
      Object.entries(extra).map(([k, v]) => [k, String(v)]),
    ),
  });
  return `${EXPORT_QUOTE_BASE}/import/template?${params.toString()}`;
}

/** 模板文件名。与后端 Content-Disposition 的口径一致，仅作兜底。 */
export function templateFilename(
  productKey: string,
  format: ImportTemplateFormat,
): string {
  return `${productKey}-import-template.${format}`;
}

/**
 * 上传用的 multipart 表单。
 *
 * `payload` 是计算参数（税率档案、汇率、订单量…）的 JSON 字符串 ——
 * 与文件一起作为表单字段传，所以前端不需要把两者拼成一个请求体。
 */
export function buildImportFormData(
  file: File,
  payload: Record<string, unknown>,
  opts: {
    productKey: string;
    view?: "customer" | "internal";
    sheet?: string;
  } = {
    productKey: "field_fence",
  },
): FormData {
  const fd = new FormData();
  fd.append("file", file);
  fd.append("product_key", opts.productKey);
  fd.append("payload", JSON.stringify(payload));
  if (opts.view) fd.append("view", opts.view);
  if (opts.sheet) fd.append("sheet", opts.sheet);
  return fd;
}

/**
 * multipart 请求的 axios 配置。
 *
 * 必须显式覆盖实例默认的 `application/json`：axios 见到 JSON 默认头会把
 * FormData 转成 JSON（`formDataToJSON`），文件就传丢了。显式声明 multipart
 * 后，浏览器会自己补上带 boundary 的 Content-Type。
 */
export const MULTIPART_CONFIG = {
  headers: { "Content-Type": "multipart/form-data" },
  // 整表计算比单条试算慢，给足时间；30s 默认值容易在几百行时超时
  timeout: 120_000,
} as const;

/** 上传前的本地预检 —— 明显不对的文件不必占用一次往返。 */
export function validateFile(
  file: File,
  limits: { maxMb?: number; accept?: string[] } = {},
): string | null {
  const maxMb = limits.maxMb ?? 2;
  // .xlsx 直接上传：服务端已经能读（共享内核里的纯 stdlib 读取器，2026-10-21 C7），
  // **不要**在前端解析后转 CSV —— 那会丢共享字符串之外的格式信息，也等于第二套口径。
  const accept = limits.accept ?? [".csv", ".xlsx", ".xlsm", ".txt"];
  const name = file.name.toLowerCase();
  if (name.endsWith(".xls")) {
    return "不支持老的 .xls 格式，请在 Excel 里另存为 .xlsx（或 CSV）后再上传";
  }
  if (!accept.some((ext) => name.endsWith(ext))) {
    return `只支持 ${accept.join(" / ")} 格式`;
  }
  if (file.size === 0) return "文件是空的";
  if (file.size > maxMb * 1024 * 1024) {
    return `文件过大（${(file.size / 1048576).toFixed(1)} MB），上限 ${maxMb} MB`;
  }
  return null;
}

/** 一份导入问题清单的可读分组：先按行，整表级问题（row=0）排在最后。 */
export function groupIssues(issues: ImportIssue[]): {
  row: number;
  label: string;
  items: ImportIssue[];
}[] {
  const byRow = new Map<number, ImportIssue[]>();
  for (const it of issues) {
    const list = byRow.get(it.row) ?? [];
    list.push(it);
    byRow.set(it.row, list);
  }
  return [...byRow.entries()]
    .sort((a, b) => (a[0] === 0 ? 1 : b[0] === 0 ? -1 : a[0] - b[0]))
    .map(([row, items]) => ({
      row,
      label: row === 0 ? "整表" : `第 ${row} 行`,
      items,
    }));
}

/** 一行问题的完整描述：哪一列 / 什么值 / 期望什么。 */
export function describeIssue(issue: ImportIssue): string {
  const at = issue.column ? `${issue.column}: ` : "";
  const value =
    issue.value === null || issue.value === "" ? "" : `值「${issue.value}」，`;
  return `${at}${value}${issue.message}`;
}

/** 预览是否可以直接算：至少有一行可用。 */
export function canCalculate(preview: ImportPreviewResponse | null): boolean {
  return !!preview && preview.usable_rows > 0;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export interface ImportSummaryView {
  rows: number;
  errors: number;
  warnings: number;
  /** 总净重（kg）与总售价，取结果里的合计；没有合计就是 null */
  totalWeightKg: number | null;
  totalPrice: number | null;
  totalPriceFx: number | null;
}

/**
 * 结果摘要 —— 直接读结果里的合计，不自己重算一遍。
 *
 * 报价的真值只在引擎里有一份；前端再算一遍就等于立了第二个口径。
 */
export function summarizeResult(
  result: ImportCalculateResponse | null,
  fallbackRows = 0,
): ImportSummaryView {
  const empty: ImportSummaryView = {
    rows: fallbackRows,
    errors: 0,
    warnings: 0,
    totalWeightKg: null,
    totalPrice: null,
    totalPriceFx: null,
  };
  if (!result) return empty;

  const sum = result.import;
  const meta = result.meta as unknown as Record<string, unknown> | undefined;
  const totals = (meta?.totals ?? {}) as Record<string, unknown>;
  const orders = (meta?.orders ?? []) as { total_weight_kg?: unknown }[];

  return {
    rows: sum?.usable_rows ?? fallbackRows,
    errors: (sum?.issues ?? []).filter((i) => i.severity === "error").length,
    warnings: (sum?.issues ?? []).filter((i) => i.severity !== "error").length,
    totalWeightKg:
      num(totals.total_weight_kg) ??
      (orders.length
        ? orders.reduce((acc, o) => acc + (num(o.total_weight_kg) ?? 0), 0)
        : null),
    totalPrice: num(totals.total_price) ?? num(totals.total_amount),
    totalPriceFx: num(totals.total_price_fx) ?? num(totals.total_amount_fx),
  };
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * 把结果表导成 CSV。
 *
 * 带 BOM：Excel 打开中文列名不乱码 —— 这份文件是拿去发给客户/存档的，
 * 打开是乱码就等于不能用。
 */
export function resultToCsv(header: string[], rows: unknown[][]): string {
  const lines = [header.map(csvCell).join(",")];
  for (const row of rows) lines.push(row.map(csvCell).join(","));
  return "\ufeff" + lines.join("\r\n") + "\r\n";
}

/** 触发浏览器下载。 */
export function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * 从 Content-Disposition 里取文件名。
 *
 * 跨域时该响应头要先被 `Access-Control-Expose-Headers` 放行才看得到，
 * 所以拿不到就退回本地拼的名字，不让下载因为一个文件名失败。
 */
export function filenameFromDisposition(
  disposition: string | undefined,
  fallback: string,
): string {
  if (!disposition) return fallback;
  const star = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(disposition);
  if (star && star[1]) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ""));
    } catch {
      /* 格式不对就继续试着取普通 filename */
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(disposition);
  if (plain && plain[1]) return plain[1].trim();
  return fallback;
}
