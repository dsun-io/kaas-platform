/**
 * 企业信息页纯规则（2026-10-22）。
 *
 * 钉住三件事：
 * 1. 公司税号（tax_id）归一化与校验：trim + 大写，空允许，非空必须 6–32 位 [0-9A-Z]；
 * 2. 保存 payload 含新字段（tax_id / 中英银行栏），空串转 null；
 * 3. 公章写入权限与「团队管理员」同口径（修掉 account_type==='internal' 的老 bug）。
 */
import { describe, expect, it } from "vitest";

import {
  buildCompanyProfileSavePayload,
  canManageCompanySeals,
  normalizeSwiftCode,
  normalizeTaxId,
  TAX_ID_PATTERN,
} from "../company-profile-rules";

describe("normalizeTaxId（公司税号归一化）", () => {
  it("去首尾空格并转大写", () => {
    expect(normalizeTaxId(" 91131125ma0ga4242u ")).toBe("91131125MA0GA4242U");
  });

  it("null/undefined/空串 → 空串（不造出不存在的值）", () => {
    expect(normalizeTaxId(null)).toBe("");
    expect(normalizeTaxId(undefined)).toBe("");
    expect(normalizeTaxId("   ")).toBe("");
  });

  it("6–32 位大写字母/数字才算合法税号", () => {
    expect(TAX_ID_PATTERN.test("91131125MA0GA4242U")).toBe(true);
    expect(TAX_ID_PATTERN.test("ABC123")).toBe(true);
    expect(TAX_ID_PATTERN.test("ABC12")).toBe(false); // 太短
    expect(TAX_ID_PATTERN.test("91131125MA0GA4242U-1")).toBe(false); // 带连字符
    expect(TAX_ID_PATTERN.test("91131125ma0ga4242u")).toBe(false); // 未归一化的小写
  });
});

describe("normalizeSwiftCode", () => {
  it("去空格并转大写", () => {
    expect(normalizeSwiftCode(" bkchcnbj220 ")).toBe("BKCHCNBJ220");
  });
});

describe("buildCompanyProfileSavePayload（保存 payload）", () => {
  it("含新字段：税号大写、中英银行栏原样带上", () => {
    const result = buildCompanyProfileSavePayload({
      name_en: "  ANPING KAAS WIRE MESH CO., LTD.  ",
      tax_id: " 91131125ma0ga4242u ",
      bank_name: "Bank of China, Anping Sub-branch",
      bank_address_en: "Anping County, Hengshui, Hebei, China",
      bank_name_zh: "中国银行安平支行",
      bank_address_zh: "河北省衡水市安平县",
      bank_account: "1234567890",
      swift_code: " bkchcnbj220 ",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.name_en).toBe("ANPING KAAS WIRE MESH CO., LTD.");
    expect(result.payload.tax_id).toBe("91131125MA0GA4242U");
    expect(result.payload.bank_name_zh).toBe("中国银行安平支行");
    expect(result.payload.bank_address_en).toBe(
      "Anping County, Hengshui, Hebei, China",
    );
    expect(result.payload.swift_code).toBe("BKCHCNBJ220");
  });

  it("税号允许为空 → null（清空字段的语义是「没有」）", () => {
    const result = buildCompanyProfileSavePayload({
      name_en: "ACME CO., LTD.",
      tax_id: "   ",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.tax_id).toBeNull();
  });

  it("税号非法 → 不提交并给出可读错误", () => {
    const result = buildCompanyProfileSavePayload({
      name_en: "ACME CO., LTD.",
      tax_id: "ABC-123",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("公司税号");
  });

  it("公司英文名必填（单据卖方主体名）", () => {
    const result = buildCompanyProfileSavePayload({ name_en: "  " });
    expect(result.ok).toBe(false);
  });

  it("SWIFT 校验保留：8 或 11 位，空允许", () => {
    expect(
      buildCompanyProfileSavePayload({
        name_en: "ACME CO., LTD.",
        swift_code: "BKCHCNBJ",
      }).ok,
    ).toBe(true);
    const bad = buildCompanyProfileSavePayload({
      name_en: "ACME CO., LTD.",
      swift_code: "BKCHCNBJ2",
    });
    expect(bad.ok).toBe(false);
  });
});

describe("canManageCompanySeals（公章写入权限 bug 回归）", () => {
  it("团队管理员可写、成员只读", () => {
    expect(canManageCompanySeals(true)).toBe(true);
    expect(canManageCompanySeals(false)).toBe(false);
  });

  // 老 bug 的口径差异（回归说明）：
  //   旧：canManageSeals = user.account_type === 'internal'
  //       ⇒ 团队管理员（客户账号）看不到公章写入口，成员反而能写；
  //   新：canManageSeals = canEdit = useTeam().isTeamAdmin
  //       ⇒ 与后端 _require_team_admin 同口径（管理员可写、成员只读）。
});
