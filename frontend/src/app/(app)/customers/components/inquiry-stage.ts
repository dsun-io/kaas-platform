/**
 * 询盘「当前阶段」展示口径（纯函数，无 React/网络依赖，便于单测）。
 *
 * 背景（前后端对齐审计 2026-10-20 · P1-2）：
 *   · 后端已落库 F4 询盘阶段真值（`backend/worker/src/inquiry_stage.py:22-27`，
 *     经 `customer_serializers.py:75-76` 序列化为 `stage` / `stage_updated_at`），
 *     由事件驱动（报价创建 → 订单 → 出运 → 完结 / 手动关闭）；
 *   · 前端此前只用 `deriveInquiryStage()` 从「报价单/订单/单证」反推，
 *     当"事件推进了 stage、而推导证据缺失"时进度会落后/不一致。
 *
 * 本模块的口径：**后端 stage 优先，推导仅作兜底**（历史行没有 stage 值、
 * 或 stage 是已关闭后又重开留下的陈旧值）。阶段字符串与后端常量同名：
 * inquiry < quotation < order < shipment < completed；closed 是终态。
 */
import type { StatusTone } from "@/components/shared";

/** 询盘条目上的「当前阶段」——纯展示，不写回后端。 */
export interface InquiryStage {
  label: "询盘" | "报价" | "订单" | "发货" | "完结" | "关闭";
  tone: StatusTone;
  /** 最新一步的补充信息（单号 + 状态）——只有推导侧知道，后端 stage 不含 */
  hint: string | null;
}

/** 后端 F4 阶段真值 → 前端展示（tone 与推导侧保持同一套配色）。 */
const BACKEND_STAGE_META: Record<
  string,
  { label: InquiryStage["label"]; tone: StatusTone }
> = {
  inquiry: { label: "询盘", tone: "default" },
  quotation: { label: "报价", tone: "info" },
  order: { label: "订单", tone: "info" },
  shipment: { label: "发货", tone: "success" },
  completed: { label: "完结", tone: "success" },
  closed: { label: "关闭", tone: "default" },
};

/** 后端 stage 值 → 展示元信息；未知/null（老数据）返回 null，交给推导兜底。 */
export function stageFromBackend(
  stage: string | null | undefined,
): { label: InquiryStage["label"]; tone: StatusTone } | null {
  if (!stage) return null;
  return BACKEND_STAGE_META[stage] ?? null;
}

/**
 * 解析询盘条目应展示的阶段：后端真值优先，推导兜底。
 *
 * @param backendStage  后端 `cust_inquiries.stage`（可能为 null：迁移前的历史行）
 * @param inquiryStatus 后端 `cust_inquiries.status`（报价三态：unquoted/quoted/closed）
 * @param derived       `deriveInquiryStage()` 的推导结果（兜底 + hint 来源）
 */
export function resolveInquiryStage(
  backendStage: string | null | undefined,
  inquiryStatus: string,
  derived: InquiryStage,
): InquiryStage {
  // 手动关闭是用户动作：status=closed 一律展示「关闭」，即使 stage 还没回填。
  if (inquiryStatus === "closed") return derived;

  const meta = stageFromBackend(backendStage);
  if (!meta) return derived;

  // 重开询盘时后端**不回收** stage（inquiry_stage.py:105「重开不回收 stage，只回状态」）
  // ⇒ stage=closed 而 status≠closed 的行是「关闭后又重开」：以 status 为准回退推导，
  // 否则界面会永远停在「关闭」。
  if (meta.label === "关闭") return derived;

  return {
    label: meta.label,
    tone: meta.tone,
    // hint（最新单号/状态）只有推导侧能给出：只在两边结论一致时沿用，
    // 结论冲突时留空 —— 不能把报价单号挂在「订单」阶段下面。
    hint: derived.label === meta.label ? derived.hint : null,
  };
}
