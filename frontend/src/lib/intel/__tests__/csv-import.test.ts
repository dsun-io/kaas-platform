/**
 * 情报货运 CSV 导入纯函数（C36 #15）：
 * 表头识别（中英别名）→ 列映射 → 必填缺失/未知列 → 预览行号；文件预检；multipart 字段名。
 */
import { describe, expect, it } from "vitest";

import {
  INTEL_CSV_FIELD,
  analyzeIntelCsv,
  buildIntelCsvForm,
  parseIntelCsv,
  validateIntelCsvFile,
} from "../csv-import";

describe("parseIntelCsv", () => {
  it("解析表头与数据行（去 BOM、去空行、CRLF）", () => {
    const { header, rows } = parseIntelCsv(
      "\uFEFFshipper,consignee,product_desc\r\nA,B,C\r\n\r\nD,E,F\r\n",
    );
    expect(header).toEqual(["shipper", "consignee", "product_desc"]);
    expect(rows).toEqual([
      ["A", "B", "C"],
      ["D", "E", "F"],
    ]);
  });

  it("支持引号包裹的字段内逗号与换行、以及双引号转义", () => {
    const { rows } = parseIntelCsv(
      'shipper,consignee,product_desc\n"A, Inc.","B\nCorp","say ""hi"""\n',
    );
    expect(rows).toEqual([['A, Inc.', "B\nCorp", 'say "hi"']]);
  });
});

describe("analyzeIntelCsv", () => {
  it("英文表头全部识别；预览行号从 2 开始", () => {
    const analysis = analyzeIntelCsv(
      "shipper,consignee,product_desc,hs_code\nA,B,C,7314\nD,E,F,7308\n",
      { previewRows: 1 },
    );
    expect(analysis.ok).toBe(true);
    expect(analysis.missingRequired).toEqual([]);
    expect(analysis.unknownColumns).toEqual([]);
    expect(analysis.totalRows).toBe(2);
    expect(analysis.preview).toEqual([
      {
        row: 2,
        values: { shipper: "A", consignee: "B", product_desc: "C", hs_code: "7314" },
      },
    ]);
  });

  it("中文别名等价（发货人/收货人/产品描述/目的国）", () => {
    const analysis = analyzeIntelCsv(
      "发货人,收货人,产品描述,目的国\n安平,A,B,C\n",
    );
    expect(analysis.ok).toBe(true);
    expect(analysis.missingRequired).toEqual([]);
    expect(analysis.columns.map((column) => column.field)).toEqual([
      "shipper",
      "consignee",
      "product_desc",
      "dest_country",
    ]);
  });

  it("缺必填列与未知列分别报告（未知列不阻塞）", () => {
    const analysis = analyzeIntelCsv("shipper,foo,bar\nA,1,2\n");
    expect(analysis.ok).toBe(true);
    expect(analysis.missingRequired).toEqual(["consignee", "product_desc"]);
    expect(analysis.unknownColumns).toEqual(["foo", "bar"]);
  });

  it("一列都识别不到 ⇒ ok=false（中文原因）", () => {
    const analysis = analyzeIntelCsv("foo,bar\n1,2\n");
    expect(analysis.ok).toBe(false);
    expect(analysis.error).toContain("未识别到任何已知列");
  });

  it("空文本 / 只有空行 ⇒ ok=false", () => {
    expect(analyzeIntelCsv("").ok).toBe(false);
    expect(analyzeIntelCsv("\n\n").ok).toBe(false);
  });
});

describe("validateIntelCsvFile / buildIntelCsvForm", () => {
  it("非 csv / 空文件 / 未选 都被本地拦截", () => {
    expect(validateIntelCsvFile(null)).toContain("请选择");
    expect(validateIntelCsvFile(new File(["a,b"], "x.xlsx"))).toContain(".csv");
    expect(validateIntelCsvFile(new File([], "x.csv"))).toContain("空");
    expect(validateIntelCsvFile(new File(["a,b\n"], "x.csv"))).toBeNull();
  });

  it("multipart 字段名必须是 file（后端 UploadFile 名）", () => {
    expect(INTEL_CSV_FIELD).toBe("file");
    const form = buildIntelCsvForm(new File(["a,b\n"], "shipments.csv"));
    expect(form.get("file")).toBeInstanceOf(File);
  });
});
