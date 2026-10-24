/**
 * 报价行英文名选择 · 纯函数单测（A 项 2026-10-24）。
 *
 * 覆盖两件与 UI 无关、但决定"本单用哪个英文名"的判断：
 *  1. 下拉选项 = 去空白/丢空串/大小写去重、默认名在前；
 *  2. 客户历史偏好 → 本次默认名（命中才采用，否则产品默认名）；
 *  3. 换客户：**手动选过的行保留**、未手动行清空重解析。
 */
import { describe, expect, it } from "vitest";

import { newLineDraft, type LineDraft } from "../../components/quote-line-card";
import {
  dedupeNameOptions,
  resetNameOnCustomerChange,
  resolveDefaultNameEn,
} from "../product-name-selection";

function line(overrides: Partial<LineDraft> = {}): LineDraft {
  return { ...newLineDraft("field_fence"), ...overrides };
}

describe("dedupeNameOptions（下拉选项）", () => {
  it("默认名在前，去空白、丢空串、大小写不敏感去重（保留首次写法）", () => {
    expect(
      dedupeNameOptions("Cattle Fence", [
        "Field Fence",
        " cattle fence ",
        "",
        "   ",
        "FIELD FENCE",
      ]),
    ).toEqual(["Cattle Fence", "Field Fence"]);
  });

  it("没有默认名时只用别名（旧数据 name_en 可能为空）", () => {
    expect(dedupeNameOptions("", ["Chain Link"])).toEqual(["Chain Link"]);
  });

  it("别名缺省/为 null 时等同于只有默认名", () => {
    expect(dedupeNameOptions("Cattle Fence", undefined)).toEqual([
      "Cattle Fence",
    ]);
    expect(dedupeNameOptions("Cattle Fence", null)).toEqual(["Cattle Fence"]);
  });

  it("全空 → 空数组（调用方据此不落任何名字）", () => {
    expect(dedupeNameOptions("", [])).toEqual([]);
    expect(dedupeNameOptions(null, [""])).toEqual([]);
  });
});

describe("resolveDefaultNameEn（客户偏好 → 本单默认名）", () => {
  const options = ["Cattle Fence", "Field Fence"];

  it("偏好命中 → 采用偏好名（大小写不敏感，返回选项里的写法）", () => {
    expect(resolveDefaultNameEn(options, "field fence")).toBe("Field Fence");
    expect(resolveDefaultNameEn(options, "  CATTLE FENCE  ")).toBe(
      "Cattle Fence",
    );
  });

  it("无历史 / 空偏好 → 产品默认英文名（第一项）", () => {
    expect(resolveDefaultNameEn(options, null)).toBe("Cattle Fence");
    expect(resolveDefaultNameEn(options, undefined)).toBe("Cattle Fence");
    expect(resolveDefaultNameEn(options, "")).toBe("Cattle Fence");
  });

  it("偏好名不在本产品英文名里（改过名）→ 回落默认名，不写不存在的名", () => {
    expect(resolveDefaultNameEn(options, "Old Fence")).toBe("Cattle Fence");
  });

  it("没有任何选项 → 空串（调用方回落 formulas 默认名/中文名）", () => {
    expect(resolveDefaultNameEn([], "Field Fence")).toBe("");
  });
});

describe("resetNameOnCustomerChange（换客户）", () => {
  it("手动选过的行原样保留（同一个对象，不被改写）", () => {
    const manual = line({ nameEn: "Field Fence", nameEnManual: true });
    const cleared = line({ nameEn: "Cattle Fence" });
    const result = resetNameOnCustomerChange([manual, cleared]);
    const kept = result[0]!;
    const reset = result[1]!;
    expect(kept).toBe(manual);
    expect(kept.nameEn).toBe("Field Fence");
    expect(kept.nameEnManual).toBe(true);
    expect(reset.nameEn).toBe("");
    // 其它字段不受影响
    expect(reset.productKey).toBe("field_fence");
  });

  it("未手动且已有名的行清空 nameEn，但保留 nameEnManual=false", () => {
    const l = line({ nameEn: "Cattle Fence", nameEnManual: false });
    const next = resetNameOnCustomerChange([l])[0]!;
    expect(next).not.toBe(l);
    expect(next.nameEn).toBe("");
    expect(next.nameEnManual).toBe(false);
  });

  it("本来就空的行不变（不制造无意义的 re-render）", () => {
    const l = line({ nameEn: "" });
    const input = [l];
    const out = resetNameOnCustomerChange(input);
    expect(out).toBe(input);
    expect(out[0]).toBe(l);
  });

  it("整表都没有需要清的行 → 返回同一个数组引用", () => {
    const input = [
      line({ nameEn: "Field Fence", nameEnManual: true }),
      line({ nameEn: "" }),
    ];
    expect(resetNameOnCustomerChange(input)).toBe(input);
  });
});
