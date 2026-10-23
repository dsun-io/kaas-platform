"use client";

/**
 * 实收记录区：一次到账一行（同一期可多次），差异只展示不自动改计划。
 *
 * 两块内容：
 * - 实收记录表：日期 / 金额 / 对应期次 / 差异 / 汇率 / 备注 / 到账截图（查看或补传）；
 * - **未分配收款**（schedule_id=null）单独列出：这些钱没有对应到某一期，
 *   页面不会静默摊到计划金额上（财务核对口径，不能省）。
 *
 * 「对应期次」按**列表期次序号**显示（O3 同口径）：找不到该期（历史数据被删）时
 * 回退成 `#schedule_id`，不伪造期次。
 */
import { Upload } from "lucide-react";

import { Button } from "@/components/ui/button";
import { formatOrderDate, formatOrderMoney } from "@/lib/orders/order-detail";
import { RECEIPT_IMAGE_ACCEPT } from "@/lib/orders/order-attachments";
import {
  SCHEDULE_TYPE_LABEL,
  unallocatedReceipts,
  type PaymentReceipt,
  type PaymentSchedule,
} from "@/lib/orders/payment-schedules";

import { diffText } from "./payment-schedule-format";

export function ReceiptsSection({
  items,
  receipts,
  currency,
  busy,
  onOpenScreenshot,
  onUploadScreenshot,
}: {
  items: PaymentSchedule[];
  receipts: PaymentReceipt[];
  currency: string | null;
  /** 上传中/其他写操作进行中：禁用补传输入的重复提交 */
  busy: boolean;
  onOpenScreenshot: (fileId: number) => void;
  onUploadScreenshot: (receiptId: number, file: File) => void;
}) {
  const scheduleLabel = (receipt: PaymentReceipt): string => {
    if (receipt.schedule_id === null) return "未分配";
    const index = items.findIndex((item) => item.id === receipt.schedule_id);
    if (index < 0) return `#${receipt.schedule_id}`;
    const item = items[index];
    return `第 ${index + 1} 期（${
      item
        ? (SCHEDULE_TYPE_LABEL[item.schedule_type] ?? item.schedule_type)
        : ""
    }）`;
  };

  const receiptDiff = (receipt: PaymentReceipt): number | null => {
    if (receipt.schedule_id === null) return null;
    const schedule = items.find((item) => item.id === receipt.schedule_id);
    if (!schedule || typeof schedule.amount !== "number") return null;
    return Math.round((receipt.amount - schedule.amount) * 100) / 100;
  };

  const unallocated = unallocatedReceipts(receipts);

  return (
    <div className="mt-5 space-y-2">
      <h3 className="text-sm font-medium">实收记录</h3>
      <p className="text-xs text-muted-foreground">
        一次到账一行，支持同一期多次收款；差异 = 实收 − 该期应收，供财务核对。
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th scope="col" className="p-2">
                收款日期
              </th>
              <th scope="col" className="p-2">
                实收金额
              </th>
              <th scope="col" className="p-2">
                对应期次
              </th>
              <th scope="col" className="p-2">
                差异
              </th>
              <th scope="col" className="p-2">
                汇率
              </th>
              <th scope="col" className="p-2">
                备注
              </th>
              <th scope="col" className="p-2">
                到账截图
              </th>
            </tr>
          </thead>
          <tbody>
            {receipts.map((receipt) => (
              <tr key={receipt.id} className="border-b last:border-0">
                <td className="p-2">
                  {formatOrderDate(receipt.received_date)}
                </td>
                <td className="p-2">
                  {formatOrderMoney(
                    receipt.amount,
                    receipt.currency ?? currency,
                  )}
                </td>
                <td className="p-2">{scheduleLabel(receipt)}</td>
                <td className="p-2">
                  {diffText(receiptDiff(receipt), currency)}
                </td>
                <td className="p-2">
                  {receipt.fx_rate === null ? "—" : receipt.fx_rate}
                </td>
                <td
                  className="p-2 max-w-[220px] truncate"
                  title={receipt.notes ?? ""}
                >
                  {receipt.notes || "—"}
                </td>
                <td className="p-2">
                  {receipt.file_id ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        onOpenScreenshot(receipt.file_id as number)
                      }
                    >
                      查看到账截图
                    </Button>
                  ) : (
                    <label className="inline-flex cursor-pointer items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-muted/40">
                      <Upload className="size-3" />
                      补传截图
                      <input
                        type="file"
                        className="sr-only"
                        aria-label={`补传到账截图 #${receipt.id}`}
                        accept={RECEIPT_IMAGE_ACCEPT}
                        disabled={busy}
                        onChange={(event) => {
                          const file = event.target.files?.[0] ?? null;
                          event.target.value = "";
                          if (file) onUploadScreenshot(receipt.id, file);
                        }}
                      />
                    </label>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {unallocated.length > 0 && (
        <div className="rounded-lg border border-warning/40 bg-warning-muted p-3 text-xs text-warning-muted-foreground">
          <p className="font-medium">
            未分配收款 {unallocated.length} 笔（暂未指定期次）
          </p>
          <ul className="mt-1 space-y-0.5">
            {unallocated.map((receipt) => (
              <li key={receipt.id}>
                {formatOrderDate(receipt.received_date)} ·{" "}
                {formatOrderMoney(receipt.amount, receipt.currency ?? currency)}
                {receipt.notes ? ` · ${receipt.notes}` : ""}
              </li>
            ))}
          </ul>
          <p className="mt-1">
            这些钱没有对应到某一期，页面不会静默摊到计划金额上；请财务与客户核对后调整计划或补指定期次。
          </p>
        </div>
      )}
    </div>
  );
}
