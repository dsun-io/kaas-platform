/**
 * 单证导出：打印 / PDF / HTML / 台账 CSV / 台账 Excel / 批量合并打印
 *
 * 设计取舍
 * --------
 * - **PDF 走浏览器打印**：单据本来就是 A4 印刷品，浏览器「打印为 PDF」自带分页、
 *   字体与页边距处理，比自研 PDF 生成更可靠，也不需要额外依赖。
 * - **Excel 懒加载 exceljs**：它体积大，只有用户真的点「导出 Excel」时才加载，
 *   不拖慢工位首屏。
 * - **CSV 加 UTF-8 BOM**：否则 Excel 打开中文台账会乱码（Windows 下的经典坑）。
 */

/** 打印/保存一份单据（自包含 HTML，已在渲染时内联样式） */
export function printHtml(html: string): void {
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.style.position = "fixed";
  frame.style.right = "0";
  frame.style.bottom = "0";
  frame.style.width = "0";
  frame.style.height = "0";
  frame.style.border = "0";
  document.body.appendChild(frame);

  const win = frame.contentWindow;
  if (!win) {
    document.body.removeChild(frame);
    return;
  }
  win.document.open();
  win.document.write(html);
  win.document.close();

  // 必须等文档与样式就绪再打印，否则会打出未套样式的内容
  const doPrint = () => {
    win.focus();
    win.print();
    // 打印对话框是同步阻塞的，返回后即可清理
    window.setTimeout(() => document.body.removeChild(frame), 1000);
  };
  if (win.document.readyState === "complete") window.setTimeout(doPrint, 50);
  else win.addEventListener("load", () => window.setTimeout(doPrint, 50));
}

/**
 * 批量合并打印：多份单据合成一个文档，每份之间强制分页。
 * 用途：一票货要一起打「发票 + 装箱单 + 提单 + 产地证」，逐份点打印太慢，
 * 且容易漏打或多打。
 */
export function printMerged(htmls: string[]): void {
  if (htmls.length === 0) return;
  const first = htmls[0];
  if (!first) return;
  if (htmls.length === 1) return printHtml(first);

  // 取第一份的 <head>（含共享样式），把各份的 <body> 依次拼接
  const headMatch = /<head[^>]*>([\s\S]*?)<\/head>/i.exec(first);
  const head = headMatch?.[1] ?? "";
  const bodies = htmls.map((html) => {
    const bodyMatch = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html);
    return bodyMatch?.[1] ?? html;
  });

  const merged = [
    "<!DOCTYPE html>",
    '<html lang="en">',
    `<head>${head}`,
    "<style>.merged-page{page-break-after:always;break-after:page;}" +
      ".merged-page:last-child{page-break-after:auto;break-after:auto;}</style>",
    "</head>",
    "<body>",
    ...bodies.map((body) => `<div class="merged-page">${body}</div>`),
    "</body>",
    "</html>",
  ].join("\n");

  printHtml(merged);
}

/** 下载 HTML 文件（留档 / 邮件附件） */
export function downloadHtml(filename: string, html: string): void {
  downloadBlob(filename, new Blob([html], { type: "text/html;charset=utf-8" }));
}

export interface ExportColumn<T> {
  header: string;
  value: (row: T) => string | number | null | undefined;
  width?: number;
}

/** 台账 CSV（带 BOM，Excel 直接双击可读） */
export function exportCsv<T>(
  filename: string,
  rows: T[],
  columns: ExportColumn<T>[],
): void {
  const escapeCell = (raw: unknown) => {
    const text = raw === null || raw === undefined ? "" : String(raw);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [
    columns.map((c) => escapeCell(c.header)).join(","),
    ...rows.map((row) =>
      columns.map((c) => escapeCell(c.value(row))).join(","),
    ),
  ];
  // \uFEFF = UTF-8 BOM：缺少它 Excel 会把中文台账显示成乱码
  downloadBlob(
    filename,
    new Blob(["\uFEFF" + lines.join("\r\n")], {
      type: "text/csv;charset=utf-8",
    }),
  );
}

/** 台账 Excel（.xlsx）。exceljs 按需加载，不拖慢首屏。 */
export async function exportExcel<T>(
  filename: string,
  sheetName: string,
  rows: T[],
  columns: ExportColumn<T>[],
): Promise<void> {
  const ExcelJS = (await import("exceljs")).default;
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Kaas";
  const sheet = workbook.addWorksheet(sheetName.slice(0, 31));

  sheet.columns = columns.map((c) => ({
    header: c.header,
    key: c.header,
    width: c.width ?? 18,
  }));
  for (const row of rows) {
    sheet.addRow(columns.map((c) => c.value(row) ?? ""));
  }

  // 表头加粗 + 冻结首行：台账行数多时便于对照列名
  const header = sheet.getRow(1);
  header.font = { bold: true };
  header.alignment = { vertical: "middle", horizontal: "center" };
  sheet.views = [{ state: "frozen", ySplit: 1 }];

  const buffer = await workbook.xlsx.writeBuffer();
  downloadBlob(
    filename,
    new Blob([buffer], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }),
  );
}

function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  // 立即 revoke 会让部分浏览器来不及开始下载，延后释放
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}
