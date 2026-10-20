/**
 * 询盘阶段展示口径（F4「后端真值优先 + 推导兜底」）。
 *
 * 背景（前后端对齐审计 2026-10-20 · P1-2）：后端 `cust_inquiries.stage` 是事件驱动的
 * 流程阶段真值，前端此前只用 `deriveInquiryStage()` 从报价/订单/单证反推 ⇒ 两套口径并存。
 * 本测试钉死 `resolveInquiryStage()` 的优先级与兜底：
 *   1. 有后端 stage → 展示后端 stage（label/tone）；
 *   2. 无 stage（迁移前历史行）/ 未知值 → 原样返回推导结果；
 *   3. status=closed（用户手动关闭）或 stage=closed 但 status 已重开 → 以推导为准，
 *      避免「关闭后又重开」的询盘永远显示「关闭」（后端重开不回收 stage）。
 */
import { describe, expect, it } from "vitest";

import {
  resolveInquiryStage,
  stageFromBackend,
  type InquiryStage,
} from "../inquiry-stage";

const DERIVED_INQUIRY: InquiryStage = {
  label: "询盘",
  tone: "default",
  hint: null,
};
const DERIVED_QUOTATION: InquiryStage = {
  label: "报价",
  tone: "info",
  hint: "报价单 Q-2026-001",
};
const DERIVED_SHIPMENT: InquiryStage = {
  label: "发货",
  tone: "success",
  hint: "装箱单 PL-2026-009 · issued",
};
const DERIVED_CLOSED: InquiryStage = {
  label: "关闭",
  tone: "default",
  hint: null,
};

describe("stageFromBackend", () => {
  it("后端 5 个推进阶段 + 关闭都有展示映射", () => {
    expect(stageFromBackend("inquiry")).toEqual({
      label: "询盘",
      tone: "default",
    });
    expect(stageFromBackend("quotation")).toEqual({
      label: "报价",
      tone: "info",
    });
    expect(stageFromBackend("order")).toEqual({ label: "订单", tone: "info" });
    expect(stageFromBackend("shipment")).toEqual({
      label: "发货",
      tone: "success",
    });
    expect(stageFromBackend("completed")).toEqual({
      label: "完结",
      tone: "success",
    });
    expect(stageFromBackend("closed")).toEqual({ label: "关闭", tone: "default" });
  });

  it("null / 未知值 → null（交给推导兜底）", () => {
    expect(stageFromBackend(null)).toBeNull();
    expect(stageFromBackend(undefined)).toBeNull();
    expect(stageFromBackend("")).toBeNull();
    expect(stageFromBackend("legacy_stage")).toBeNull();
  });
});

describe("resolveInquiryStage：后端真值优先", () => {
  it("有 stage（order）时优先于推导（推导说报价）", () => {
    const stage = resolveInquiryStage("order", "quoted", DERIVED_QUOTATION);
    expect(stage.label).toBe("订单");
    expect(stage.tone).toBe("info");
    // 结论冲突时不沿用推导的 hint（报价单号不能挂在订单阶段下）
    expect(stage.hint).toBeNull();
  });

  it("推导结论一致时沿用推导的 hint（单号/状态这类后端 stage 不含的信息）", () => {
    const stage = resolveInquiryStage("shipment", "quoted", DERIVED_SHIPMENT);
    expect(stage.label).toBe("发货");
    expect(stage.tone).toBe("success");
    expect(stage.hint).toBe("装箱单 PL-2026-009 · issued");
  });

  it("stage=completed → 完结（即使推导因证据缺失只到报价）", () => {
    const stage = resolveInquiryStage("completed", "quoted", DERIVED_QUOTATION);
    expect(stage.label).toBe("完结");
    expect(stage.tone).toBe("success");
    expect(stage.hint).toBeNull();
  });
});

describe("resolveInquiryStage：推导兜底", () => {
  it("stage 为 null（迁移前历史行）→ 原样返回推导结果", () => {
    expect(resolveInquiryStage(null, "quoted", DERIVED_QUOTATION)).toBe(
      DERIVED_QUOTATION,
    );
    expect(resolveInquiryStage(undefined, "unquoted", DERIVED_INQUIRY)).toBe(
      DERIVED_INQUIRY,
    );
  });

  it("stage 是未知字符串（脏数据）→ 原样返回推导结果", () => {
    expect(resolveInquiryStage("stage_v2", "unquoted", DERIVED_INQUIRY)).toBe(
      DERIVED_INQUIRY,
    );
  });

  it("status=closed → 展示推导的「关闭」，即使 stage 还没回填 closed", () => {
    expect(resolveInquiryStage("quotation", "closed", DERIVED_CLOSED)).toBe(
      DERIVED_CLOSED,
    );
  });

  it("stage=closed 但 status 已重开（quoted）→ 回退推导，不显示「关闭」", () => {
    const stage = resolveInquiryStage("closed", "quoted", DERIVED_QUOTATION);
    expect(stage).toBe(DERIVED_QUOTATION);
    expect(stage.label).toBe("报价");
  });
});
