import { describe, it, expect } from "vitest";
import {
  NIULANWANG_VOLUME_MODEL,
  NIULANWANG_METRIC_CODES,
  NIULANWANG_DESCRIPTIVE,
  WAVE_ADD_KG_PER_100M,
  waveAddKg,
  cylinderVolumePerRoll,
  boxVolumePerRoll,
} from "@contracts/niulanwang";

/**
 * 规格空间**不再由前端镜像**（2026-10-11 退役枚举轴）。
 *
 * 尺寸类（丝径 / 网高 / 竖丝间距 / 卷长 / 卷径 / 横丝根数）已改为**自由数值参数**：
 * 客户填任意值，由公式折算重量与价格。连续量没有"可选值清单"，也没有"组合数"。
 *
 * 原先这里有一份手抄镜像（5 轴 / 48 组合 / `NIULANWANG_COMBO_COUNT = 160`），
 * 后端改了规格它不会跟着变 —— 实测就出现了「120 / 160 / 48 三个数各说各话」。
 * 界面现在一律从 `GET /export-quote/products/field_fence/formulas` 读。
 */
describe("规格空间不再由前端镜像", () => {
  it("不再导出枚举规格轴与组合数", async () => {
    const mod = await import("@contracts/niulanwang");
    for (const gone of [
      "NIULANWANG_SKU_AXES",
      "NIULANWANG_COMBO_COUNT",
      "niulanwangComboCount",
      "wireOptionOf",
      "NiulanwangAxisSchema",
    ]) {
      expect(gone in mod, `${gone} 不该再存在（尺寸类已是自由数值）`).toBe(false);
    }
  });

  it("保留的是与规格空间无关的口径常量（不随取值增减失效）", () => {
    expect(WAVE_ADD_KG_PER_100M).toBe(3);
    expect(NIULANWANG_DESCRIPTIVE.horizontal_wire_count).toBe(10);
    expect(NIULANWANG_VOLUME_MODEL.orderTotalFormula).toBeTruthy();
    expect(Object.keys(NIULANWANG_METRIC_CODES).length).toBeGreaterThan(0);
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

  it("实际占用体积基于长方体口径，不是圆柱体", () => {
    const model = NIULANWANG_VOLUME_MODEL;
    expect(model.orderTotalFormula).toContain("长方体");
    expect(model.effectiveFormula).toContain("长方体总体积");
  });

  it("扣减**按比例**（不是固定 m³）—— 固定额在小单上会算出负体积", () => {
    const d = NIULANWANG_VOLUME_MODEL.deduction;
    expect(d.mode).toBe("ratio");
    expect(d.ratio).toBeCloseTo(0.04, 6);
    // 工厂经验原话仍记录在案（满柜 2~3 m³ ÷ 整柜 68 m³ ≈ 4%）
    expect(d.fullContainerM3).toEqual([2, 3]);
    expect(d.containerCapacityM3).toBe(68);
    // 满柜（约 630 卷 × 0.108 ≈ 68 m³）扣减应落回 2~3 m³
    const full = boxVolumePerRoll(0.3, 1.2) * 630;
    const deduced = full * d.ratio;
    expect(deduced).toBeGreaterThan(2);
    expect(deduced).toBeLessThan(3);
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
