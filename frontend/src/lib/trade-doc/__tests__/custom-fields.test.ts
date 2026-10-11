import { describe, it, expect } from "vitest";

import {
  buildCustom,
  buildPayloadPatch,
  controlFor,
  isProtectedField,
  listCustomFields,
  parseInput,
  toInputText,
} from "../custom-fields";

describe("字段清单来自 manifest（不硬编码第二份）", () => {
  it("PI 的字段都在，且类型推导正确", () => {
    const fields = listCustomFields("pi");
    const byName = Object.fromEntries(fields.map((f) => [f.name, f.control]));
    expect(byName.pi_no).toBe("text");
    expect(byName.pi_date).toBe("date");
    expect(byName.currency).toBe("text");
    expect(byName.items).toBe("json");
    expect(byName.company_stamp).toBe("image");
    expect(byName.product_photos).toBe("json");
    expect(byName.buyer_confirmation).toBe("boolean");
  });

  it("未知单证类型返回空清单（不抛异常）", () => {
    expect(listCustomFields("nope")).toEqual([]);
  });

  it("未知 type 退回纯文本，不静默丢字段", () => {
    expect(controlFor("something_new")).toBe("text");
    expect(controlFor(undefined)).toBe("text");
  });
});

describe("回填与解析", () => {
  it("对象/数组按缩进 JSON 回填，标量按原文", () => {
    expect(toInputText({ a: 1 })).toBe('{\n  "a": 1\n}');
    expect(toInputText(120)).toBe("120");
    expect(toInputText(null)).toBe("");
  });

  it("空串 = 不填；数字/JSON 非法时报错而不是静默取 0", () => {
    expect(parseInput("text", "  ")).toEqual({ ok: true, value: undefined });
    expect(parseInput("number", "182").value).toBe(182);
    expect(parseInput("number", "abc").ok).toBe(false);
    expect(parseInput("json", "{bad").ok).toBe(false);
    expect(parseInput("json", "[1,2]").value).toEqual([1, 2]);
    expect(parseInput("boolean", "true").value).toBe(true);
    expect(parseInput("boolean", "false").value).toBe(false);
    expect(parseInput("image", "data:image/png;base64,AAA").value).toBe(
      "data:image/png;base64,AAA",
    );
  });
});

describe("组包（两个坑各一条测试）", () => {
  it("受保护字段（金额/行项）在界面就被挡住，前端不把它送上去", () => {
    expect(isProtectedField("items")).toBe(true);
    expect(isProtectedField("total_amount")).toBe(true);
    expect(isProtectedField("remarks")).toBe(false);
    const custom = buildCustom(
      { remarks: "旧" },
      { items: [{ product_name: "假行项" }], total_amount: 999999, remarks: "新" },
    );
    expect(custom).toEqual({ remarks: "新" });
  });

  it("字段清单标出受保护项（供界面渲染成只读）", () => {
    const byName = Object.fromEntries(
      listCustomFields("pi").map((f) => [f.name, f.protected]),
    );
    expect(byName.items).toBe(true);
    expect(byName.total_amount).toBe(true);
    expect(byName.remarks).toBe(false);
  });

  it("空值删除键，而不是写空串/null", () => {
    const custom = buildCustom(
      { pi_no: "P-1", remarks: "旧备注", shipping_marks: "X" },
      { remarks: undefined, shipping_marks: "N/M", currency: "CNY" },
    );
    expect(custom).toEqual({ pi_no: "P-1", shipping_marks: "N/M", currency: "CNY" });
  });

  it("PATCH 必须带上 sources，否则上游快照被整块替换掉", () => {
    const payload = {
      sources: { order: { order_no: "SO-1" } },
      custom: { pi_no: "P-1" },
    };
    const patch = buildPayloadPatch(payload, { pi_no: "P-2" });
    expect(patch.sources).toEqual({ order: { order_no: "SO-1" } });
    expect(patch.custom).toEqual({ pi_no: "P-2" });
  });

  it("原本没有 raw_payload 时也能组出合法结构", () => {
    expect(buildPayloadPatch(null, { currency: "CNY" })).toEqual({
      custom: { currency: "CNY" },
    });
  });
});
