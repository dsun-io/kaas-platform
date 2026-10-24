/**
 * 整单批量导入模板（.xlsx）—— 单表 + 产品列，前端用 exceljs 生成。
 *
 * 口径（用户 2026-10-23 拍板）：**不区分产品**，一张表导入整个订单的 N 个产品行；
 * 规格列 = 各产品模板列的**并集**（与某行产品无关的列留空即可）。
 *
 * 契约（改了就等于把导入打坏）：
 *   · 第 1 行必须与 `info.headers` **逐字一致**（导入器按列名识别，别加 *、别换单位）；
 *   · 数据表名用 `info.data_sheet` 且排第一张；
 *   · 数据从第 2 行开始，只留一行空白行、不放示例值。
 *
 * 列定义全部来自后端 `OrderImportTemplateInfo`，前端不写死任何产品列。
 */
import type { OrderImportTemplateInfo } from "@contracts/export-quote";
import type { Cell, DataValidation } from "exceljs";

const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** 与单产品模板共用同一张说明页名（页面文案也引用它）。 */
export const ORDER_TEMPLATE_NOTES_SHEET = "填写说明";

const FALLBACK_DATA_SHEET = "整单表";
const NOTES_COLUMNS = 6;

/** 表头配色：整单公共必填列深红、选填列蓝；规格列浅蓝。 */
const HEADER_REQUIRED_FILL = "FFC00000";
const HEADER_FILL = "FF4472C4";
const HEADER_SPEC_FILL = "FF2F5597";
const HEADER_FONT_COLOR = "FFFFFFFF";
const SECTION_FILL = "FFD9E2F3";
const TABLE_HEAD_FILL = "FFD9E2F3";
const BORDER_COLOR = "FFBFBFBF";
const INLINE_DROPDOWN_MAX = 250;

const DATA_BORDER = {
  top: { style: "thin" as const, color: { argb: BORDER_COLOR } },
  left: { style: "thin" as const, color: { argb: BORDER_COLOR } },
  bottom: { style: "thin" as const, color: { argb: BORDER_COLOR } },
  right: { style: "thin" as const, color: { argb: BORDER_COLOR } },
};

/** 整单公共列里必填的三列（与后端解析口径一致）。 */
const REQUIRED_COMMON_HEADERS = ["产品", "件数（卷）", "成本"];

/**
 * exceljs 4.4 的 d.ts 漏了 `worksheet.dataValidations`（运行时是公开 API），
 * 用最小结构声明补上（与前端其它 exceljs 生成器同口径）。
 */
interface DataValidationsHost {
  dataValidations?: {
    add(address: string, validation: DataValidation): unknown;
  };
}

function textWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += (ch.codePointAt(0) ?? 0) > 0x2e80 ? 2 : 1;
  return width;
}

function columnLetter(column: number): string {
  let n = column;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** 工作表名：Excel 禁止 : \ / ? * [ ]，且 ≤31 字符。 */
function safeSheetName(name: string, fallback: string): string {
  const cleaned = (name || "")
    .replace(/[:\\/?*[\]]/g, " ")
    .trim()
    .slice(0, 31);
  return cleaned || fallback;
}

function inlineDropdownFormula(options: string[]): string | null {
  if (options.length === 0) return null;
  const joined = options.join(",");
  if (joined.length > INLINE_DROPDOWN_MAX) return null;
  return '"' + joined.replace(/"/g, '""') + '"';
}

/**
 * 生成整单批量导入模板 .xlsx。
 *
 * 结构：
 *   · `<data_sheet>`：第 1 行 = info.headers（原样），第 2 行起空白；
 *     规格列带可选值下拉（有候选值时），冻结首行。
 *   · 「填写说明」：列名 / 类型 / 适用产品 / 单位 / 可选值 / 说明 + 填写约定。
 */
export async function buildOrderImportTemplateXlsx(
  info: OrderImportTemplateInfo,
): Promise<Blob> {
  const ExcelJS = (await import("exceljs")).default;
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "KaaS 报价平台";
  workbook.lastModifiedBy = "KaaS 报价平台";
  workbook.created = new Date();
  workbook.modified = new Date();

  const dataSheetName = safeSheetName(
    info.data_sheet || FALLBACK_DATA_SHEET,
    FALLBACK_DATA_SHEET,
  );
  const notesSheetName = safeSheetName(
    dataSheetName === ORDER_TEMPLATE_NOTES_SHEET
      ? "填写指南"
      : ORDER_TEMPLATE_NOTES_SHEET,
    "填写指南",
  );

  const columnMeta = info.headers.map((_, index) => info.columns[index]);

  // ── 工作表 1：数据表（解析器只读这张，必须排第一）──
  const dataSheet = workbook.addWorksheet(dataSheetName, {
    views: [{ state: "frozen", ySplit: 1 }],
    properties: { defaultRowHeight: 20 },
  });
  dataSheet.columns = info.headers.map((header, index) => ({
    key: `col_${index + 1}`,
    width: Math.min(
      42,
      Math.max(
        10,
        textWidth(header) + 4,
        textWidth(columnMeta[index]?.unit ?? "") + 4,
        ...(columnMeta[index]?.options ?? [])
          .slice(0, 8)
          .map((o) => textWidth(o) + 2),
      ),
    ),
  }));

  const headerRow = dataSheet.getRow(1);
  headerRow.height = 26;
  info.headers.forEach((header, index) => {
    const column = columnMeta[index];
    const isCommon = column?.kind === "common";
    const required = isCommon && REQUIRED_COMMON_HEADERS.includes(header);
    const cell = headerRow.getCell(index + 1);
    // 表头文字必须是 info.headers 原文 —— 这里只动样式，不动值
    cell.value = header;
    cell.font = { bold: true, size: 11, color: { argb: HEADER_FONT_COLOR } };
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: {
        argb: required
          ? HEADER_REQUIRED_FILL
          : isCommon
            ? HEADER_FILL
            : HEADER_SPEC_FILL,
      },
    };
    cell.alignment = {
      vertical: "middle",
      horizontal: "center",
      wrapText: true,
    };
    cell.border = DATA_BORDER;
  });

  // 第 2 行：空白数据行（只给样式与下拉，不放示例值）
  const firstDataRow = dataSheet.getRow(2);
  firstDataRow.height = 20;
  info.headers.forEach((_header, index) => {
    const cell = firstDataRow.getCell(index + 1);
    cell.border = DATA_BORDER;
    cell.alignment = { vertical: "middle", horizontal: "left" };
    const options = columnMeta[index]?.options ?? [];
    const formula = inlineDropdownFormula(options);
    if (!formula) return;
    const host = dataSheet as unknown as DataValidationsHost;
    if (!host.dataValidations) return;
    const letter = columnLetter(index + 1);
    const lastRow = Math.max(2, Math.min(info.max_rows, 10_000) + 1);
    try {
      host.dataValidations.add(`${letter}2:${letter}${lastRow}`, {
        type: "list",
        allowBlank: true,
        formulae: [formula],
        showInputMessage: true,
        promptTitle: "可选值",
        prompt: "建议从下拉里选；系统认得的别名/简写也能通过校验。",
      });
    } catch {
      /* 下拉只是便利；写不进去就只靠说明页 */
    }
  });

  // ── 工作表 2：填写说明 ──
  const notes = workbook.addWorksheet(notesSheetName, {
    properties: { defaultRowHeight: 20 },
  });
  notes.columns = [
    { key: "header_col", width: 30 },
    { key: "kind_col", width: 12 },
    { key: "products_col", width: 26 },
    { key: "unit_col", width: 10 },
    { key: "options_col", width: 30 },
    { key: "note_col", width: 46 },
  ];

  let rowIndex = 0;
  const mergedLine = (
    text: string,
    style: {
      bold?: boolean;
      size?: number;
      color?: string;
      fill?: string;
      height?: number;
      indent?: number;
    } = {},
  ): void => {
    rowIndex += 1;
    const row = notes.getRow(rowIndex);
    notes.mergeCells(rowIndex, 1, rowIndex, NOTES_COLUMNS);
    const cell = row.getCell(1);
    cell.value = text;
    cell.font = {
      bold: style.bold ?? false,
      size: style.size ?? 11,
      color: { argb: style.color ?? "FF1F2937" },
    };
    if (style.fill) {
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: style.fill },
      };
    }
    cell.alignment = {
      vertical: "middle",
      horizontal: "left",
      wrapText: true,
      indent: style.indent ?? 0,
    };
    row.height = style.height ?? 20;
  };
  const tableLine = (values: string[], header = false): void => {
    rowIndex += 1;
    const row = notes.getRow(rowIndex);
    values.forEach((value, index) => {
      row.getCell(index + 1).value = value;
    });
    row.height = header ? 24 : 20;
    row.eachCell({ includeEmpty: true }, (cell: Cell) => {
      cell.border = DATA_BORDER;
      cell.font = {
        bold: header,
        size: 11,
        color: { argb: header ? "FF1F3864" : "FF1F2937" },
      };
      if (header) {
        cell.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: TABLE_HEAD_FILL },
        };
      }
      cell.alignment = {
        vertical: header ? "middle" : "top",
        horizontal: header ? "center" : "left",
        wrapText: true,
      };
    });
  };

  mergedLine("整单批量导入模板 · 填写说明", {
    bold: true,
    size: 14,
    fill: SECTION_FILL,
    height: 30,
  });
  mergedLine(
    `数据表：${dataSheetName}（只读这张表；本页不参与计算）。` +
      `单表最多 ${info.max_rows} 行，文件不超过 ${info.max_mb} MB。`,
    { color: "FF475569" },
  );
  mergedLine("");
  mergedLine("一、怎么填", { bold: true, fill: SECTION_FILL, height: 22 });
  mergedLine(
    "· 一行 = 订单里的一个产品行：「产品」列写产品名（或 key），该行的规格列只填这个产品用得到的列，其余留空。",
    { indent: 1 },
  );
  mergedLine("· 整单可以混多个产品；同一产品可以有多行（不同规格/包装）。", {
    indent: 1,
  });
  mergedLine(
    "· 「件数（卷）」与「成本」每行必填；「成本口径」填 含税/不含税（默认不含税=税前价）。",
    { indent: 1 },
  );
  mergedLine(
    "· 「包装方式」按产品里的包装方式原文填（如 编织袋+钢带）；不填 = 用默认包装。",
    { indent: 1 },
  );
  mergedLine("· 表头保持原样：不要改名、加 *、换单位、删列或调顺序。", {
    indent: 1,
  });
  mergedLine("");
  mergedLine("二、列说明", { bold: true, fill: SECTION_FILL, height: 22 });
  tableLine(["列名", "类型", "适用产品", "单位", "可选值", "说明"], true);
  info.headers.forEach((header, index) => {
    const column = columnMeta[index];
    const isCommon = column?.kind === "common";
    const required = isCommon && REQUIRED_COMMON_HEADERS.includes(header);
    tableLine([
      header + (required ? "（必填）" : ""),
      isCommon ? "整单公共" : "规格",
      isCommon ? "全部" : column?.products?.join(" / ") || "—",
      column?.unit || "—",
      (column?.options ?? []).length > 0
        ? (column?.options ?? []).join(" / ")
        : "—",
      column?.note || "—",
    ]);
  });
  mergedLine("");
  mergedLine("三、填写约定", { bold: true, fill: SECTION_FILL, height: 22 });
  for (const line of [
    "数据从第 2 行开始填；空白行会被跳过，不要合并单元格。",
    "单位看列名括号：例如「网高(cm)」填 120 表示 120 cm；按该单位填原值，不要自行换算。",
    "有下拉的列建议从下拉里选；系统认得的别名/简写也能通过校验，取值对不对由导入器判定。",
    `单表最多 ${info.max_rows} 行、文件不超过 ${info.max_mb} MB；只读「${dataSheetName}」表。`,
    "导入成功后系统会把整单的产品行填入报价工作台，可继续核对/调成本与包装再保存。",
  ]) {
    mergedLine(`· ${line}`, { indent: 1 });
  }
  for (const note of info.notes) {
    mergedLine(`· ${note}`, { indent: 1 });
  }

  const data = await workbook.xlsx.writeBuffer();
  return new Blob([new Uint8Array(data)], { type: XLSX_MIME });
}
