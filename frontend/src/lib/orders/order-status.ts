/**
 * 订单状态机（C36 下期 #21）——与后端**同一张表**，前端只用于"动态显示合法目标"。
 *
 * 真源：`backend/worker/src/main.py:3301` `ORDER_NEXT`（与
 * `kaas_common.domain.enums.ORDER_STATUS` 的六态一致）：
 *   pending → confirmed / cancelled
 *   confirmed → producing / cancelled
 *   producing → shipped
 *   shipped → completed
 *   completed / cancelled → （无，终态）
 *
 * 为什么前端也要这张表：不该让用户点一个必然 409 的按钮。真正裁决仍在后端
 * （非法流转 409 `ILLEGAL_TRANSITION`，未知状态 422），前端只是把选择范围收窄。
 */
import { normalizeApiError } from "@/lib/api/api-error";

export const ORDER_NEXT: Record<string, readonly string[]> = {
  pending: ["confirmed", "cancelled"],
  confirmed: ["producing", "cancelled"],
  producing: ["shipped"],
  shipped: ["completed"],
};

export const ORDER_STATUS_LABEL: Record<string, string> = {
  pending: "待确认",
  confirmed: "已确认",
  producing: "生产中",
  shipped: "已出运",
  completed: "已完成",
  cancelled: "已取消",
};

/** 该状态可流转到的目标（终态返回空数组） */
export function nextOrderStatuses(status: string): readonly string[] {
  return ORDER_NEXT[status] ?? [];
}

/**
 * 流转会触发的**后端副作用**（给用户看的二次确认说明，避免"以为只是改个字段"）。
 * 真源：`change_order_status` 里对 confirmed/shipped/completed 的分支。
 */
export function orderTransitionNote(from: string, to: string): string {
  if (to === "confirmed" && from === "pending") {
    return "确认后后端会锁定当日汇率并生成应收台账（未收款记录）。";
  }
  if (to === "shipped") {
    return "发货后后端会发出 order.shipped 跨工位事件（单证工位据此提示开单）。";
  }
  if (to === "completed") {
    return "完成后关联询盘阶段会推进为 completed（沿报价传递）。";
  }
  if (to === "cancelled") {
    return "取消是不可撤销的终态：状态机没有回退路径，请确认后再操作。";
  }
  return "状态流转由后端状态机校验，非法流转会被拒绝。";
}

interface BackendConflict {
  code?: unknown;
  from?: unknown;
  to?: unknown;
  allowed?: unknown;
}

function conflictOf(error: unknown): BackendConflict | null {
  const detail = (
    error as { response?: { data?: { detail?: unknown } } } | null
  )?.response?.data?.detail;
  return typeof detail === "object" && detail !== null
    ? (detail as BackendConflict)
    : null;
}

/**
 * 流转失败的原因（给人看）：
 * - 409 `ILLEGAL_TRANSITION`：带 "从 X 不能直接到 Y（允许：…）"；
 * - 422 `STATUS_REQUIRED` / `INVALID_ENUM`：后端 detail 里的说明；
 * - 其它：`normalizeApiError` 的通用文案。
 */
export function orderStatusErrorText(error: unknown): string {
  const normalized = normalizeApiError(error);
  const conflict = conflictOf(error);
  if (normalized.code === "ILLEGAL_TRANSITION" && conflict) {
    const from = String(conflict.from ?? "");
    const to = String(conflict.to ?? "");
    const allowed = Array.isArray(conflict.allowed)
      ? conflict.allowed.map((value) => String(value))
      : [];
    const allowedText = allowed.length
      ? `（允许：${allowed.map((s) => ORDER_STATUS_LABEL[s] ?? s).join(" / ")}）`
      : "";
    return `不能从「${ORDER_STATUS_LABEL[from] ?? from}」直接改为「${
      ORDER_STATUS_LABEL[to] ?? to
    }」${allowedText}`;
  }
  return normalized.message;
}
