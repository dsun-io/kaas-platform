"use client";

/**
 * 订单状态流转弹窗（C36 下期 #21）。
 *
 * - 目标状态**只列后端状态机允许的目标**（`ORDER_NEXT` 镜像，见 `lib/orders/order-status.ts`），
 *   终态（completed/cancelled）没有按钮可点；
 * - 二次确认里写明后端副作用（确认锁汇率建应收 / 发货发跨工位事件 / 完成推进询盘阶段）；
 * - 失败原因（409 ILLEGAL_TRANSITION 带允许列表、422 非法枚举）原样展示，弹窗不关闭。
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import apiClient from "@/lib/api/client";
import {
  ORDER_STATUS_LABEL,
  nextOrderStatuses,
  orderStatusErrorText,
  orderTransitionNote,
} from "@/lib/orders/order-status";

const STATUS_TONE_TEXT: Record<string, string> = {
  confirmed: "text-blue-700",
  producing: "text-blue-700",
  shipped: "text-success",
  completed: "text-success",
  cancelled: "text-destructive",
};

export function OrderStatusDialog({
  open,
  onOpenChange,
  order,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  order: { id: number; order_no: string; status: string } | null;
  /** 流转成功后刷新订单列表/详情 */
  onChanged?: () => void;
}) {
  const qc = useQueryClient();
  const allowed = order ? nextOrderStatuses(order.status) : [];
  // 调用方在打开时**条件挂载**本弹窗（orders/page.tsx），所以直接取第一个合法目标做初值，
  // 不需要 useEffect 同步（避免 set-state-in-effect 的级联渲染）。
  const [target, setTarget] = useState<string>(() => allowed[0] ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!order || !target) return;
    setPending(true);
    setError(null);
    try {
      await apiClient.post(
        `/orders/${order.id}/status`,
        { status: target },
        { silent: true },
      );
      toast.success(
        `订单 ${order.order_no} 已流转为「${ORDER_STATUS_LABEL[target] ?? target}」`,
      );
      onOpenChange(false);
      void qc.invalidateQueries({ queryKey: ["upstream", "orders"] });
      onChanged?.();
    } catch (err) {
      setError(orderStatusErrorText(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>订单状态流转</DialogTitle>
          <DialogDescription>
            {order
              ? `${order.order_no} · 当前「${
                  ORDER_STATUS_LABEL[order.status] ?? order.status
                }」`
              : ""}
          </DialogDescription>
        </DialogHeader>

        {allowed.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            「{ORDER_STATUS_LABEL[order?.status ?? ""] ?? order?.status}
            」是终态，没有可流转的目标。
          </p>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1">
              <span className="text-sm font-medium">流转到</span>
              <select
                aria-label="目标状态"
                className="h-9 w-full rounded-lg border border-input bg-background px-2 text-sm"
                value={target}
                disabled={pending}
                onChange={(e) => setTarget(e.target.value)}
              >
                {allowed.map((status) => (
                  <option key={status} value={status}>
                    {ORDER_STATUS_LABEL[status] ?? status}
                  </option>
                ))}
              </select>
            </div>
            <p
              className={`text-xs ${STATUS_TONE_TEXT[target] ?? "text-muted-foreground"}`}
            >
              {orderTransitionNote(order?.status ?? "", target)}
            </p>
            {error ? (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            ) : null}
          </div>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            取消
          </Button>
          <Button
            type="button"
            onClick={() => void submit()}
            disabled={pending || allowed.length === 0 || !target}
          >
            {pending ? "提交中…" : "确认流转"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
