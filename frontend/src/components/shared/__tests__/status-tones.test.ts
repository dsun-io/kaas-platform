/**
 * status-tones（P0-C）——三份重复映射的并集，未知状态统一兜底 default。
 */
import { describe, expect, it } from "vitest";

import {
  CAMPAIGN_STATUS_TONES,
  CRAWL_STATUS_TONES,
  INQUIRY_STATUS_TONES,
  OUTREACH_STATUS_TONES,
  RUN_STATUS_TONES,
  STATUS_TONE_MAPS,
  scoreTone,
  toneForStatus,
} from "@/lib/status-tones";

describe("status-tones", () => {
  it("外联/邮件状态并集完整（leadgen OUTREACH_TONES + outreach MSG_TONES）", () => {
    expect(OUTREACH_STATUS_TONES).toMatchObject({
      none: "default",
      pending: "default",
      sending: "info",
      sent: "info",
      delivered: "info",
      opened: "purple",
      replied: "success",
      bounced: "danger",
      failed: "danger",
    });
  });

  it("营销活动状态（campaign）：活动 sent=成功，与单封邮件 sent=info 区分", () => {
    expect(CAMPAIGN_STATUS_TONES).toMatchObject({
      draft: "default",
      sending: "info",
      sent: "success",
      failed: "danger",
    });
    expect(toneForStatus(CAMPAIGN_STATUS_TONES, "sent")).toBe("success");
    expect(toneForStatus(OUTREACH_STATUS_TONES, "sent")).toBe("info");
  });

  it("询盘/抓取/运行状态与三页现有口径一致", () => {
    expect(INQUIRY_STATUS_TONES).toMatchObject({
      new: "info",
      following: "purple",
      won: "success",
      lost: "danger",
    });
    expect(CRAWL_STATUS_TONES).toMatchObject({
      pending: "default",
      success: "success",
      failed: "danger",
      blocked: "danger",
      no_website: "default",
    });
    expect(RUN_STATUS_TONES).toMatchObject({
      pending: "default",
      running: "info",
      succeeded: "success",
      failed: "danger",
    });
  });

  it("toneForStatus 是唯一兜底点：未知/空值一律 default", () => {
    expect(toneForStatus(OUTREACH_STATUS_TONES, "opened")).toBe("purple");
    expect(toneForStatus(OUTREACH_STATUS_TONES, "unknown_status")).toBe(
      "default",
    );
    expect(toneForStatus(OUTREACH_STATUS_TONES, null)).toBe("default");
    expect(toneForStatus(OUTREACH_STATUS_TONES, undefined)).toBe("default");
  });

  it("scoreTone 阈值：>=75 success，>=50 info，其余 default", () => {
    expect(scoreTone(75)).toBe("success");
    expect(scoreTone(100)).toBe("success");
    expect(scoreTone(50)).toBe("info");
    expect(scoreTone(74)).toBe("info");
    expect(scoreTone(49)).toBe("default");
    expect(scoreTone(null)).toBe("default");
    expect(scoreTone(Number.NaN)).toBe("default");
  });

  it("STATUS_TONE_MAPS 登记全部业务域（5 域固定：新增/删除都要改这条）", () => {
    expect(Object.keys(STATUS_TONE_MAPS).sort()).toEqual([
      "campaign",
      "crawl",
      "inquiry",
      "outreach",
      "run",
    ]);
    // 注册表里的每张表都必须是本文件导出的同一引用（防手抄第二份）
    expect(STATUS_TONE_MAPS.campaign).toBe(CAMPAIGN_STATUS_TONES);
  });
});
