/**
 * 状态 → 中文文案（唯一来源）。tone 一律来自 `@/lib/status-tones`，
 * 两者不要在本文件重新耦合。
 */

export const CRAWL_STATUS_CN: Record<string, string> = {
  pending: "待爬取",
  success: "成功",
  failed: "失败",
  blocked: "被拦截",
  no_website: "无官网",
};

export const RUN_STATUS_CN: Record<string, string> = {
  succeeded: "成功",
  failed: "失败",
  running: "运行中",
  pending: "待运行",
};
