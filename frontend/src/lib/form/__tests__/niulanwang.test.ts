import { describe, it, expect } from "vitest";
import {
  NIULANWANG_SKU_AXES,
  NIULANWANG_COMBO_COUNT,
  NIULANWANG_VOLUME_MODEL,
  NIULANWANG_METRIC_CODES,
  NIULANWANG_DESCRIPTIVE,
  WAVE_ADD_KG_PER_100M,
  niulanwangComboCount,
  wireOptionOf,
  waveAddKg,
  cylinderVolumePerRoll,
  boxVolumePerRoll,
} from "@contracts/niulanwang";

describe("牛栏网规格轴", () => {
  it("恰好 5 个 SKU 轴", () => {
    expect(Object.keys(NIULANWANG_SKU_AXES)).toHaveLength(5);
  });

  it("各轴取值数相乘 = 48 组合", () => {
    expect(niulanwangComboCount()).toBe(48);
    expect(niulanwangComboCount()).toBe(NIULANWANG_COMBO_COUNT);
  });

  it("三个丝径方案会同时定下卷长与卷径", () => {
    const all20 = wireOptionOf("all_wire_20");
    expect(all20).toBeDefined();
    expect(all20!.rollLengthM).toBe(100);
    expect(all20!.rollDiameterCm).toBe(30);

    // 全丝2.5 用 50 米卷、卷径 25cm —— 这就是「一选全变」
    const all25 = wireOptionOf("all_wire_25");
    expect(all25!.rollLengthM).toBe(50);
    expect(all25!.rollDiameterCm).toBe(25);

    const mixed = wireOptionOf("edge25_inner20");
    expect(mixed!.edgeWireMm).toBe(2.5);
    expect(mixed!.innerWireMm).toBe(2.0);
    expect(mixed!.rollLengthM).toBe(100);
  });

  it("网高与竖丝间距的取值与产品定义一致（1.2/1.5、10/15）", () => {
    expect(NIULANWANG_SKU_AXES.height.options.map((o) => o.value)).toEqual([
      1.2, 1.5,
    ]);
    expect(
      NIULANWANG_SKU_AXES.vertical_wire_spacing.options.map((o) => o.value),
    ).toEqual([10, 15]);
  });

  it("网孔分布按品种固定，不是第二个 SKU 轴", () => {
    // "环扣" 属于鹿网，不在本 48 组合的规格空间内
    expect(NIULANWANG_DESCRIPTIVE.product_form).toBe("ningbian_shangshuxiami");
    expect(Object.keys(NIULANWANG_SKU_AXES)).not.toContain("product_form");
  });
});

describe("波弯款增重", () => {
  it("每 100 米 +3kg", () => {
    expect(WAVE_ADD_KG_PER_100M).toBe(3);
    expect(waveAddKg(100, 1)).toBe(3);
  });

  it("50 米卷只 +1.5kg（按卷长折算，不是固定 3kg）", () => {
    expect(waveAddKg(50, 1)).toBe(1.5);
  });

  it("无波款增重为 0", () => {
    expect(waveAddKg(100, 0)).toBe(0);
    expect(waveAddKg(50, 0)).toBe(0);
  });
});

describe("体积口径：圆柱体 vs 长方体", () => {
  it("单卷净体积按实际圆柱体 = π/4 × 卷径² × 网高", () => {
    // 卷径 30cm、网高 1.2m → π/4 × 0.09 × 1.2 = 0.0848230...
    const v = cylinderVolumePerRoll(0.3, 1.2);
    expect(v).toBeCloseTo(0.084823, 6);
  });

  it("单卷长方体体积按外接方柱 = 卷径² × 网高", () => {
    expect(boxVolumePerRoll(0.3, 1.2)).toBeCloseTo(0.108, 10);
  });

  it("圆柱体约为长方体的 78.54%（不能混用两个口径）", () => {
    const ratio = cylinderVolumePerRoll(0.3, 1.2) / boxVolumePerRoll(0.3, 1.2);
    expect(ratio).toBeCloseTo(Math.PI / 4, 10);
  });

  it("实际占用体积基于长方体口径扣减，而不是圆柱体", () => {
    const model = NIULANWANG_VOLUME_MODEL;
    expect(model.orderTotalFormula).toContain("长方体");
    expect(model.effectiveFormula).toContain("长方体总体积");
    // 300 卷 × 0.108 − 2.5 = 29.9（与手工核对一致）
    expect(
      boxVolumePerRoll(0.3, 1.2) * 300 - model.deduction.valueM3,
    ).toBeCloseTo(29.9, 10);
  });

  it("扣减 2~3 取中位数 2.5，且每单只扣一次", () => {
    expect(NIULANWANG_VOLUME_MODEL.deduction.mode).toBe("median");
    expect(NIULANWANG_VOLUME_MODEL.deduction.range).toEqual([2, 3]);
    expect(NIULANWANG_VOLUME_MODEL.deduction.valueM3).toBe(2.5);
    expect(NIULANWANG_VOLUME_MODEL.deduction.appliesPer).toBe("order");
  });

  it("50 万米口径核对：500 卷 × 0.108 − 2.5 = 51.5", () => {
    expect(boxVolumePerRoll(0.3, 1.2) * 500 - 2.5).toBeCloseTo(51.5, 10);
  });
});

describe("派生量代号与后端一致", () => {
  it("体积有两个口径的代号，不能只留一个", () => {
    expect(NIULANWANG_METRIC_CODES.cylinderVolumePerRoll).toBe(
      "volume_per_piece_m3",
    );
    expect(NIULANWANG_METRIC_CODES.boxVolumePerRoll).toBe(
      "volume_box_per_piece_m3",
    );
    expect(NIULANWANG_METRIC_CODES.effectiveVolumeTotal).toBe(
      "volume_effective_m3",
    );
  });

  it("代号不重复", () => {
    const codes = Object.values(NIULANWANG_METRIC_CODES);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("覆盖 13 个派生量", () => {
    expect(Object.keys(NIULANWANG_METRIC_CODES)).toHaveLength(13);
  });
});
