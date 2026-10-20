/**
 * Leadgen CSV 导入纯函数（C36 #17）。
 *
 * 钉住：multipart 字段名 `csv_file`（与后端 `File(...)` 逐字一致）、本地预检
 * （未选/非 csv/空文件），以及 422/402 错误的原文透出。
 */
import { describe, expect, it } from "vitest";

import {
  LEADGEN_CSV_FIELD,
  buildLeadgenCsvForm,
  leadgenImportErrorMessage,
  validateLeadgenCsvFile,
} from "../csv-import";

function csvFile(name = "leads.csv", content = "company_name\nACME\n"): File {
  return new File([content], name, { type: "text/csv" });
}

describe("validateLeadgenCsvFile", () => {
  it("未选文件 / 非 .csv / 空文件都给明确原因", () => {
    expect(validateLeadgenCsvFile(null)).toContain("请选择");
    expect(validateLeadgenCsvFile(csvFile("leads.xlsx"))).toContain(".csv");
    expect(validateLeadgenCsvFile(csvFile("leads.csv", ""))).toContain("空");
  });

  it("合法 csv 通过预检", () => {
    expect(validateLeadgenCsvFile(csvFile())).toBeNull();
  });
});

describe("buildLeadgenCsvForm", () => {
  it("字段名固定 csv_file（名字不对后端会 422）", () => {
    const file = csvFile();
    const form = buildLeadgenCsvForm(file);
    expect(LEADGEN_CSV_FIELD).toBe("csv_file");
    // jsdom 的 FormData 会克隆 File（不是同一对象），按名字/大小断言
    const stored = form.get("csv_file") as File;
    expect(stored.name).toBe("leads.csv");
    expect(stored.size).toBe(file.size);
  });
});

describe("leadgenImportErrorMessage", () => {
  it("嵌套 detail（422 CSV_REQUIRED）与扁平 402 都取到文案", () => {
    expect(
      leadgenImportErrorMessage(
        Object.assign(new Error("x"), {
          response: {
            status: 422,
            data: {
              detail: {
                error: "validation",
                code: "CSV_REQUIRED",
                detail: "source=csv 需上传 CSV 文件",
              },
            },
          },
        }),
      ),
    ).toBe("source=csv 需上传 CSV 文件");

    expect(
      leadgenImportErrorMessage(
        Object.assign(new Error("y"), {
          response: {
            status: 402,
            data: {
              error: "forbidden",
              code: "WORKSTATION_NOT_SUBSCRIBED",
              message: "该工位未开通",
            },
          },
        }),
      ),
    ).toBe("该工位未开通");
  });
});
