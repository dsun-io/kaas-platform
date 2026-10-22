"use client";

/**
 * 直接下单卡（M3 设计 §7 / D-1）。
 *
 * 「订单是一等公民」：不经询盘、由电话/老客户返单/展会现场单等直接创建的订单
 * （`source_type='direct'`）**不计入漏斗**，由端点 `direct_orders` 单独返回，
 * 否则这部分真实成交会被漏斗口径吞掉。
 */
import { ShoppingCart } from "lucide-react";

import { EmptyState } from "@/components/shared/empty-state";
import { SectionCard } from "@/components/shared/section-card";
import { formatAmount } from "@/lib/dashboard/funnel";
import type { DashboardFunnelResponse } from "@/lib/schemas/responses";

export function DirectOrdersCard({
  orders,
}: {
  orders: DashboardFunnelResponse["direct_orders"];
}) {
  return (
    <SectionCard
      title="直接下单"
      description="不再经询盘的直接成交（电话单 / 老客户返单 / 展会现场单等），单独统计。"
    >
      {orders.count === 0 ? (
        <EmptyState
          icon={ShoppingCart}
          title="本时间窗内没有直接下单"
          description="直接下单在订单工位「直接新建订单」创建；有单后这里显示单数与金额。"
        />
      ) : (
        <div className="grid grid-cols-2 gap-4">
          <div>
            <p className="text-xs text-muted-foreground">订单数</p>
            <p
              className="mt-1 text-2xl font-semibold tabular-nums"
              data-testid="direct-orders-count"
            >
              {orders.count}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">金额合计</p>
            <p
              className="mt-1 text-2xl font-semibold tabular-nums"
              data-testid="direct-orders-amount"
            >
              {formatAmount(orders.amount)}
            </p>
            {/* 诚实口径：内核 SUM(total_amount) 不按币种分组，多币种混合时不是可加总金额 */}
            <p className="mt-1 text-[11px] text-muted-foreground">
              按订单金额原值相加（后端未分币种汇总），多币种时仅供规模参考。
            </p>
          </div>
        </div>
      )}
    </SectionCard>
  );
}
