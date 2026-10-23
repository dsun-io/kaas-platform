/**
 * `use-import-orders` 的**纯函数**部分（C29）：multipart 组装 + 错误信封解析/翻译。
 *
 * 为什么不测 hook 本身：对话框组件测试已经用真 hook + 假 apiClient 覆盖了
 * "选客户 → 预览 → 提交"的完整链路；这里只钉两件容易漂的事：
 *   1. FormData 字段名/值口径（`file` + `customer_id` 字符串）；
 *   2. 后端 422/409 的信封**嵌套**（`{"detail":{…}}`）与扁平两种都要解析出来 ——
 *      解析错就会表现为"后端明明说了原因，前端只弹『请求失败』"。
 */
import { describe, expect, it } from "vitest";

import {
  buildImportOrdersFormData,
  describeImportOrderFailure,
  parseImportOrderFailure,
} from "../use-import-orders";

function axiosError(status: number, data: unknown) {
  return Object.assign(new Error("Request failed with status code " + status), {
    response: { status, data },
  });
}

describe("buildImportOrdersFormData", () => {
  it("字段名与内核一致：file + customer_id（数字转字符串）", () => {
    const file = new File(["order_no,order_date\n"], "orders.csv", {
      type: "text/csv",
    });
    const form = buildImportOrdersFormData({ file, customerId: 7 });

    expect(form).toBeInstanceOf(FormData);
    expect(form.get("file")).toBeInstanceOf(File);
    expect((form.get("file") as File).name).toBe("orders.csv");
    expect(form.get("customer_id")).toBe("7");
    // 字符串 id（CustomerPickerValue）同样可用
    expect(
      buildImportOrdersFormData({ file, customerId: "7" }).get("customer_id"),
    ).toBe("7");
  });
});

describe("parseImportOrderFailure", () => {
  it("嵌套信封（仓库惯例）解析出 code / rows / order_nos", () => {
    const conflict = parseImportOrderFailure(
      axiosError(409, {
        detail: {
          error: "conflict",
          code: "IMPORT_DUPLICATE_ORDER_NO",
          order_nos: ["SO-1", "SO-2"],
        },
      }),
    );
    expect(conflict).toMatchObject({
      status: 409,
      code: "IMPORT_DUPLICATE_ORDER_NO",
      orderNos: ["SO-1", "SO-2"],
      rows: [],
    });

    const invalid = parseImportOrderFailure(
      axiosError(422, {
        detail: {
          error: "validation",
          code: "IMPORT_HAS_ERRORS",
          rows: [
            { index: 2, errors: ["order_date 不能为空"] },
            {
              index: 4,
              errors: ["status 不在枚举里", "currency 不在白名单里"],
            },
          ],
        },
      }),
    );
    expect(invalid.code).toBe("IMPORT_HAS_ERRORS");
    expect(invalid.rows).toEqual([
      { index: 2, errors: ["order_date 不能为空"] },
      { index: 4, errors: ["status 不在枚举里", "currency 不在白名单里"] },
    ]);
  });

  it("扁平信封也认（docs §3 的片段写法）", () => {
    const failure = parseImportOrderFailure(
      axiosError(409, {
        error: "conflict",
        code: "IMPORT_DUPLICATE_ORDER_NO",
        order_nos: ["SO-3"],
      }),
    );
    expect(failure.code).toBe("IMPORT_DUPLICATE_ORDER_NO");
    expect(failure.orderNos).toEqual(["SO-3"]);
  });

  it("非导入错误（网络/未知）：不抛、给出兜底文案", () => {
    const failure = parseImportOrderFailure(new Error("Network Error"));
    expect(failure.status).toBeNull();
    expect(failure.code).toBeNull();
    expect(describeImportOrderFailure(failure)).toContain("导入失败");
  });
});

describe("describeImportOrderFailure", () => {
  it("409：点出重复单号与「整批未写入」", () => {
    const text = describeImportOrderFailure({
      status: 409,
      code: "IMPORT_DUPLICATE_ORDER_NO",
      message: "",
      rows: [],
      orderNos: ["SO-1", "SO-9"],
    });
    expect(text).toContain("SO-1、SO-9");
    expect(text).toContain("整批未写入");
  });

  it("422：说清还有几行不合格", () => {
    const text = describeImportOrderFailure({
      status: 422,
      code: "IMPORT_HAS_ERRORS",
      message: "",
      rows: [
        { index: 1, errors: ["x"] },
        { index: 2, errors: ["y"] },
      ],
      orderNos: [],
    });
    expect(text).toContain("2 行");
    expect(text).toContain("整批未写入");
  });

  it("缺列/空文件/无表头：交给可操作的中文原因", () => {
    const base = { status: 422, message: "", rows: [], orderNos: [] };
    expect(
      describeImportOrderFailure({ ...base, code: "IMPORT_MISSING_COLUMNS" }),
    ).toContain("缺少必填列");
    expect(
      describeImportOrderFailure({ ...base, code: "IMPORT_EMPTY_FILE" }),
    ).toContain("文件是空的");
    expect(
      describeImportOrderFailure({ ...base, code: "IMPORT_NO_HEADER" }),
    ).toContain("缺少表头行");
    expect(
      describeImportOrderFailure({ ...base, code: "CUSTOMER_NOT_FOUND" }),
    ).toContain("客户不存在");
  });

  it("未知码：用后端原文，不吞成『失败』", () => {
    expect(
      describeImportOrderFailure({
        status: 500,
        code: "SOMETHING_ELSE",
        message: "数据库连接超时",
        rows: [],
        orderNos: [],
      }),
    ).toBe("导入失败：数据库连接超时");
  });
});
