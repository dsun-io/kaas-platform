/**
 * 单证列表「对账标识」的展示口径（TODO A8/A9）。
 *
 * 三条容易错成"假结论"的规则，必须锁死：
 * 1. 从未对账 ⇒ 不显示（null）；
 * 2. 一致 ⇒ 不显示（常态不打扰）；
 * 3. 无基线（no_fingerprint，草稿/老单据）⇒ 不显示。
 * 反之"数据被改"必须红、"模板漂移"黄、"装配失败"给待复核 —— 都不能悄悄吞掉。
 */
import { describe, expect, it } from "vitest";

import { renderCheckBadge, type RenderCheckSummary } from "../render-check";

function check(over: Partial<RenderCheckSummary>): RenderCheckSummary {
  return {
    matches: false,
    reason: "data_changed",
    render_version_drift: false,
    checked_at: "2026-10-21T01:40:00+08:00",
    ...over,
  };
}

describe("renderCheckBadge", () => {
  it("从未对账（null / undefined）不显示任何标识", () => {
    expect(renderCheckBadge(null)).toBeNull();
    expect(renderCheckBadge(undefined)).toBeNull();
  });

  it("对账一致不显示（常态不打扰）", () => {
    expect(
      renderCheckBadge(check({ matches: true, reason: "matched" })),
    ).toBeNull();
  });

  it("无基线（草稿/老单据）不显示", () => {
    expect(renderCheckBadge(check({ reason: "no_fingerprint" }))).toBeNull();
  });

  it("签发后数据被改 ⇒ 红色「已变更」", () => {
    const badge = renderCheckBadge(check({ reason: "data_changed" }));
    expect(badge).not.toBeNull();
    expect(badge!.label).toBe("已变更");
    expect(badge!.tone).toBe("danger");
    expect(badge!.title).toContain("签发后单证数据被修改");
    expect(badge!.title).toContain("2026-10-21T01:40:00+08:00");
  });

  it("模板/渲染器版本漂移 ⇒ 黄色「模板已更新」（与数据被改分开）", () => {
    const badge = renderCheckBadge(
      check({ reason: "version_drift", render_version_drift: true }),
    );
    expect(badge).not.toBeNull();
    expect(badge!.label).toBe("模板已更新");
    expect(badge!.tone).toBe("warning");
  });

  it("装配失败 ⇒ 「待复核」而且不假报一致", () => {
    for (const reason of ["current_unavailable", "frozen_unavailable"]) {
      const badge = renderCheckBadge(check({ reason }));
      expect(badge).not.toBeNull();
      expect(badge!.label).toBe("待复核");
      expect(badge!.tone).toBe("warning");
    }
  });

  it("未知 reason 兜底为「待复核」，不吞掉异常结论", () => {
    const badge = renderCheckBadge(check({ reason: "weird_future_reason" }));
    expect(badge).not.toBeNull();
    expect(badge!.label).toBe("待复核");
    expect(badge!.title).toContain("weird_future_reason");
  });
});
