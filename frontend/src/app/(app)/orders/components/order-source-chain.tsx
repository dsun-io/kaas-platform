"use client";

/**
 * 订单来源链横幅（设计 §9.2）—— 详情头部一眼看清「这单从哪来」。
 *
 * 两种来源都是**正常业务**（D-1）：
 *   · inquiry：询盘 → 报价 → 本订单，环节可点跳（/inquiries?inquiry_id=、/quotes?tab=records）；
 *   · direct ：直接下单（线下电话单 / 老客户返单 / 展会现场单），展示渠道与确认痕迹。
 * 渠道未知不伪造（历史单的 source_channel 为 null）。
 */
import Link from "next/link";
import type { Route } from "next";
import { ChevronRight } from "lucide-react";

import { StatusBadge } from "@/components/shared/status-badge";
import {
  normalizeOrderSourceType,
  orderConfirmSourceLabel,
  orderSourceChain,
  orderSourceLabel,
  orderSourceTone,
} from "@/lib/orders/order-source";
import { formatOrderDate, type OrderDetail } from "@/lib/orders/order-detail";
import { channelLabel } from "@/lib/inquiries/format";

export function OrderSourceChain({ order }: { order: OrderDetail }) {
  const type = normalizeOrderSourceType(order.source_type);
  const chain = orderSourceChain(order);
  const confirmLabel = orderConfirmSourceLabel(order.confirmed_source);

  return (
    <div
      aria-label="订单来源链"
      className="mb-4 rounded-lg border border-border/70 bg-muted/30 px-3 py-2 text-sm"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">来源</span>
        <StatusBadge tone={orderSourceTone(order.source_type)}>
          {orderSourceLabel(order.source_type, order.source_channel)}
        </StatusBadge>
        {chain.length > 0 && (
          <ol className="flex flex-wrap items-center gap-1 text-xs">
            {chain.map((step, index) => (
              <li
                key={`${step.kind}-${index}`}
                className="flex items-center gap-1"
              >
                {index > 0 && (
                  <ChevronRight className="size-3.5 text-muted-foreground/60" />
                )}
                {step.href ? (
                  <Link
                    href={step.href as Route}
                    className="font-medium text-primary underline-offset-2 hover:underline"
                  >
                    {step.label}
                  </Link>
                ) : (
                  <span className="font-medium">{step.label}</span>
                )}
              </li>
            ))}
          </ol>
        )}
      </div>

      {type === "direct" ? (
        <p className="mt-1 text-[11px] text-muted-foreground">
          直接下单（正常分类）：线下电话单 / 老客户返单 /
          展会现场单；不关联询盘。
          {order.source_channel
            ? `渠道：${channelLabel(order.source_channel)}。`
            : "渠道未知（历史单不伪造来源）。"}
        </p>
      ) : (
        <p className="mt-1 text-[11px] text-muted-foreground">
          询盘转化链：询盘报价谈成后转成本单；点上面的环节可回溯。
          {order.source_channel
            ? `询盘渠道：${channelLabel(order.source_channel)}。`
            : ""}
        </p>
      )}

      {order.confirmed_at ? (
        <p className="mt-1 text-[11px] text-muted-foreground">
          确认痕迹：{formatOrderDate(order.confirmed_at)}
          {confirmLabel ? ` · ${confirmLabel}` : ""}
          {order.confirmed_by ? ` · 操作人 #${order.confirmed_by}` : ""}
        </p>
      ) : (
        <p className="mt-1 text-[11px] text-muted-foreground">
          尚未确认：登记定金到账或人工确认后，才会锁汇率并生成应收。
        </p>
      )}
    </div>
  );
}
