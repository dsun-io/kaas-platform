/**
 * 表格批量导入的前端纯逻辑：上传预检、问题清单摘要、结果导出、浏览器下载。
 *
 * 抽出来单独放，是因为这些是**可测的规则**，不该埋在 JSX 里：
 *   · 上传用 multipart，必须清掉实例默认的 application/json
 *     —— axios 见到 JSON 默认头会把 FormData 转成 JSON，文件就传丢了
 *   · 问题清单的分组/排序口径（先按行、整表级问题排最后）要能独立核对
 *   · 结果表 CSV 的转义与 BOM 口径要能独立核对
 */
import type { ImportIssue } from "@contracts/export-quote";

export const EXPORT_QUOTE_BASE = "/export-quote";

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

/**
 * 问题清单的纯文本（复制用）：
 * 先按行分组、整表级问题排最后，与界面展示同一顺序 —— 否则复制出来的
 * 顺序和屏幕上不一致，用户对照着改表会错行。
 */
export function issuesToText(issues: ImportIssue[]): string {
  return groupIssues(issues)
    .map((group) =>
      [
        `[${group.label}]`,
        ...group.items.map((it) => `- ${describeIssue(it)}`),
      ].join("\n"),
    )
    .join("\n");
}

/**
 * 问题清单的 CSV（下载用）。带 BOM，Excel 打开中文表头/列名不乱码。
 * 列与 `ImportIssueSchema` 一一对应，便于用户按「行/列」排序后批量改表。
 */
export function issuesToCsv(issues: ImportIssue[]): string {
  const header = ["行号", "列", "值", "级别", "问题"];
  const rows = issues.map((it) => [
    it.row,
    it.column,
    it.value ?? "",
    it.severity === "error" ? "错误" : "提示",
    it.message,
  ]);
  return resultToCsv(header, rows);
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
