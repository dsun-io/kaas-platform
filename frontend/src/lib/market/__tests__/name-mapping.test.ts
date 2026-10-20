/**
 * 品名对照纯函数（C36 #19）：草稿校验、中英两行构造、重复判定。
 */
import { describe, expect, it } from "vitest";

import {
  buildNameMappingRows,
  describeDuplicate,
  EMPTY_NAME_MAPPING_DRAFT,
  isDuplicateMapping,
  parseAltNames,
  validateNameMappingDraft,
  type ExistingNameMapping,
} from "../name-mapping";

describe("validateNameMappingDraft", () => {
  it("中英文都没填 → 报错；地区必填", () => {
    expect(validateNameMappingDraft(EMPTY_NAME_MAPPING_DRAFT)).toEqual([
      "中文品名或英文品名至少填一个",
      "地区必填",
    ]);
  });

  it("类目必须是正整数、HS 格式校验；合法草稿无错", () => {
    expect(
      validateNameMappingDraft({
        ...EMPTY_NAME_MAPPING_DRAFT,
        localNameZh: "勾花网",
        regionCode: "de",
        categoryId: "abc",
        hsCode: "12",
      }),
    ).toEqual(["类目 id 必须是正整数", "HS 编码格式不对（4–12 位数字，可带小数）"]);

    expect(
      validateNameMappingDraft({
        ...EMPTY_NAME_MAPPING_DRAFT,
        localNameEn: "chain link fence",
        regionCode: "DE",
        categoryId: "3",
        hsCode: "7314.41",
      }),
    ).toEqual([]);
  });
});

describe("buildNameMappingRows", () => {
  it("中文/英文各自成行，地区 upper、类目转数字、别名去重", () => {
    const rows = buildNameMappingRows({
      localNameZh: " 勾花网 ",
      localNameEn: "chain link fence",
      regionCode: "de",
      categoryId: "3",
      altNames: "malla, wire mesh, malla",
      hsCode: "7314.41",
      isVerified: true,
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      lang: "zh",
      local_name: "勾花网",
      region_code: "DE",
      category_id: 3,
      alt_names: ["malla", "wire mesh"],
      hs_code: "7314.41",
      source: "manual",
      is_verified: true,
    });
    expect(rows[1]).toMatchObject({ lang: "en", local_name: "chain link fence" });
  });

  it("只填一种语言 → 只建一行；类目留空为 null", () => {
    const rows = buildNameMappingRows({
      ...EMPTY_NAME_MAPPING_DRAFT,
      localNameZh: "勾花网",
      regionCode: "US",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.category_id).toBeNull();
  });
});

describe("isDuplicateMapping", () => {
  const existing: ExistingNameMapping[] = [
    { id: 1, lang: "zh", local_name: "勾花网", region_code: "DE", category_id: 3 },
  ];
  const row = buildNameMappingRows({
    ...EMPTY_NAME_MAPPING_DRAFT,
    localNameZh: " 勾花网 ",
    regionCode: "de",
  })[0]!;

  it("同地区 + 同语言 + 同品名（忽略大小写/空格）→ 重复", () => {
    expect(isDuplicateMapping(existing, row)).toBe(true);
    expect(describeDuplicate(row)).toBe("勾花网（中文 / DE）");
  });

  it("语言或地区不同 → 不重复", () => {
    expect(isDuplicateMapping(existing, { ...row, lang: "en" })).toBe(false);
    expect(isDuplicateMapping(existing, { ...row, region_code: "US" })).toBe(
      false,
    );
  });
});

describe("parseAltNames", () => {
  it("按中英文逗号/分号/换行切分并去重", () => {
    expect(parseAltNames("a, b，c;d；e\nf,a")).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
    ]);
  });
});
