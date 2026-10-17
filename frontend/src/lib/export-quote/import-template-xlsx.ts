/**
 * 报价批量导入模板（.xlsx）—— 纯前端用 exceljs 生成。
 *
 * 为什么在前端做：线上运行时是 Cloudflare Worker（Pyodide），装不了 openpyxl
 * （C 扩展），后端 `format=xlsx` 按设计只返回 501；而 CSV 没有样式，用户拿到
 * 的模板看不出哪列必填、单位是什么、能填哪些值。exceljs 是纯 JS，浏览器里能跑，
 * 且已在依赖里（trade-doc 导出也用它），所以模板改为前端现生成。
 *
 * **契约（改了就等于把导入打坏）**：
 *   · 第 1 行必须与 `info.headers` **逐字一致** —— 导入器按列名识别，
 *     给表头加 `*`、换单位、删列都会对不上；
 *   · 数据表名必须用 `info.data_sheet`，且排第一张（解析器默认读第一张表）；
 *   · 数据从第 2 行开始，这里只留一行**空白行**、不放示例值，
 *     避免示例行被当成真实数据算进去。
 *
 * 列定义全部来自后端 `ImportTemplateInfo`，前端不写死任何产品列。
 */
import type {
  ImportTemplateColumn,
  ImportTemplateInfo,
} from "@contracts/export-quote";
import type { Cell, DataValidation, Worksheet } from "exceljs";

/** 与后端 xlsx 下载一致的 MIME。 */
const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** 说明页表名（导出给页面文案复用，避免两处写死）。 */
export const IMPORT_TEMPLATE_NOTES_SHEET = "填写说明";

/** 数据表名兜底：正常情况用 `info.data_sheet`。 */
const FALLBACK_DATA_SHEET = "规格表";

/** 说明页里「列怎么填」表的列数（列名 / 必填 / 单位 / 可选值 / 说明）。 */
const NOTES_TABLE_COLUMNS = 5;

/** 表头配色：必填列深红、选填列蓝 —— 只改底色，**不改表头文字**。 */
const HEADER_REQUIRED_FILL = "FFC00000";
const HEADER_FILL = "FF4472C4";
const HEADER_FONT_COLOR = "FFFFFFFF";
const SECTION_FILL = "FFD9E2F3";
const TABLE_HEAD_FILL = "FFD9E2F3";
/** 数据区行高 / 边框，让「从第 2 行开始填」一眼可见。 */
const BORDER_COLOR = "FFBFBFBF";
/** 下拉候选直接内联时的上限（Excel 列表公式上限 255 字符，留点余量）。 */
const INLINE_DROPDOWN_MAX = 250;

const DATA_BORDER = {
  top: { style: "thin" as const, color: { argb: BORDER_COLOR } },
  left: { style: "thin" as const, color: { argb: BORDER_COLOR } },
  bottom: { style: "thin" as const, color: { argb: BORDER_COLOR } },
  right: { style: "thin" as const, color: { argb: BORDER_COLOR } },
};

/** 一个字符占的列宽：全角（中文、全角标点）算 2，半角算 1。 */
function textWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += (ch.codePointAt(0) ?? 0) > 0x2e80 ? 2 : 1;
  return width;
}

/** 列宽按「表头（含单位）」和「可选值」里最长的一个估算。 */
function dataColumnWidth(
  header: string,
  unit: string,
  options: string[],
): number {
  const label = unit && !header.includes(unit) ? `${header}(${unit})` : header;
  const longest = Math.max(
    textWidth(label),
    ...options.map((option) => textWidth(option)),
    0,
  );
  return Math.min(40, Math.max(10, longest + 3));
}

/** 1 → A、27 → AA。列数不多，够用。 */
function columnLetter(index: number): string {
  let n = index;
  let letters = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

/** Excel 工作表名：去掉非法字符、截到 31 字符、空则兜底。 */
function safeSheetName(raw: string, fallback: string): string {
  const cleaned = raw
    .replace(/[\\/?*[\]:]/g, "")
    .trim()
    .slice(0, 31);
  return cleaned || fallback;
}

/** 必填判定：`required_headers` 是后端给的权威清单，列声明再兜一层。 */
function isRequired(
  info: ImportTemplateInfo,
  header: string,
  column: ImportTemplateColumn | undefined,
): boolean {
  return info.required_headers.includes(header) || column?.required === true;
}

/** 表头批注：把人需要知道的（必填/单位/可选值/说明）挂在表头上，文字不改。 */
function headerNote(
  column: ImportTemplateColumn | undefined,
  required: boolean,
): string {
  if (!column) return required ? "必填列" : "选填列";
  const parts = [required ? "必填列（缺失会报错）" : "选填列"];
  if (column.unit) parts.push(`单位：${column.unit}`);
  if (column.options.length > 0) {
    parts.push(`可选值：${column.options.join(" / ")}`);
  }
  if (column.note) parts.push(column.note);
  return parts.join("\n");
}

/**
 * 内联下拉候选。
 *
 * 只做引导、不硬拦（与后端模板同口径）：系统认别名/简写，
 * 取值对不对由导入器判定。候选里出现逗号/引号或太长就放弃内联，
 * 退回「说明页列清单」—— 写坏公式比没有下拉更糟。
 */
function inlineDropdownFormula(options: string[]): string | null {
  if (options.length === 0) return null;
  if (options.some((option) => /[",]/.test(option))) return null;
  const inline = options.join(",");
  if (inline.length > INLINE_DROPDOWN_MAX) return null;
  return `"${inline}"`;
}

/**
 * exceljs 4.4 的 d.ts 漏了 `worksheet.dataValidations`（运行时是公开 API），
 * 这里用最小结构声明补上，免得为一个下拉校验把整个 Worksheet 断言成 any。
 */
interface DataValidationsHost {
  dataValidations?: {
    add(address: string, validation: DataValidation): unknown;
  };
}

/** 给数据表加一列下拉校验（写失败只是少个便利功能，不能影响模板可用）。 */
function addDropdown(
  worksheet: Worksheet,
  column: number,
  columnMeta: ImportTemplateColumn,
  maxRows: number,
): void {
  const formula = inlineDropdownFormula(columnMeta.options);
  if (!formula) return;
  const host = worksheet as unknown as DataValidationsHost;
  if (!host.dataValidations) return;
  const letter = columnLetter(column);
  const lastRow = Math.max(2, Math.min(maxRows, 10_000) + 1);
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
    /* 下拉只是便利；公式写不进去就只靠说明页 */
  }
}

/**
 * 生成批量导入模板 .xlsx。
 *
 * 结构：
 *   · `<data_sheet>`（通常「规格表」）：第 1 行 = `info.headers`（原样），
 *     第 2 行起为空白数据行；表头加粗 + 底色 + 冻结首行，必填列表头深红，
 *     有可选值的列带下拉；列宽按列名/单位/候选值估算。
 *   · 「填写说明」：产品/数据表/上限、列级说明（列名原样、单位、可选值、
 *     填写说明）、填写约定与 `info.notes`、可选值速查。
 */
export async function buildImportTemplateXlsx(
  info: ImportTemplateInfo,
): Promise<Blob> {
  // exceljs 体积大：只有用户真的点「下载 Excel 模板」时才加载，不进首屏包
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
    dataSheetName === IMPORT_TEMPLATE_NOTES_SHEET
      ? "填写指南"
      : IMPORT_TEMPLATE_NOTES_SHEET,
    "填写指南",
  );

  // ── 工作表 1：数据表（解析器只读这张，必须排第一）──
  const dataSheet = workbook.addWorksheet(dataSheetName, {
    views: [{ state: "frozen", ySplit: 1 }],
    properties: { defaultRowHeight: 20 },
  });

  const columnMeta = info.headers.map((_, index) => info.columns[index]);
  dataSheet.columns = info.headers.map((header, index) => ({
    key: `col_${index + 1}`,
    width: dataColumnWidth(
      header,
      columnMeta[index]?.unit ?? "",
      columnMeta[index]?.options ?? [],
    ),
  }));

  const headerRow = dataSheet.getRow(1);
  headerRow.height = 26;
  info.headers.forEach((header, index) => {
    const column = columnMeta[index];
    const required = isRequired(info, header, column);
    const cell = headerRow.getCell(index + 1);
    // 表头文字必须是 info.headers 原文 —— 这里只动样式，不动值
    cell.value = header;
    cell.font = { bold: true, size: 11, color: { argb: HEADER_FONT_COLOR } };
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: required ? HEADER_REQUIRED_FILL : HEADER_FILL },
    };
    cell.alignment = {
      vertical: "middle",
      horizontal: "center",
      wrapText: true,
    };
    cell.border = DATA_BORDER;
    cell.note = headerNote(column, required);
  });

  // 第 2 行：空白数据行（只给样式，不放示例值，免得被算成真实数据）
  const firstDataRow = dataSheet.getRow(2);
  firstDataRow.height = 20;
  info.headers.forEach((_header, index) => {
    const cell = firstDataRow.getCell(index + 1);
    cell.border = DATA_BORDER;
    cell.alignment = { vertical: "middle", horizontal: "left" };
  });

  info.headers.forEach((_header, index) => {
    const column = columnMeta[index];
    if (column) addDropdown(dataSheet, index + 1, column, info.max_rows);
  });

  // ── 工作表 2：填写说明 ──
  const notes = workbook.addWorksheet(notesSheetName, {
    properties: { defaultRowHeight: 20 },
  });
  notes.columns = [
    { key: "header_col", width: 30 },
    { key: "required_col", width: 12 },
    { key: "unit_col", width: 12 },
    { key: "options_col", width: 30 },
    { key: "note_col", width: 52 },
  ];

  let rowIndex = 0;

  /** 跨列的一行文字（标题/小节/约定），自动换行。 */
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
    notes.mergeCells(rowIndex, 1, rowIndex, NOTES_TABLE_COLUMNS);
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

  /** 五列的一行（列说明表）。 */
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

  mergedLine(`「${info.product_name}」批量导入模板 · 填写说明`, {
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
  mergedLine("一、基本信息", { bold: true, fill: SECTION_FILL, height: 22 });
  tableLine(["项目", "内容", "", "", ""], true);
  tableLine([
    `产品`,
    `${info.product_name}（${info.product_key}）`,
    "",
    "",
    "",
  ]);
  tableLine([
    `数据表`,
    dataSheetName,
    "",
    "",
    "解析器只读这张表，请把数据填在这里",
  ]);
  tableLine([
    `表头行`,
    "第 1 行",
    "",
    "",
    "保持原样：不要改名、加减 *、换单位、删列或调顺序",
  ]);
  tableLine([
    `行数上限`,
    `${info.max_rows} 行`,
    "",
    "",
    "超过请拆成多个文件分批导入",
  ]);
  tableLine([
    `文件上限`,
    `${info.max_mb} MB`,
    "",
    "",
    "支持 .xlsx 与 .csv；老式 .xls 请先另存为 .xlsx",
  ]);
  mergedLine("");
  mergedLine("二、列怎么填", { bold: true, fill: SECTION_FILL, height: 22 });
  mergedLine(
    `表头配色：深红 = 必填列，蓝 = 选填列；表头文字本身不带 *，` +
      `以免与导入时识别的列名对不上。「必填」一列标 * 的，缺失会报错。`,
    { color: "FF475569" },
  );
  tableLine(["列名", "是否必填", "单位", "可选值", "填写说明"], true);
  info.headers.forEach((header, index) => {
    const column = columnMeta[index];
    const required = isRequired(info, header, column);
    const options = column?.options ?? [];
    tableLine([
      header,
      required ? "必填 *" : "选填",
      column?.unit || "—",
      options.length > 0 ? options.join(" / ") : "—",
      column?.note || "—",
    ]);
  });
  mergedLine("");
  mergedLine("三、填写约定", { bold: true, fill: SECTION_FILL, height: 22 });
  const conventions = [
    "数据从第 2 行开始填；空白行会被跳过，不要合并单元格。",
    "单位看列名括号：例如「网高(cm)」填 120 表示 120 cm；按该单位填原值，不要自行换算。",
    "有下拉的列建议从下拉里选；系统认得的别名/简写也能通过校验，取值对不对由导入器判定。",
    `单表最多 ${info.max_rows} 行、文件不超过 ${info.max_mb} MB；只读「${dataSheetName}」表。`,
  ];
  for (const line of conventions) mergedLine(`· ${line}`, { indent: 1 });
  for (const note of info.notes) {
    mergedLine(`· ${note}`, { indent: 1 });
  }

  const optionColumns = info.headers
    .map((header, index) => ({
      header,
      options: columnMeta[index]?.options ?? [],
    }))
    .filter((item) => item.options.length > 0);
  if (optionColumns.length > 0) {
    mergedLine("");
    mergedLine("四、可选值速查", {
      bold: true,
      fill: SECTION_FILL,
      height: 22,
    });
    for (const item of optionColumns) {
      mergedLine(`${item.header}：${item.options.join(" / ")}`, {
        indent: 1,
      });
    }
  }

  const data = await workbook.xlsx.writeBuffer();
  return new Blob([new Uint8Array(data)], { type: XLSX_MIME });
}
