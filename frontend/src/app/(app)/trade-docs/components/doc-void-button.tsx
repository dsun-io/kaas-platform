"use client";

/**
 * 单证「作废」按钮 + 二次确认（P0-B1 / 审计 T1）。
 *
 * 作废（`issued → void`）为什么必须确认：
 *  · 已签发单证是**法律凭证**，作废不可恢复（后端内容也已冻结）；
 *  · 同一票货的派生单（发票/装箱单/提单…）以已签发件为基线，
 *    作废后上下游事实会对不上，需要人工重开。
 *
 * 防重：保存中禁用按钮，并用 `inFlight` ref 兜住同一 tick 连点两次
 * （此时 mutation.isPending 还没随重渲染生效，重复 PATCH 会重复写状态）。
 */
import { useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { normalizeApiError } from "@/lib/api/api-error";

import { useUpdateTradeDoc, type TradeDocRow } from "../hooks/use-trade-docs";

export function DocVoidButton({
  doc,
  onVoided,
}: {
  doc: TradeDocRow;
  onVoided?: (updated: TradeDocRow) => void;
}) {
  const update = useUpdateTradeDoc();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const confirm = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setError(null);
    try {
      const updated = await update.mutateAsync({ id: doc.id, status: "void" });
      setOpen(false);
      toast.success("已作废");
      onVoided?.(updated);
    } catch (err) {
      // 失败原因（如 409 已作废/下游锁定）透出在弹窗里，弹窗不关
      setError(normalizeApiError(err).message);
    } finally {
      inFlight.current = false;
    }
  };

  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        disabled={update.isPending}
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
      >
        作废
      </Button>

      <ConfirmDialog
        open={open}
        onOpenChange={(next) => {
          if (!next && !update.isPending) {
            setOpen(false);
            setError(null);
          }
        }}
        title={`作废单证 ${doc.doc_no}？`}
        description="该单证已签发，作废后不可恢复；同一票货的派生单（发票 / 装箱单 / 提单等）以已签发件为基线，作废后需要人工重开并对齐上下游事实。"
        confirmLabel="确认作废"
        pending={update.isPending}
        error={error}
        onConfirm={() => void confirm()}
      />
    </>
  );
}
