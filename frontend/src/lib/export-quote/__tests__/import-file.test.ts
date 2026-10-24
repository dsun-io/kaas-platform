import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  describeIssue,
  groupIssues,
  issuesToCsv,
  issuesToText,
  MULTIPART_CONFIG,
  resultToCsv,
  triggerBlobDownload,
  validateFile,
} from "@/lib/export-quote/import-file";
import { ImportTemplateInfoSchema } from "@contracts/export-quote";
import type { ImportIssue } from "@contracts/export-quote";

function fileOf(name: string, bytes = 1024, type = ""): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

describe("multipart 配置", () => {
  it("显式声明 multipart，否则 axios 会把 FormData 转成 JSON（文件传丢）", () => {
    expect(MULTIPART_CONFIG.headers["Content-Type"]).toBe(
      "multipart/form-data",
    );
    expect(MULTIPART_CONFIG.timeout).toBeGreaterThan(30_000);
  });
});

describe("上传前预检", () => {
  it("放行 csv / xlsx / xlsm", () => {
    for (const n of ["a.csv", "a.xlsx", "a.XLSM", "a.txt"]) {
      expect(validateFile(fileOf(n))).toBeNull();
    }
  });

  it("老式 .xls 给明确指路（另存为 .xlsx 或 CSV），而不是含糊报错", () => {
    const message = validateFile(fileOf("old.xls"));
    expect(message).toContain("另存为 .xlsx");
    expect(message).toContain("CSV");
  });

  it("拦下不支持的格式、空文件与超大文件", () => {
    expect(validateFile(fileOf("a.pdf"))).toContain("只支持");
    expect(validateFile(fileOf("a.csv", 0))).toBe("文件是空的");
    expect(validateFile(fileOf("big.xlsx", 3 * 1024 * 1024))).toContain(
      "上限 2 MB",
    );
  });
});

describe("问题清单", () => {
  const issues: ImportIssue[] = [
    {
      row: 0,
      column: "镀锌量",
      value: null,
      message: "表里没有该列",
      severity: "error",
    },
    {
      row: 2,
      column: "丝径方案",
      value: "乱写",
      message: "无法识别的取值；可选: 全丝2.0",
      severity: "error",
    },
    {
      row: 1,
      column: "网高(m)",
      value: "9.9",
      message: "不在可选范围",
      severity: "warning",
    },
  ];

  it("按行分组，整表级问题排在最后", () => {
    const g = groupIssues(issues);
    expect(g.map((x) => x.label)).toEqual(["第 1 行", "第 2 行", "整表"]);
    expect(g[1]!.items).toHaveLength(1);
  });

  it("描述里带齐「哪一列 / 什么值 / 期望什么」", () => {
    expect(describeIssue(issues[1]!)).toBe(
      "丝径方案: 值「乱写」，无法识别的取值；可选: 全丝2.0",
    );
    expect(describeIssue(issues[0]!)).toBe("镀锌量: 表里没有该列");
  });
});

describe("结果导出 CSV", () => {
  it("带 BOM，中文列名在 Excel 里不乱码", () => {
    const csv = resultToCsv(["网高(m)", "单卷售价(元/卷)"], [[1.2, 305.25]]);
    expect(csv.startsWith("\ufeff")).toBe(true);
    expect(csv).toContain("网高(m),单卷售价(元/卷)");
  });

  it("逗号、引号、换行都被正确转义", () => {
    const csv = resultToCsv(["a"], [["x,y"], ['he said "hi"'], ["l1\nl2"]]);
    expect(csv).toContain('"x,y"');
    expect(csv).toContain('"he said ""hi"""');
    expect(csv).toContain('"l1\nl2"');
  });

  it("空值导出为空单元格，不是 null", () => {
    expect(resultToCsv(["a", "b"], [[null, undefined]])).toContain(",\r\n");
  });
});

describe("浏览器下载", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("创建并及时回收 object URL", () => {
    const create = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:test");
    const revoke = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => {});
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});

    triggerBlobDownload(new Blob(["x"]), "t.csv");

    expect(create).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith("blob:test");
    // 挂上去又摘掉，不在页面里留残留节点
    expect(document.querySelectorAll("a[download]")).toHaveLength(0);
  });
});

describe("模板说明契约", () => {
  it("接受后端 /import-template 的返回", () => {
    const parsed = ImportTemplateInfoSchema.parse({
      product_key: "field_fence",
      product_name: "牛栏网",
      columns: [
        {
          header: "竖丝间距(cm)",
          kind: "scalar",
          target: "mesh_mm",
          required: true,
          unit: "cm",
          options: ["10", "15"],
          note: "可选值: 10 / 15",
        },
        {
          header: "丝径方案",
          kind: "variant",
          target: "wire",
          required: true,
          options: ["全丝2.0", "全丝2.5", "边丝2.5+内丝2.0"],
          note: "丝径方案",
        },
      ],
      headers: ["竖丝间距(cm)", "丝径方案"],
      required_headers: ["竖丝间距(cm)", "丝径方案"],
      max_rows: 2000,
      max_mb: 2,
      sheets: ["规格表", "示例", "填写说明"],
      data_sheet: "规格表",
      download: {
        xlsx: "/api/v1/export-quote/products/field_fence/import-template?format=xlsx",
      },
      notes: ["模板表头与导出的报价表一致"],
    });
    expect(parsed.data_sheet).toBe("规格表");
    expect(parsed.columns[0]!.unit).toBe("cm");
    expect(parsed.required_headers).toHaveLength(2);
  });

  it("可选字段缺省不报错，但 header/target 必须给", () => {
    const base = {
      product_key: "p",
      product_name: "n",
      columns: [
        { header: "h", kind: "scalar" as const, target: "t", required: false },
      ],
      headers: ["h"],
      required_headers: [],
      max_rows: 2000,
      max_mb: 2,
      data_sheet: "规格表",
      download: {},
    };
    const parsed = ImportTemplateInfoSchema.parse(base);
    expect(parsed.columns[0]!.options).toEqual([]);
    expect(parsed.columns[0]!.unit).toBe("");
    expect(parsed.sheets).toEqual([]);

    expect(() =>
      ImportTemplateInfoSchema.parse({
        ...base,
        columns: [{ kind: "scalar", required: false }],
      }),
    ).toThrow();
  });
});

describe("问题清单复制/导出（C19：错误行可下载/复制）", () => {
  const issues: ImportIssue[] = [
    {
      row: 2,
      column: "竖丝间距(cm)",
      value: "abc",
      message: "不是数字",
      severity: "error",
    },
    {
      row: 0,
      column: "",
      value: null,
      message: "重复行已跳过",
      severity: "warning",
    },
    {
      row: 2,
      column: "丝径方案",
      value: null,
      message: "不在可选值内",
      severity: "error",
    },
  ];

  it("纯文本按行分组、整表级问题排最后，且带列/值/原因", () => {
    const text = issuesToText(issues);
    expect(text).toContain("[第 2 行]");
    expect(text).toContain("竖丝间距(cm): 值「abc」，不是数字");
    // 同一行的问题聚在一起，整表问题在末尾（与界面展示同序）
    expect(text.indexOf("[第 2 行]")).toBeLessThan(text.indexOf("[整表]"));
  });

  it("CSV 带 BOM、中文表头与级别可读，且自动转义逗号/引号", () => {
    const csv = issuesToCsv(issues);
    expect(csv.startsWith("\ufeff")).toBe(true);
    expect(csv).toContain("行号,列,值,级别,问题");
    expect(csv).toContain("错误");
    expect(csv).toContain("提示");

    const tricky = issuesToCsv([
      {
        row: 1,
        column: "a,b",
        value: 'x"y',
        message: "含,逗号",
        severity: "error",
      },
    ]);
    expect(tricky).toContain('"a,b"');
    expect(tricky).toContain('"x""y"');
    expect(tricky).toContain('"含,逗号"');
  });

  it("空清单也能导出（只有表头），复制文本为空串", () => {
    expect(issuesToText([])).toBe("");
    const csv = issuesToCsv([]);
    expect(csv.startsWith("\ufeff")).toBe(true);
    expect(csv.trim().split("\r\n")).toHaveLength(1);
  });
});
