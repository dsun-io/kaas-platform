"use client";

/**
 * 直接下单卡（M3 设计 §7 / D-1；P0-A A5 分币种）。
 *
 * 「订单是一等公民」：不经询盘、由电话/老客户返单/展会现场单等直接创建的订单
 * （`source_type='direct'`）**不计入漏斗**，由端点 `direct_orders` 单独返回，
 * 否则这部分真实成交会被漏斗口径吞掉。
 *
 * 金额口径（A5，重要）：
 *  · `by_currency` 存在时**按币种分行**展示（每币种 count/amount），页面上不做跨币种合计；
 *  · 顶层 `amount` 是**跨币种原值相加**、仅规模参考（旧契约保留兼容），
 *    有 by_currency 时把它降级成脚注，不放在主数字位（避免多币种时误导）；
 *  · 旧响应（没有 by_currency）仍回落到原来的 count/amount 展示。
 */
import { ShoppingCart } from "lucide-react";

import { EmptyState } from "@/components/shared/empty-state";
import { SectionCard } from "@/components/shared/section-card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatAmount } from "@/lib/dashboard/funnel";
import type { DashboardFunnelResponse } from "@/lib/schemas/responses";

export function DirectOrdersCard({
  orders,
}: {
  orders: DashboardFunnelResponse["direct_orders"];
}) {
  const byCurrency = orders.by_currency ?? [];
  const multiCurrency = byCurrency.length > 1;

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
        <div className="space-y-4">
          <div>
            <p className="text-xs text-muted-foreground">订单数</p>
            <p
              className="mt-1 text-2xl font-semibold tabular-nums"
              data-testid="direct-orders-count"
            >
              {orders.count}
            </p>
          </div>

          {byCurrency.length > 0 ? (
            <Table aria-label="直接下单按币种">
              <TableHeader>
                <TableRow>
                  <TableHead>币种</TableHead>
                  <TableHead className="text-right">单数</TableHead>
                  <TableHead className="text-right">金额</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {byCurrency.map((row) => (
                  <TableRow
                    key={row.currency}
                    data-testid={`direct-currency-${row.currency}`}
                  >
                    <TableCell className="font-medium">
                      {row.currency}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.count}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatAmount(row.amount)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <div>
              <p className="text-xs text-muted-foreground">金额合计</p>
              <p
                className="mt-1 text-2xl font-semibold tabular-nums"
                data-testid="direct-orders-amount"
              >
                {formatAmount(orders.amount)}
              </p>
            </div>
          )}

          {/* 诚实口径：内核的顶层 amount 不按币种分组，多币种混合时不是可加总金额 */}
          <p className="text-[11px] text-muted-foreground">
            {byCurrency.length > 0 ? (
              <>
                金额按币种分列；跨币种原值相加为{" "}
                <span data-testid="direct-orders-amount">
                  {formatAmount(orders.amount)}
                </span>
                （仅规模参考，多币种时不是可加总金额）。
              </>
            ) : (
              "按订单金额原值相加（后端未分币种汇总），多币种时仅供规模参考。"
            )}
          </p>
          {multiCurrency ? (
            <p className="text-[11px] text-muted-foreground">
              多币种：只做同币种内合计，未折算汇率。
            </p>
          ) : null}
        </div>
      )}
    </SectionCard>
  );
}
