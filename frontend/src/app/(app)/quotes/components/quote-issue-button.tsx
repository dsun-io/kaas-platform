"use client";

/**
 * 「签发报价单」按钮 + 二次确认（P0-B1 / 审计 Q2）。
 *
 * 为什么要二次确认：签发 = `draft → sent`，后端会**向报价记录台账入账一条**，
 * 且签发后报价是法律凭证（行项与金额锁定、不能回退草稿）。原实现点一下即生效，
 * 误点没有回头路。
 *
 * 为什么做成独立组件（而不是各页各写一份）：
 *  · 工作台有**两个**签发入口（右侧汇总卡 + 窄屏底部吸底条），两处必须同一套确认/防重；
 *  · pending 期间重复点会重复 PATCH（重复入账），所以除了按钮 disabled 之外，
 *    还用 `inFlight` ref 兜住"同一 tick 连点两次"（此时 mutation.isPending 还没生效）。
 */
import { useRef, useState } from "react";
import { Loader2, ShieldCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { normalizeApiError } from "@/lib/api/api-error";
import type { QuoteOrder } from "@contracts/quote-order";

import { useUpdateQuoteOrder } from "../hooks/use-quote-orders";

export function QuoteIssueButton({
  quoteOrderId,
  quoteNo,
  status,
  onIssued,
  label = "签发报价单",
  className,
}: {
  /** 已保存的报价单 id（null = 还没保存，不能签发） */
  quoteOrderId: number | null;
  quoteNo: string | null;
  /** 当前单据状态：只有 draft 可签发 */
  status: string | null;
  onIssued?: (updated: QuoteOrder) => void;
  label?: string;
  className?: string;
}) {
  const update = useUpdateQuoteOrder();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const canIssue = quoteOrderId !== null && status === "draft";
  const pending = update.isPending;

  // 局部处理函数不叫 `confirm`：与全局 window.confirm 同名会让静态门禁/读代码的人
  // 误以为这里还在用原生弹窗（实际 UI 是下面的 ConfirmDialog）。
  const handleConfirm = async () => {
    if (quoteOrderId === null || inFlight.current) return;
    inFlight.current = true;
    setError(null);
    try {
      const updated = await update.mutateAsync({
        id: quoteOrderId,
        patch: { status: "sent" as const },
      });
      setOpen(false);
      onIssued?.(updated);
    } catch (err) {
      // 失败原因留在弹窗里（例如下游已开单证导致 409），弹窗不关
      setError(normalizeApiError(err).message);
    } finally {
      inFlight.current = false;
    }
  };

  return (
    <>
      <Button
        type="button"
        size="sm"
        className={className ?? "gap-1.5"}
        disabled={!canIssue || pending}
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
      >
        {pending ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <ShieldCheck className="size-3.5" />
        )}
        {label}
      </Button>

      <ConfirmDialog
        open={open}
        onOpenChange={(next) => {
          if (!next && !update.isPending) {
            setOpen(false);
            setError(null);
          }
        }}
        title={`签发报价单 ${quoteNo ?? ""}？`}
        description="签发后该报价单立即对外生效，并向「报价记录」台账入账一条；签发后是法律凭证，行项与金额将被锁定、不能回退为草稿。"
        confirmLabel="确认签发"
        pending={pending}
        error={error}
        onConfirm={() => void handleConfirm()}
      />
    </>
  );
}
