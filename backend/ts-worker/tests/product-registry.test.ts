/**
 * 产品注册表展示字段镜像的冻结测试（src/product-registry.ts）。
 *
 * 真源 = backend/kaas_common/export_quote/products/*.py 的 ProductSpec 标量。
 * 本测试**故意写死快照**：Python 侧改产品名/品类编码时会红，迫使两边同 PR 同步，
 * 避免"产品页显示的名字与内核不一致"（P0 直连读之后这个风险从内核上移到门面）。
 */
import { describe, expect, it } from "vitest";

import { PRODUCT_KEYS, PRODUCT_REGISTRY } from "../src/product-registry";

describe("产品注册表标量镜像（真源 kaas_common/export_quote/products/*.py）", () => {
  it("清单顺序 = Python keys() 的 sorted(_REGISTRY)（products/__init__.py:38）", () => {
    expect([...PRODUCT_KEYS]).toEqual(["chain_link", "deer_net", "field_fence"]);
    // 与注册表键集一一对应（不多不少）
    expect(new Set(PRODUCT_KEYS)).toEqual(new Set(Object.keys(PRODUCT_REGISTRY)));
  });

  it("三个产品的 name / name_en / category_code 与 ProductSpec 逐字一致", () => {
    // chain_link.py:47-50 / deer_net.py:58-61 / field_fence.py:51-54
    expect(PRODUCT_REGISTRY).toEqual({
      chain_link: {
        key: "chain_link",
        name: "勾花网",
        nameEn: "Chain Link Fence",
        categoryCode: "gouhuawang",
      },
      deer_net: {
        key: "deer_net",
        name: "鹿网",
        nameEn: "Deer Net",
        categoryCode: "luwang",
      },
      field_fence: {
        key: "field_fence",
        name: "牛栏网",
        nameEn: "Field Fence",
        categoryCode: "niulanwang",
      },
    });
  });
});
