"use client";

/**
 * 关联订单 —— 两条来源都算（设计 §3.1）：
 *   ① 订单正列 `orders.inquiry_id`（询盘直接转单）；
 *   ② 经报价传递（`orders.quote_id → quote_orders.inquiry_id`，迁移前的历史单只有这条）。
 *
 * 后端已经在详情里合并好（ws_crm_ext.py:450-459），前端只负责展示与跳转。
 * 跳转用 `/orders?id=<id>`（任务口径）；订单页目前不读 ?id=，见报告「建议优化点」。
 */
import Link from "next/link";
import type { Route } from "next";

import { StatusBadge } from "@/components/shared/status-badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { orderDetailHref } from "@/lib/inquiries/filters";
import {
  formatInquiryDate,
  formatInquiryMoney,
  orderStatusLabel,
  orderStatusTone,
} from "@/lib/inquiries/format";
import type { InquiryOrder } from "@/lib/inquiries/types";

export function InquiryOrdersPanel({ orders }: { orders: InquiryOrder[] }) {
  if (orders.length === 0) {
    return (
      <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
        还没有关联订单。报价被客户接受后，在报价工位转订单（或直接建单并选这条询盘），
        订单会自动挂到这里。
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>订单号</TableHead>
            <TableHead>状态</TableHead>
            <TableHead className="text-right">金额</TableHead>
            <TableHead>下单时间</TableHead>
            <TableHead>操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {orders.map((order) => (
            <TableRow key={order.id}>
              <TableCell className="font-mono text-xs">
                {order.order_no}
              </TableCell>
              <TableCell>
                <StatusBadge tone={orderStatusTone(order.status)}>
                  {orderStatusLabel(order.status)}
                </StatusBadge>
              </TableCell>
              <TableCell className="text-right text-xs tabular-nums">
                {formatInquiryMoney(order.total_amount, order.currency)}
              </TableCell>
              <TableCell className="text-xs">
                {formatInquiryDate(order.order_date ?? order.created_at)}
              </TableCell>
              <TableCell>
                <Link
                  href={orderDetailHref(order.id) as Route}
                  className="text-xs font-medium text-primary hover:underline"
                  aria-label={`查看订单 ${order.order_no}`}
                >
                  查看订单 →
                </Link>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
