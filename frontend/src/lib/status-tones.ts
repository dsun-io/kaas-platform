import type { StatusTone } from "@/components/shared/status-badge";

export type { StatusTone };

/**
 * 状态 → tone 的唯一来源（P0-C）。
 *
 * 背景：`leadgen / outreach / research` 三页各自抄了一份 `Record<string, StatusTone>`，
 * 同一状态（如 `opened`）在三处写法必须人工保持一致，漂移后用户看到的状态色不一致。
 * 本文件先收录这三份映射的**并集**；后续批次逐页改成从这里取（P1-D「状态 tone 三份重复合并」）。
 *
 * 约定：
 * - 值域固定为 `StatusTone`（default/success/warning/danger/info/purple）；
 * - 未知状态一律 `"default"`（用 `toneForStatus`），**不要**在页面里散写 `?? "default"`；
 * - tone 只表达"类别"，文案仍由各页的 CN 映射负责（本文件不碰枚举值/中文文案）。
 */

/** 外联/邮件状态（leadgen 线索状态 + outreach 邮件状态并集）。 */
export const OUTREACH_STATUS_TONES: Readonly<Record<string, StatusTone>> = {
  none: "default",
  draft: "default",
  pending: "default",
  sending: "info",
  sent: "info",
  delivered: "info",
  opened: "purple",
  replied: "success",
  bounced: "danger",
  failed: "danger",
};

/** 询盘状态（leadgen 客户询盘）。 */
export const INQUIRY_STATUS_TONES: Readonly<Record<string, StatusTone>> = {
  none: "default",
  new: "info",
  following: "purple",
  won: "success",
  lost: "danger",
};

/** 官网抓取状态（leadgen / research 共用）。 */
export const CRAWL_STATUS_TONES: Readonly<Record<string, StatusTone>> = {
  pending: "default",
  success: "success",
  failed: "danger",
  blocked: "danger",
  no_website: "default",
};

/** 批处理/任务运行状态（leadgen / research 运行历史）。 */
export const RUN_STATUS_TONES: Readonly<Record<string, StatusTone>> = {
  pending: "default",
  running: "info",
  succeeded: "success",
  failed: "danger",
};

/**
 * 营销活动状态（outreach 活动列表）。
 *
 * 注意与单封邮件的 `sent` 语义不同：活动 `sent` = 整批已发完（success），
 * 而单封邮件 `sent` 只是"已投递到网关"（info，后续还有 delivered/opened）。
 *
 * 已登记进 `STATUS_TONE_MAPS.campaign`（task-27）；对应契约测试同步锁 5 个域。
 */
export const CAMPAIGN_STATUS_TONES: Readonly<Record<string, StatusTone>> = {
  draft: "default",
  sending: "info",
  sent: "success",
  failed: "danger",
};

/** 按业务域取映射表（便于"某页所有状态"统一遍历/测试）。 */
export const STATUS_TONE_MAPS = {
  outreach: OUTREACH_STATUS_TONES,
  inquiry: INQUIRY_STATUS_TONES,
  crawl: CRAWL_STATUS_TONES,
  run: RUN_STATUS_TONES,
  campaign: CAMPAIGN_STATUS_TONES,
} as const;

/** 从映射表取 tone；未知/空状态回落 default（唯一兜底点）。 */
export function toneForStatus(
  map: Readonly<Record<string, StatusTone>>,
  status: string | null | undefined,
): StatusTone {
  if (!status) return "default";
  return map[status] ?? "default";
}

/** 契合度评分 → tone（leadgen `scoreTone` 的唯一实现）。 */
export function scoreTone(score: number | null | undefined): StatusTone {
  if (score === null || score === undefined || Number.isNaN(score)) {
    return "default";
  }
  if (score >= 75) return "success";
  if (score >= 50) return "info";
  return "default";
}
