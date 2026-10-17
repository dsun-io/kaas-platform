import { describe, expect, it } from "vitest";
import { ImportTemplateInfoSchema } from "@contracts/export-quote";
import type { ImportTemplateInfo } from "@contracts/export-quote";
import type { Worksheet } from "exceljs";
import {
  buildImportTemplateXlsx,
  IMPORT_TEMPLATE_NOTES_SHEET,
} from "@/lib/export-quote/import-template-xlsx";

/** 与后端 `/import-template` 返回同形状的样本（字段用 schema 补默认值）。 */
function sampleInfo(
  overrides: Partial<ImportTemplateInfo> = {},
): ImportTemplateInfo {
  return ImportTemplateInfoSchema.parse({
    product_key: "field_fence",
    product_name: "牛栏网",
    columns: [
      {
        header: "网高(cm)",
        kind: "scalar",
        target: "height_cm",
        required: true,
        unit: "cm",
        options: ["100", "120", "150"],
        note: "网片高度，按列名单位 cm 填原值",
      },
      {
        header: "丝径方案",
        kind: "variant",
        target: "wire_scheme",
        required: true,
        unit: "",
        options: ["全丝2.0", "全丝2.5"],
        note: "选一个方案，其余参数自动带出",
      },
      {
        header: "镀锌量(g/m²)",
        kind: "scalar",
        target: "zinc_g",
        required: false,
        unit: "g/m²",
        options: [],
        note: "留空按方案默认",
      },
    ],
    headers: ["网高(cm)", "丝径方案", "镀锌量(g/m²)"],
    required_headers: ["网高(cm)", "丝径方案"],
    max_rows: 2000,
    max_mb: 2,
    sheets: ["规格表", "示例", "填写说明"],
    data_sheet: "规格表",
    download: {},
    notes: [
      "导出的报价表也能原样上传重算。",
      "表头别改：列名要与系统导出一致。",
    ],
    ...overrides,
  });
}

/** 读回生成的 xlsx —— 用 exceljs 自己读，验证的是「真文件」而不是内存对象。 */
async function readWorkbook(blob: Blob) {
  const ExcelJS = (await import("exceljs")).default;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await blob.arrayBuffer());
  return workbook;
}

/** 某一行前 n 列的文本值（空单元格记 ""）。 */
function rowTexts(
  sheet: Worksheet,
  rowNumber: number,
  columnCount: number,
): string[] {
  const row = sheet.getRow(rowNumber);
  return Array.from({ length: columnCount }, (_, index) =>
    String(row.getCell(index + 1).value ?? ""),
  );
}

/** 整张表的文本（用于断言说明页里写了什么）。 */
function sheetText(sheet: Worksheet): string {
  const parts: string[] = [];
  sheet.eachRow((row) => {
    row.eachCell((cell) => {
      const value = cell.value;
      if (value !== null && value !== undefined) parts.push(String(value));
    });
  });
  return parts.join("\n");
}

describe("前端生成 Excel 导入模板", () => {
  it("产出的是一份可读的 .xlsx，数据表在前、说明页在后", async () => {
    const blob = await buildImportTemplateXlsx(sampleInfo());

    expect(blob.size).toBeGreaterThan(1000);
    expect(blob.type).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );

    const workbook = await readWorkbook(blob);
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual([
      "规格表",
      IMPORT_TEMPLATE_NOTES_SHEET,
    ]);
  });

  it("第 1 行表头与 info.headers 逐字一致（不加 *、不改单位、不换顺序）", async () => {
    const info = sampleInfo();
    const workbook = await readWorkbook(await buildImportTemplateXlsx(info));
    const sheet = workbook.getWorksheet(info.data_sheet);
    expect(sheet).toBeDefined();

    expect(rowTexts(sheet!, 1, info.headers.length)).toEqual(info.headers);
    // 表头加 * 会让导入器认不出列名，所以只允许在说明/批注里标注必填
    for (const header of rowTexts(sheet!, 1, info.headers.length)) {
      expect(header).not.toContain("*");
    }
  });

  it("必填列清单出现在说明页，且表头文字仍保持原样", async () => {
    const info = sampleInfo();
    const workbook = await readWorkbook(await buildImportTemplateXlsx(info));
    const notes = workbook.getWorksheet(IMPORT_TEMPLATE_NOTES_SHEET);
    expect(notes).toBeDefined();

    const text = sheetText(notes!);
    expect(text).toContain("必填 *");
    for (const required of info.required_headers) {
      expect(text).toContain(required);
    }
  });

  it("说明页覆盖 notes、行列上限、单位与可选值", async () => {
    const info = sampleInfo();
    const workbook = await readWorkbook(await buildImportTemplateXlsx(info));
    const text = sheetText(workbook.getWorksheet(IMPORT_TEMPLATE_NOTES_SHEET)!);

    expect(text).toContain(String(info.max_rows));
    expect(text).toContain(`${info.max_mb} MB`);
    expect(text).toContain("cm");
    expect(text).toContain("全丝2.0");
    for (const note of info.notes) {
      expect(text).toContain(note);
    }
    // 数据表名要写清楚：解析器只读这张表
    expect(text).toContain(info.data_sheet);
  });

  it("表头样式：加粗、带底色、冻结首行，必填与选填表头区分颜色", async () => {
    const info = sampleInfo();
    const workbook = await readWorkbook(await buildImportTemplateXlsx(info));
    const sheet = workbook.getWorksheet(info.data_sheet)!;

    expect(sheet.views?.[0]).toMatchObject({ state: "frozen", ySplit: 1 });

    const headerRow = sheet.getRow(1);
    expect(headerRow.getCell(1).font?.bold).toBe(true);

    const fillOf = (column: number) => {
      const fill = headerRow.getCell(column).fill as
        | { fgColor?: { argb?: string } }
        | undefined;
      return fill?.fgColor?.argb;
    };
    // 网高(cm) 必填、镀锌量(g/m²) 选填 —— 底色必须不同，否则看不出哪些必填
    expect(fillOf(1)).toBeTruthy();
    expect(fillOf(3)).toBeTruthy();
    expect(fillOf(1)).not.toBe(fillOf(3));

    // 列宽按列名/单位/候选值估算过，不能是 exceljs 默认值
    expect(sheet.getColumn(1).width).toBeGreaterThan(8);
    expect(sheet.getColumn(2).width).toBeGreaterThan(8);
  });

  it("数据从第 2 行开始：第 2 行留空，不放会被误算的示例值", async () => {
    const info = sampleInfo();
    const workbook = await readWorkbook(await buildImportTemplateXlsx(info));
    const sheet = workbook.getWorksheet(info.data_sheet)!;

    expect(rowTexts(sheet, 2, info.headers.length)).toEqual(
      info.headers.map(() => ""),
    );
  });

  it("数据表名跟随 info.data_sheet，而不是写死「规格表」", async () => {
    const info = sampleInfo({
      data_sheet: "数据表",
      sheets: ["数据表", "填写说明"],
    });
    const workbook = await readWorkbook(await buildImportTemplateXlsx(info));

    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual([
      "数据表",
      IMPORT_TEMPLATE_NOTES_SHEET,
    ]);
    expect(workbook.getWorksheet("数据表")).toBeDefined();
  });
});
