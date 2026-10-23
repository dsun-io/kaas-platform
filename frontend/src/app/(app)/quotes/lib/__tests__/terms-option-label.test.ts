/**
 * 贸易术语的**选项显示格式**：`代码 · 中文（English）`。
 *
 * 两个下拉（运费面板的「对外报价术语」、工作台参数卡的「对外报价条款」）
 * 和档位小卡的标题共用 `termOptionLabel` —— 这条测试锁的就是它，
 * 因为格式一旦漂移，同一档位会在两处出现两种写法。
 *
 * 口径（用户 2026-10-18 确认）：选项只保留**一层括号**（英文）。
 * 模板 label 自带的尾部括号说明（「到门价（目的地交货）」里的「目的地交货」）
 * 在选项里裁掉，避免 `到门价（目的地交货）（Delivered at Place）` 这种双层括号。
 */
import { describe, expect, it } from "vitest";

import { termOptionLabel } from "../terms-option-label";

describe("术语选项显示格式：代码 · 中文（English）", () => {
  it("DAP / DDP 按 `代码 · 中文（English）` 拼接，裁掉中文尾部的括号说明", () => {
    expect(
      termOptionLabel({
        code: "DAP",
        label: "到门价（目的地交货）",
        label_en: "Delivered at Place",
      }),
    ).toBe("DAP · 到门价（Delivered at Place）");
    expect(
      termOptionLabel({
        code: "DDP",
        label: "完税到门价（含进口税费）",
        label_en: "Delivered Duty Paid",
      }),
    ).toBe("DDP · 完税到门价（Delivered Duty Paid）");
  });

  it("原有档位同样只有一层括号，英文是全称", () => {
    expect(
      termOptionLabel({ code: "EXW", label: "出厂价", label_en: "Ex Works" }),
    ).toBe("EXW · 出厂价（Ex Works）");
    expect(
      termOptionLabel({
        code: "CIF",
        label: "到岸价（含运费与保险）",
        label_en: "Cost, Insurance and Freight",
      }),
    ).toBe("CIF · 到岸价（Cost, Insurance and Freight）");
  });

  it("label_en 缺失或就是代码时不出现空括号 / 冗余括号", () => {
    expect(termOptionLabel({ code: "FOB", label: "离岸价" })).toBe(
      "FOB · 离岸价",
    );
    expect(
      termOptionLabel({ code: "FOB", label: "离岸价", label_en: "FOB" }),
    ).toBe("FOB · 离岸价");
  });

  it("label 为空时退回代码，不会渲染出 ` · （…）`", () => {
    expect(
      termOptionLabel({ code: "XXW", label: "", label_en: "Some Term" }),
    ).toBe("XXW · XXW（Some Term）");
  });
});
