"use client";

/**
 * 分渠道转化表（M3 设计 §7）。
 *
 * 渠道清单与转化率全部来自 `GET /dashboard/funnel` 的 `channels`：
 * 转化率 = 该渠道订单数 / 该渠道询盘数（后端 `channel_conversion_rates`）。
 * 页面按综合商机分降序展示（后端也已排序，前端重排保证渲染稳定）。
 */
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  channelLabel,
  formatPercent,
  sortChannelsByScore,
} from "@/lib/dashboard/funnel";
import type { DashboardFunnelChannel } from "@/lib/schemas/responses";

export function ChannelConversionTable({
  channels,
}: {
  channels: ReadonlyArray<DashboardFunnelChannel>;
}) {
  const rows = sortChannelsByScore(channels);

  return (
    <Table aria-label="分渠道转化">
      <TableHeader>
        <TableRow>
          <TableHead>渠道</TableHead>
          <TableHead className="text-right">询盘</TableHead>
          <TableHead className="text-right">报价</TableHead>
          <TableHead className="text-right">订单</TableHead>
          <TableHead className="text-right">已成笔</TableHead>
          <TableHead className="text-right">询盘→订单</TableHead>
          <TableHead className="text-right">询盘→成单</TableHead>
          <TableHead className="text-right">综合分</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((channel) => (
          <TableRow key={channel.channel}>
            <TableCell className="font-medium">
              {channelLabel(channel.channel)}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {channel.inquiry_count}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {channel.quote_count}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {channel.order_count}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {channel.completed_count}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {formatPercent(channel.conversion_rates.inquiry_to_order)}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {formatPercent(channel.conversion_rates.inquiry_to_completed)}
            </TableCell>
            <TableCell className="text-right font-medium tabular-nums">
              {channel.composite_score}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
