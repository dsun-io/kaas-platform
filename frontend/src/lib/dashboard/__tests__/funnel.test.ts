import { describe, expect, it } from "vitest";

import {
  DASHBOARD_DEFAULT_RANGE,
  DASHBOARD_RANGES,
  channelLabel,
  formatAmount,
  formatPercent,
  isEmptyFunnel,
  normalizeDashboardRange,
  sortChannelsByScore,
  stageBarWidthPercent,
} from "../funnel";

describe("DASHBOARD_RANGES / normalizeDashboardRange", () => {
  it("四个时间范围与内核 since_map 一致（today/7d/30d/90d）", () => {
    expect(DASHBOARD_RANGES.map((range) => range.value)).toEqual([
      "today",
      "7d",
      "30d",
      "90d",
    ]);
    expect(DASHBOARD_RANGES.map((range) => range.label)).toEqual([
      "今日",
      "近 7 天",
      "近 30 天",
      "近 90 天",
    ]);
  });

  it("合法值原样返回；非法/空值回默认 today（不把脏值发给后端）", () => {
    expect(normalizeDashboardRange("90d")).toBe("90d");
    expect(normalizeDashboardRange("1y")).toBe(DASHBOARD_DEFAULT_RANGE);
    expect(normalizeDashboardRange("")).toBe("today");
  });
});

describe("formatPercent", () => {
  it("后端 null（分母为 0）显示「—」，不是 0%", () => {
    expect(formatPercent(null)).toBe("—");
    expect(formatPercent(undefined)).toBe("—");
  });

  it("整数去掉小数、两位小数保留；0% 与 100% 正常显示", () => {
    expect(formatPercent(0)).toBe("0%");
    expect(formatPercent(60)).toBe("60%");
    expect(formatPercent(41.67)).toBe("41.67%");
    expect(formatPercent(100)).toBe("100%");
  });

  it("NaN / Infinity 也按「—」处理（不渲染 NaN%）", () => {
    expect(formatPercent(Number.NaN)).toBe("—");
    expect(formatPercent(Number.POSITIVE_INFINITY)).toBe("—");
  });
});

describe("formatAmount", () => {
  it("千分位 + 固定两位小数", () => {
    expect(formatAmount(12345.6)).toBe("12,345.60");
    expect(formatAmount(0)).toBe("0.00");
    expect(formatAmount(1234567.891)).toBe("1,234,567.89");
  });

  it("null → 「—」；负数保留符号", () => {
    expect(formatAmount(null)).toBe("—");
    expect(formatAmount(-1234.5)).toBe("-1,234.50");
  });
});

describe("channelLabel", () => {
  it("后端枚举 → 中文标签（含 2026-10-22 新增 phone/referral）", () => {
    expect(channelLabel("email")).toBe("邮件");
    expect(channelLabel("whatsapp")).toBe("WhatsApp");
    expect(channelLabel("alibaba")).toBe("阿里巴巴");
    expect(channelLabel("expo")).toBe("展会");
    expect(channelLabel("website")).toBe("官网");
    expect(channelLabel("phone")).toBe("电话");
    // 复用 lib/inquiries/format.ts 的 canonical 映射（与询盘工位同叫法）
    expect(channelLabel("referral")).toBe("转介绍");
    expect(channelLabel("other")).toBe("其他");
  });

  it("未知渠道原样显示（不吞成「其他」）；空值兜底「其他」", () => {
    expect(channelLabel("tiktok")).toBe("tiktok");
    expect(channelLabel("  ")).toBe("其他");
  });
});

describe("stageBarWidthPercent", () => {
  it("首阶段 100%；其余按询盘数比例缩放并四舍五入", () => {
    expect(stageBarWidthPercent(200, 200)).toBe(100);
    expect(stageBarWidthPercent(50, 200)).toBe(25);
    expect(stageBarWidthPercent(1, 3)).toBe(33);
  });

  it("没有询盘 / 异常输入 → 0（不是 NaN）", () => {
    expect(stageBarWidthPercent(0, 0)).toBe(0);
    expect(stageBarWidthPercent(5, 0)).toBe(0);
    expect(stageBarWidthPercent(Number.NaN, 10)).toBe(0);
  });

  it("结果夹在 0–100", () => {
    expect(stageBarWidthPercent(300, 200)).toBe(100);
    expect(stageBarWidthPercent(-5, 200)).toBe(0);
  });
});

describe("sortChannelsByScore", () => {
  it("按综合分降序；同分按渠道码升序；不改原数组", () => {
    const input = [
      { channel: "email", composite_score: 10 },
      { channel: "expo", composite_score: 34 },
      { channel: "alibaba", composite_score: 34 },
      { channel: "other", composite_score: 3 },
    ];
    const sorted = sortChannelsByScore(input);

    expect(sorted.map((row) => row.channel)).toEqual([
      "alibaba",
      "expo",
      "email",
      "other",
    ]);
    expect(input.map((row) => row.channel)).toEqual([
      "email",
      "expo",
      "alibaba",
      "other",
    ]);
  });
});

describe("isEmptyFunnel", () => {
  it("null / 无阶段 / 四阶段全 0 → true；任一非 0 → false", () => {
    expect(isEmptyFunnel(null)).toBe(true);
    expect(isEmptyFunnel({ stages: [] })).toBe(true);
    expect(
      isEmptyFunnel({
        stages: [{ count: 0 }, { count: 0 }, { count: 0 }, { count: 0 }],
      }),
    ).toBe(true);
    expect(
      isEmptyFunnel({
        stages: [{ count: 0 }, { count: 0 }, { count: 1 }, { count: 0 }],
      }),
    ).toBe(false);
  });
});
