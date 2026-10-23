/**
 * mock 侧 CSV 解析/逐行校验（C29）—— 纯函数单测。
 *
 * 为什么要单独钉这些：契约测试只验 HTTP 外形，**"哪一列怎么判"** 全在这个模块里。
 * 历史上 mock 与内核漂移就是从这里开始的（阈值/枚举各抄一份）。
 * 这里只测 mock 的解析规则本身；枚举白名单由调用方传入，测里用真实真源
 * （`MOCK_ORDER_STATUSES` 等价列表 + `CURRENCIES`）避免自造一套。
 */
import { describe, expect, it } from "vitest";

import { CURRENCIES } from "@/lib/trade-doc/hardening";

import {
  IMPORT_DB_DUPLICATE_MESSAGE,
  isIsoDate,
  parseImportOrdersCsv,
  validateImportOrdersCsv,
} from "../import-orders";

const STATUSES = [
  "pending",
  "confirmed",
  "producing",
  "shipped",
  "completed",
  "cancelled",
];

function validate(text: string, existing: string[] = []) {
  return validateImportOrdersCsv(text, existing, STATUSES, CURRENCIES);
}

describe("parseImportOrdersCsv", () => {
  it("剥 UTF-8 BOM、识别双引号包裹的逗号与换行、丢弃全空行", () => {
    const text =
      "\uFEFForder_no,notes\r\n" +
      '"SO-1","含,逗号"\r\n' +
      "\r\n" +
      '"SO-2","第一行\n第二行"\r\n';

    const rows = parseImportOrdersCsv(text);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual(["order_no", "notes"]);
    expect(rows[1]).toEqual(["SO-1", "含,逗号"]);
    expect(rows[2]).toEqual(["SO-2", "第一行\n第二行"]);
  });

  it("双引号内的两个双引号 = 一个字面双引号", () => {
    const rows = parseImportOrdersCsv('order_no,notes\nSO-1,"他说""好"""');
    expect(rows[1]).toEqual(["SO-1", '他说"好"']);
  });

  it("最后一行没有换行收尾也要收进来", () => {
    const rows = parseImportOrdersCsv("order_no,order_date\nSO-1,2026-05-01");
    expect(rows).toHaveLength(2);
  });
});

describe("isIsoDate", () => {
  it.each([
    ["2026-05-01", true],
    // 内核 parse_date 取前 10 字符：带时间的 ISO 时间戳能过（mock 不能比生产更严）
    ["2026-05-01T09:00:00Z", true],
    ["2026-02-30", false],
    ["2026-13-01", false],
    ["2026-5-1", false],
    ["2026/05/01", false],
    ["", false],
  ])("%s → %s", (value, expected) => {
    expect(isIsoDate(value)).toBe(expected);
  });
});

describe("validateImportOrdersCsv", () => {
  it("表头去空格/大小写不敏感，未知列忽略，返回识别到的列", () => {
    const result = validate(
      " ORDER_NO , Order_Date ,unknown_col\nSO-1,2026-05-01,随便\n",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.columns).toEqual(["order_no", "order_date"]);
    expect(result.rows[0]).toMatchObject({
      index: 1,
      errors: [],
      data: {
        order_no: "SO-1",
        order_date: "2026-05-01",
        status: "pending",
        currency: "USD",
        total_amount: null,
        notes: null,
      },
    });
  });

  it("无表头 / 缺必填列分别给出 422 码（空字节由 handler 判 IMPORT_EMPTY_FILE）", () => {
    // 内核：`csv` 读不到任何非空行 ⇒ IMPORT_NO_HEADER（**空白文本不是空文件**）
    expect(validate("")).toMatchObject({ ok: false, code: "IMPORT_NO_HEADER" });
    expect(validate("   \n \n")).toMatchObject({
      ok: false,
      code: "IMPORT_NO_HEADER",
    });
    expect(validate("order_no\nSO-1")).toMatchObject({
      ok: false,
      code: "IMPORT_MISSING_COLUMNS",
      columns: ["order_date"],
    });
  });

  it("未知列忽略但进 warnings；重复表头按第一次出现取值", () => {
    const result = validate(
      "order_no,order_date,unknown_col,ORDER_NO\nSO-1,2026-05-01,x,y\n",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.columns).toEqual(["order_no", "order_date"]);
    expect(result.warnings).toEqual([
      "未知列已忽略：unknown_col",
      "表头列重复，按第一次出现取值：order_no",
    ]);
  });

  it("order_no 文件内重复：后出现的那行报错并指出首次出现行号", () => {
    const result = validate(
      "order_no,order_date\nSO-1,2026-05-01\nSO-1,2026-05-02\n",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows[0]?.errors).toEqual([]);
    expect(result.rows[1]?.errors.join(" ")).toContain(
      "order_no 在文件内重复（第 1 行）",
    );
  });

  it("库内已存在：该行报错 + 进 existingOrderNos（按文件顺序）", () => {
    const result = validate(
      "order_no,order_date\nSO-9,2026-05-01\nSO-8,2026-05-02\n",
      ["SO-9", "SO-8"],
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.rows.map((row) =>
        row.errors.includes(IMPORT_DB_DUPLICATE_MESSAGE),
      ),
    ).toEqual([true, true]);
    expect(result.existingOrderNos).toEqual(["SO-9", "SO-8"]);
  });

  it("金额：负数/非数字报错；合法值按两位小数收口；空 = NULL（不伪造 0）", () => {
    const result = validate(
      [
        "order_no,order_date,total_amount",
        "SO-1,2026-05-01,-1",
        "SO-2,2026-05-01,abc",
        "SO-3,2026-05-01,12.345",
        "SO-4,2026-05-01,",
      ].join("\n"),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows[0]?.errors.join(" ")).toContain("total_amount 必须 ≥ 0");
    expect(result.rows[1]?.errors.join(" ")).toContain(
      "total_amount 必须是数字",
    );
    // 内核保留 Decimal 原值（不四舍五入）
    expect(result.rows[2]?.data?.total_amount).toBe(12.345);
    expect(result.rows[3]?.data?.total_amount).toBeNull();
  });

  it("notes 超过 2000 字符报错", () => {
    const result = validate(
      "order_no,order_date,notes\nSO-1,2026-05-01," + "x".repeat(2001),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows[0]?.errors.join(" ")).toContain("notes 超过 2000 字符");
  });
});
