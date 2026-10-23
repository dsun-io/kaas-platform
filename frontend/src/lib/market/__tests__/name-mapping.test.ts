/**
 * 品名对照纯函数（C36 #19 → B2）：草稿校验、中英两行构造、重复判定、
 * 分页查询串、编辑草稿/PATCH 体、删除后回页。
 */
import { describe, expect, it } from "vitest";

import {
  buildNameMappingListQuery,
  buildNameMappingPatch,
  buildNameMappingRows,
  describeDuplicate,
  EMPTY_NAME_MAPPING_DRAFT,
  isDuplicateMapping,
  isValidHsCode,
  NAME_MAPPING_PAGE_SIZE,
  nameMappingListUrl,
  pageAfterRemove,
  parseAltNames,
  toNameMappingEditDraft,
  validateNameMappingDraft,
  validateNameMappingEditDraft,
  type ExistingNameMapping,
  type NameMappingRow,
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
    ).toEqual([
      "类目 id 必须是正整数",
      "HS 编码格式不对（4–12 位数字，可带小数）",
    ]);

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
    expect(rows[1]).toMatchObject({
      lang: "en",
      local_name: "chain link fence",
    });
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
    {
      id: 1,
      lang: "zh",
      local_name: "勾花网",
      region_code: "DE",
      category_id: 3,
    },
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

describe("buildNameMappingListQuery / nameMappingListUrl", () => {
  it("page/page_size 一定下发；空 q / 空筛选不下发（空 q = 最近记录）", () => {
    expect(
      buildNameMappingListQuery({ page: 1, pageSize: NAME_MAPPING_PAGE_SIZE }),
    ).toBe("page=1&page_size=20");
    expect(
      buildNameMappingListQuery({
        page: 3,
        pageSize: 20,
        q: "   ",
        regionCode: "",
        lang: "",
      }),
    ).toBe("page=3&page_size=20");
  });

  it("q 去空格、region 转大写、lang 原样；URL 带 /market 前缀", () => {
    expect(
      nameMappingListUrl({
        page: 2,
        pageSize: 20,
        q: " chain link ",
        regionCode: "de",
        lang: "en",
      }),
    ).toBe(
      "/market/name-mappings?page=2&page_size=20&q=chain+link&region_code=DE&lang=en",
    );
  });

  it("非法 page / pageSize 夹到 >= 1（不把 page=0 发给后端）", () => {
    expect(buildNameMappingListQuery({ page: 0, pageSize: 0 })).toBe(
      "page=1&page_size=20",
    );
  });
});

describe("pageAfterRemove", () => {
  it("删掉本页最后一条时回退一页（第 1 页不回退）", () => {
    expect(pageAfterRemove(3, 1)).toBe(2);
    expect(pageAfterRemove(1, 1)).toBe(1);
    expect(pageAfterRemove(2, 5)).toBe(2);
    expect(pageAfterRemove(0, 1)).toBe(1);
  });
});

const ROW: NameMappingRow = {
  id: 7,
  category_id: 3,
  region_code: "de-nw",
  lang: "de",
  local_name: "Doppelstabmattenzaun",
  alt_names: ["Doppelstabzaun"],
  hs_code: "7314490000",
  source: "seed",
  confidence: "high",
  is_verified: true,
};

describe("toNameMappingEditDraft", () => {
  it("预填 5 个可编辑字段；语言原样保留（de 不能悄悄改成 en）", () => {
    expect(toNameMappingEditDraft(ROW)).toEqual({
      localName: "Doppelstabmattenzaun",
      lang: "de",
      regionCode: "DE-NW",
      hsCode: "7314490000",
      isVerified: true,
    });
  });

  it("hs_code 为 null → 空串（清空后再保存即显式 null）", () => {
    expect(toNameMappingEditDraft({ ...ROW, hs_code: null }).hsCode).toBe("");
  });
});

describe("validateNameMappingEditDraft", () => {
  const base = toNameMappingEditDraft(ROW);

  it("品名/地区必填，HS 格式同新增口径", () => {
    expect(
      validateNameMappingEditDraft({
        ...base,
        localName: " ",
        regionCode: "",
        hsCode: "12",
      }),
    ).toEqual([
      "品名必填",
      "地区必填",
      "HS 编码格式不对（4–12 位数字，可带小数）",
    ]);
  });

  it("合法草稿无错；语言空串报错", () => {
    expect(validateNameMappingEditDraft(base)).toEqual([]);
    expect(validateNameMappingEditDraft({ ...base, lang: "" })).toEqual([
      "语言必填",
    ]);
  });

  it("isValidHsCode：空串合法，4–12 位数字可带小数", () => {
    expect(isValidHsCode("")).toBe(true);
    expect(isValidHsCode("7314.41")).toBe(true);
    expect(isValidHsCode("731")).toBe(false);
    expect(isValidHsCode("7314490000123")).toBe(false);
  });
});

describe("buildNameMappingPatch", () => {
  it("trim + region upper；HS 清空 → null（部分 PATCH 体）", () => {
    expect(
      buildNameMappingPatch({
        localName: "  chain link fence ",
        lang: "en",
        regionCode: " us-ca ",
        hsCode: " ",
        isVerified: false,
      }),
    ).toEqual({
      local_name: "chain link fence",
      lang: "en",
      region_code: "US-CA",
      hs_code: null,
      is_verified: false,
    });
  });
});
