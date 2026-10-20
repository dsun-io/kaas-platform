/**
 * 手工新建线索的纯函数（C36 #18）：公司必填、邮箱格式、payload 精简、
 * 409 重复 / 404 工位未开通 / 422 字段数组的错误文案。
 */
import { describe, expect, it } from "vitest";

import {
  LEAD_FIELDS,
  emptyLeadDraft,
  formatManualLeadError,
  validateManualLeadDraft,
} from "../manual-lead";

describe("validateManualLeadDraft", () => {
  it("公司名称必填", () => {
    const result = validateManualLeadDraft(emptyLeadDraft());
    expect(result.ok).toBe(false);
    expect(result.errors.company_name).toBeTruthy();
    expect(result.payload).toEqual({});
  });

  it("邮箱格式非法时拦下（其余照常）", () => {
    const result = validateManualLeadDraft({
      ...emptyLeadDraft(),
      company_name: "ACME",
      email: "not-an-email",
    });
    expect(result.ok).toBe(false);
    expect(result.errors.email).toContain("邮箱格式");
  });

  it("trim、空串剔除、can_supply 转 boolean、place_id 可传", () => {
    const result = validateManualLeadDraft({
      ...emptyLeadDraft(),
      company_name: "  HANSA FENCE GMBH ",
      country: " DE ",
      email: " sales@hansa.example ",
      can_supply: "yes",
      place_id: "manual-expo-1",
    });
    expect(result.ok).toBe(true);
    expect(result.payload).toEqual({
      company_name: "HANSA FENCE GMBH",
      country: "DE",
      email: "sales@hansa.example",
      can_supply: true,
      place_id: "manual-expo-1",
    });
    expect(result.payload).not.toHaveProperty("city");
  });

  it("can_supply=no ⇒ false；未选 ⇒ 不传该键", () => {
    const base = { ...emptyLeadDraft(), company_name: "ACME" };
    expect(validateManualLeadDraft({ ...base, can_supply: "no" }).payload.can_supply).toBe(false);
    expect(validateManualLeadDraft(base).payload).not.toHaveProperty("can_supply");
  });

  it("字段清单 key 唯一", () => {
    const keys = LEAD_FIELDS.map((field) => field.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("formatManualLeadError", () => {
  it("409 DUPLICATE_PLACE → 重复提示（不是“请求失败”）", () => {
    const message = formatManualLeadError({
      response: {
        status: 409,
        data: { detail: { error: "conflict", code: "DUPLICATE_PLACE" } },
      },
    });
    expect(message).toContain("同一公司已存在线索");
  });

  it("404 WORKSTATION_NOT_SUBSCRIBED → 指向开通工位", () => {
    const message = formatManualLeadError({
      response: {
        status: 404,
        data: {
          detail: {
            error: "not_found",
            code: "WORKSTATION_NOT_SUBSCRIBED",
            message: "线索开发工位未开通",
          },
        },
      },
    });
    expect(message).toContain("工位未开通");
  });

  it("422 detail 数组 → 字段级中文", () => {
    const message = formatManualLeadError({
      response: {
        status: 422,
        data: {
          detail: [
            { loc: ["body", "company_name"], msg: "Field required", type: "missing" },
          ],
        },
      },
    });
    expect(message).toContain("公司名称：Field required");
  });
});
