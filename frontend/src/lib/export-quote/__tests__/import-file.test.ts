import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  buildImportFormData,
  canCalculate,
  describeIssue,
  filenameFromDisposition,
  groupIssues,
  MULTIPART_CONFIG,
  resultToCsv,
  summarizeResult,
  templateFilename,
  templateUrl,
  triggerBlobDownload,
  validateFile,
} from "@/lib/export-quote/import-file";
import { ImportTemplateInfoSchema } from "@contracts/export-quote";
import type {
  ImportCalculateResponse,
  ImportIssue,
  ImportPreviewResponse,
} from "@contracts/export-quote";

function fileOf(name: string, bytes = 1024, type = ""): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

describe("模板下载地址", () => {
  it("拼出与后端路由一致、且带产品与格式的地址", () => {
    expect(templateUrl("field_fence", "xlsx")).toBe(
      "/export-quote/import/template?product_key=field_fence&format=xlsx",
    );
  });

  it("能附加示例行数等额外参数", () => {
    const url = templateUrl("field_fence", "csv", { examples: 0 });
    expect(url).toContain("format=csv");
    expect(url).toContain("examples=0");
    expect(url).toContain("product_key=field_fence");
  });

  it("兜底文件名与后端 Content-Disposition 口径一致", () => {
    expect(templateFilename("field_fence", "xlsx")).toBe(
      "field_fence-import-template.xlsx",
    );
  });
});

describe("上传表单", () => {
  it("文件与计算参数一起走 multipart", () => {
    const fd = buildImportFormData(
      fileOf("specs.xlsx"),
      { fx_rate: 6.7019, orders: [{ total: 30000, unit: "m" }] },
      { productKey: "field_fence", view: "internal" },
    );
    expect(fd.get("file")).toBeInstanceOf(File);
    expect(fd.get("product_key")).toBe("field_fence");
    expect(fd.get("view")).toBe("internal");
    expect(JSON.parse(String(fd.get("payload")))).toEqual({
      fx_rate: 6.7019,
      orders: [{ total: 30000, unit: "m" }],
    });
  });

  it("没给视图时不塞空字段", () => {
    const fd = buildImportFormData(fileOf("a.csv"), {}, { productKey: "p" });
    expect(fd.get("view")).toBeNull();
    expect(fd.get("sheet")).toBeNull();
  });

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

describe("可算判断", () => {
  const preview = (usable: number) =>
    ({ usable_rows: usable }) as ImportPreviewResponse;

  it("至少要有一行可用", () => {
    expect(canCalculate(null)).toBe(false);
    expect(canCalculate(preview(0))).toBe(false);
    expect(canCalculate(preview(3))).toBe(true);
  });
});

describe("结果摘要", () => {
  const result = (over: Record<string, unknown> = {}) =>
    ({
      meta: {
        totals: { total_weight_kg: "19620.6000", total_price: "90309.00" },
        orders: [],
        ...(over.meta as object),
      },
      import: {
        source_name: "a.xlsx",
        total_data_rows: 50,
        usable_rows: 48,
        skipped_rows: 2,
        mapping: {},
        ignored_columns: [],
        issues: [
          {
            row: 3,
            column: "工艺",
            value: "x",
            message: "m",
            severity: "error",
          },
          {
            row: 4,
            column: "工艺",
            value: "y",
            message: "m",
            severity: "warning",
          },
        ],
      },
      ...over,
    }) as unknown as ImportCalculateResponse;

  it("行数与错误数取自导入摘要", () => {
    const s = summarizeResult(result());
    expect(s.rows).toBe(48);
    expect(s.errors).toBe(1);
    expect(s.warnings).toBe(1);
  });

  it("总净重与总价直接读合计，不前端重算", () => {
    const s = summarizeResult(result());
    expect(s.totalWeightKg).toBeCloseTo(19620.6, 6);
    expect(s.totalPrice).toBeCloseTo(90309, 6);
  });

  it("没有合计时退回按订单量累加，仍不自己乘算", () => {
    const s = summarizeResult(
      result({
        meta: {
          orders: [{ total_weight_kg: "100.5" }, { total_weight_kg: "200" }],
        },
      }),
    );
    expect(s.totalWeightKg).toBeCloseTo(300.5, 6);
  });

  it("结果为空时给可展示的零值而不是崩", () => {
    const s = summarizeResult(null, 7);
    expect(s).toEqual({
      rows: 7,
      errors: 0,
      warnings: 0,
      totalWeightKg: null,
      totalPrice: null,
      totalPriceFx: null,
    });
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

describe("文件名解析", () => {
  it("优先用 filename*（UTF-8 中文名）", () => {
    expect(
      filenameFromDisposition(
        "attachment; filename=\"t.xlsx\"; filename*=UTF-8''%E7%89%9B%E6%A0%8F%E7%BD%91.xlsx",
        "fallback.xlsx",
      ),
    ).toBe("牛栏网.xlsx");
  });

  it("退回普通 filename", () => {
    expect(
      filenameFromDisposition(
        'attachment; filename="field_fence-import-template.xlsx"',
        "f.xlsx",
      ),
    ).toBe("field_fence-import-template.xlsx");
  });

  it("跨域看不到该响应头时用本地兜底名，不让下载失败", () => {
    expect(filenameFromDisposition(undefined, "f.xlsx")).toBe("f.xlsx");
    expect(filenameFromDisposition("attachment", "f.csv")).toBe("f.csv");
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
        xlsx: "/api/v1/export-quote/import/template?product_key=field_fence&format=xlsx",
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
