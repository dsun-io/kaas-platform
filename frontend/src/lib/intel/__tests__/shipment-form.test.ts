/**
 * 手工新增情报货运的表单纯函数（C36 #16）：必填/数字校验、datetime 转换、payload 精简、
 * 后端 422 字段数组 → 中文文案。
 */
import { describe, expect, it } from "vitest";

import {
  SHIPMENT_FIELDS,
  emptyShipmentDraft,
  formatShipmentError,
  validateShipmentDraft,
} from "../shipment-form";

describe("validateShipmentDraft", () => {
  it("三个必填为空时报字段级错误", () => {
    const result = validateShipmentDraft(emptyShipmentDraft());
    expect(result.ok).toBe(false);
    expect(Object.keys(result.errors).sort()).toEqual([
      "consignee",
      "product_desc",
      "shipper",
    ]);
    expect(result.payload).toEqual({});
  });

  it("合法草稿：trim、数字转 number、ship_date 转 datetime", () => {
    const result = validateShipmentDraft({
      ...emptyShipmentDraft(),
      shipper: "  ANPING KAAS  ",
      consignee: "HANSA FENCE",
      product_desc: " chain link fence ",
      ship_date: "2026-10-12",
      qty: " 120 ",
      gross_weight_kg: "18600.5",
      carrier: "COSCO",
    });
    expect(result.ok).toBe(true);
    expect(result.payload).toMatchObject({
      shipper: "ANPING KAAS",
      consignee: "HANSA FENCE",
      product_desc: "chain link fence",
      ship_date: "2026-10-12T00:00:00",
      qty: 120,
      gross_weight_kg: 18600.5,
      carrier: "COSCO",
    });
    // 空字段不传（后端 exclude_none 语义）
    expect(result.payload).not.toHaveProperty("net_weight_kg");
  });

  it("数字字段非数字 ⇒ 字段级错误，不进入 payload", () => {
    const result = validateShipmentDraft({
      ...emptyShipmentDraft(),
      shipper: "S",
      consignee: "C",
      product_desc: "P",
      qty: "abc",
      volume_cbm: "2.5",
    });
    expect(result.ok).toBe(false);
    expect(result.errors.qty).toContain("必须是数字");
    expect(result.payload.qty).toBeUndefined();
    expect(result.payload.volume_cbm).toBe(2.5);
  });

  it("表单字段清单齐全（分组展开后 key 唯一）", () => {
    const keys = SHIPMENT_FIELDS.map((field) => field.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(expect.arrayContaining(["shipper", "consignee", "product_desc"]));
  });
});

describe("formatShipmentError", () => {
  it("FastAPI 422 detail 数组 → 字段级中文", () => {
    const message = formatShipmentError({
      response: {
        status: 422,
        data: {
          detail: [
            { loc: ["body", "qty"], msg: "Input should be a valid number", type: "float_parsing" },
            { loc: ["body", "shipper"], msg: "Field required", type: "missing" },
          ],
        },
      },
    });
    expect(message).toContain("数量：Input should be a valid number");
    expect(message).toContain("发货人：Field required");
  });

  it("非 422 回退到 normalizeApiError 的 message", () => {
    const message = formatShipmentError(
      Object.assign(new Error("boom"), {
        response: { status: 500, data: {} },
      }),
    );
    expect(message).toBeTruthy();
  });
});
