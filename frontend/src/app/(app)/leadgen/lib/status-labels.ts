/**
 * 状态 → 中文文案（唯一来源）。
 *
 * 拆自 page.tsx：**只负责文案**，tone 一律来自 `@/lib/status-tones`
 * （P1-D 单一来源），两者不要在本文件重新耦合。
 */

export const CRAWL_STATUS_CN: Record<string, string> = {
  pending: "待爬取",
  success: "成功",
  failed: "失败",
  blocked: "被拦截",
  no_website: "无官网",
};

export const OUTREACH_STATUS_CN: Record<string, string> = {
  none: "无",
  sent: "已发送",
  delivered: "已送达",
  opened: "已打开",
  replied: "已回复",
  bounced: "退信",
};

export const INQUIRY_STATUS_CN: Record<string, string> = {
  new: "新询盘",
  following: "跟进中",
  won: "已成交",
  lost: "已丢单",
};

export const RUN_STATUS_CN: Record<string, string> = {
  succeeded: "成功",
  failed: "失败",
  running: "运行中",
  pending: "待运行",
};
