/**
 * 询盘阶段 / 状态的展示口径与状态机（纯函数，无 React / 网络依赖）。
 *
 * 为什么单独成文件：`stage`（流程进度）与 `status`（报价三态）是**两层语义**，
 * 列表徽标、详情时间线、关闭/重开按钮都要用同一份判定 —— 散落在组件里必然漂移。
 *
 * 真源：
 *   · 阶段顺序 = `backend/worker/src/inquiry_stage.py:23-34`（ALL_STAGES）；
 *   · 状态机   = `backend/worker/src/ws_crm_ext.py:87-91`（_INQUIRY_NEXT）；
 *   · 重开规则 = `ws_crm_ext.py:542-562`：请求 unquoted 但已有报价 ⇒ 实际回到 quoted；
 *     手动关闭会写一条 stage=closed 的流水，**重开不回收 stage**（前端因此不能拿
 *     陈旧 stage=closed 当"当前阶段"，要按 status 退化）。
 */
import type { StatusTone } from "@/components/shared";

import {
  INQUIRY_STAGES,
  type InquiryStage,
  type InquiryStageLog,
  type InquiryStatus,
} from "./types";

/** 阶段推进顺序（closed 是终态，不参与 rank）。 */
export const STAGE_SEQUENCE: readonly InquiryStage[] = [
  "inquiry",
  "quotation",
  "order",
  "shipment",
  "completed",
];

export const STAGE_LABEL: Record<InquiryStage, string> = {
  inquiry: "询盘",
  quotation: "报价",
  order: "订单",
  shipment: "发货",
  completed: "完结",
  closed: "关闭",
};

export const STAGE_TONE: Record<InquiryStage, StatusTone> = {
  inquiry: "default",
  quotation: "info",
  order: "info",
  shipment: "success",
  completed: "success",
  closed: "default",
};

export const STAGE_DESCRIPTION: Record<InquiryStage, string> = {
  inquiry: "刚收到询盘，还没有报价",
  quotation: "已出过报价，等待客户反馈",
  order: "已转成订单",
  shipment: "货物已出运",
  completed: "整条链路完结",
  closed: "已手动关闭（终态）",
};

export function isInquiryStage(value: unknown): value is InquiryStage {
  return (
    typeof value === "string" &&
    (INQUIRY_STAGES as readonly string[]).includes(value)
  );
}

export interface ResolvedInquiryStage {
  stage: InquiryStage;
  label: string;
  tone: StatusTone;
  /** backend = 后端 stage 真值；derived = 按 status 退化/推导（历史行、重开后的陈旧值） */
  source: "backend" | "derived";
}

/**
 * 解析列表/详情应展示的**当前阶段**。
 *
 * 规则（与 customers 页 `resolveInquiryStage` 同口径，这里收敛到 lib 便于复用）：
 *   1. status=closed ⇒ 一定展示「关闭」（手动关闭是用户动作，stage 可能还没回填）；
 *   2. 后端 stage 合法且不是 closed ⇒ 用后端真值；
 *   3. 其余（stage 缺失/非法/关闭后重开的陈旧 closed）⇒ 按 status 退化：
 *        quoted → quotation，unquoted → inquiry。
 */
export function resolveInquiryStage(
  backendStage: string | null | undefined,
  status: string,
): ResolvedInquiryStage {
  if (
    status !== "closed" &&
    isInquiryStage(backendStage) &&
    backendStage !== "closed"
  ) {
    return {
      stage: backendStage,
      label: STAGE_LABEL[backendStage],
      tone: STAGE_TONE[backendStage],
      source: "backend",
    };
  }
  const stage: InquiryStage =
    status === "closed"
      ? "closed"
      : status === "quoted"
        ? "quotation"
        : "inquiry";
  return {
    stage,
    label: STAGE_LABEL[stage],
    tone: STAGE_TONE[stage],
    source: "derived",
  };
}

// ── 报价三态（status）──────────────────────────────────────────────────────

export const INQUIRY_STATUS_LABEL: Record<string, string> = {
  unquoted: "待报价",
  quoted: "已报价",
  closed: "已关闭",
};

export function inquiryStatusLabel(status: string): string {
  return INQUIRY_STATUS_LABEL[status] ?? status;
}

export function inquiryStatusTone(status: string): StatusTone {
  if (status === "quoted") return "info";
  if (status === "unquoted") return "warning";
  return "default";
}

/** 与内核逐字同构的转移表（ws_crm_ext.py:87-91）。 */
export const INQUIRY_NEXT: Record<string, readonly InquiryStatus[]> = {
  unquoted: ["closed"],
  quoted: ["closed"],
  closed: ["unquoted", "quoted"],
};

/** 是否允许「关闭询盘」（只有非终态可关）。 */
export function canCloseInquiry(status: string): boolean {
  return (INQUIRY_NEXT[status] ?? []).includes("closed");
}

/** 重新打开时的目标状态：已有报价 ⇒ quoted，否则 unquoted（与内核口径一致）。 */
export function reopenStatus(
  status: string,
  hasQuote: boolean,
): InquiryStatus | null {
  if (!(INQUIRY_NEXT[status] ?? []).includes("unquoted")) return null;
  return hasQuote ? "quoted" : "unquoted";
}

// ── 阶段流水（时间线）──────────────────────────────────────────────────────

/** 事件来源 → 中文（真源 = inquiry_stage.py:36-40 SOURCE_*）。 */
export const STAGE_SOURCE_LABEL: Record<string, string> = {
  quote_created: "创建报价单",
  order_created: "创建订单",
  order_completed: "订单完成",
  shipment_created: "创建出运",
  inquiry_closed: "手动关闭询盘",
};

export interface StageTimelineEntry {
  id: number;
  fromLabel: string | null;
  toLabel: string;
  sourceLabel: string;
  actorId: string | null;
  note: string | null;
  createdAt: string | null;
}

/** 阶段流水 → 时间线条目（只做展示映射，不改顺序：后端按 created_at,id 正序）。 */
export function stageTimeline(
  logs: readonly InquiryStageLog[],
): StageTimelineEntry[] {
  return logs.map((log) => ({
    id: log.id,
    fromLabel: isInquiryStage(log.from_stage)
      ? STAGE_LABEL[log.from_stage]
      : null,
    toLabel: isInquiryStage(log.to_stage)
      ? STAGE_LABEL[log.to_stage]
      : log.to_stage,
    sourceLabel:
      STAGE_SOURCE_LABEL[log.source_event] ?? log.source_event ?? "未知事件",
    actorId: log.actor_id,
    note: log.note,
    createdAt: log.created_at,
  }));
}
