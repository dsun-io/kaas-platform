"use client";

/**
 * 仪表盘（M3，设计 §7 / D-6）—— 商机漏斗 + 分渠道转化 + 直接下单 + 订单应收概览。
 *
 * 口径（业务规则只在 Python 内核 `backend/kaas_common/workstation/funnel.py`）：
 *  · 时间窗内**创建的询盘**做 cohort：询盘 → 已报价 → 已下单 → 已成笔；
 *  · 权重：询盘 ×1 / 报价 ×2 / 订单 ×10（综合商机分）；
 *  · 直接下单（source_type='direct'）不进漏斗，单独统计；
 *  · 转化率分母为 0 时后端回 null，页面显示「—」（不是 0%）。
 *
 * 为什么不再用 `/dashboard/summary`：三表混计数（报价/客户/事件）回答不了
 * 「询盘后来怎样了」，且 token/p95 生产恒为 0 —— 把「没有数据」渲染成 0 比不显示更糟
 * （旧占位页注释里记过这条）。旧端点与 schema 保留兼容，页面不再依赖。
 *
 * 订单应收概览：后端暂无聚合端点，卡片给「待补后端」明确空态而非假数据
 * （见 `components/receivables-overview-card.tsx`）。
 */
import { useState } from "react";
import { AlertCircle, CalendarRange } from "lucide-react";

import { EmptyState } from "@/components/shared/empty-state";
import { LoadingBlock } from "@/components/shared/loading-block";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { Button } from "@/components/ui/button";
import { normalizeApiError } from "@/lib/api/api-error";
import { DASHBOARD_DEFAULT_RANGE, isEmptyFunnel } from "@/lib/dashboard/funnel";
import { usePageView } from "@/lib/events/use-page-view";

import { ChannelConversionTable } from "./components/channel-conversion-table";
import { DirectOrdersCard } from "./components/direct-orders-card";
import { CompositeScore, FunnelStages } from "./components/funnel-stages";
import { RangeSelector } from "./components/range-selector";
import { ReceivablesOverviewCard } from "./components/receivables-overview-card";
import { useDashboardFunnel } from "./hooks/use-dashboard-funnel";

export default function DashboardPage() {
  usePageView({ resource_id: "/dashboard" });

  const [range, setRange] = useState<string>(DASHBOARD_DEFAULT_RANGE);
  const { data, error, isError, isLoading, refetch } =
    useDashboardFunnel(range);
  const empty = data ? isEmptyFunnel(data.funnel) : false;

  return (
    <div className="space-y-6">
      <PageHeader
        title="仪表盘"
        description="商机漏斗：按时间窗内创建的询盘看询盘→报价→下单→成笔的转化与渠道质量；直接下单单独统计。"
        actions={<RangeSelector value={range} onChange={setRange} />}
      />

      {isLoading ? (
        <>
          <SectionCard title="商机漏斗" description="正在读取漏斗数据…">
            <LoadingBlock rows={4} />
          </SectionCard>
          <SectionCard title="分渠道转化" description="正在读取渠道数据…">
            <LoadingBlock rows={4} />
          </SectionCard>
        </>
      ) : isError ? (
        <SectionCard title="仪表盘数据读取失败">
          <div className="flex flex-col items-start gap-3 py-4">
            <p className="flex items-center gap-2 text-sm text-destructive">
              <AlertCircle className="size-4" aria-hidden="true" />
              读取仪表盘数据失败：{normalizeApiError(error).message}
            </p>
            <Button size="sm" variant="outline" onClick={() => void refetch()}>
              重试
            </Button>
          </div>
        </SectionCard>
      ) : data ? (
        <>
          <SectionCard
            title="商机漏斗"
            description="时间窗内创建的询盘 cohort；直接下单不计入漏斗。转化率分母为 0 时显示「—」。"
            action={<CompositeScore score={data.funnel.composite_score} />}
          >
            {empty ? (
              <EmptyState
                icon={CalendarRange}
                title="该时间窗内还没有询盘"
                description="漏斗按询盘创建时间统计；本时间窗没有新询盘时，报价/下单/成笔也一定为 0。可以换个更长的时间范围，或去询盘工位建询盘。"
                action={
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setRange("30d")}
                  >
                    看近 30 天
                  </Button>
                }
              />
            ) : (
              <FunnelStages funnel={data.funnel} />
            )}
          </SectionCard>

          <SectionCard
            title="分渠道转化"
            description="按综合商机分降序；转化率 = 该渠道订单数 / 该渠道询盘数（后端口径，分母为 0 显示「—」）。"
          >
            {data.channels.length === 0 ? (
              <EmptyState
                title="暂无渠道数据"
                description="询盘按渠道（邮件 / WhatsApp / 阿里巴巴 / 展会 …）自动汇总；本时间窗没有询盘时为空。"
              />
            ) : (
              <ChannelConversionTable channels={data.channels} />
            )}
          </SectionCard>

          <div className="grid gap-6 lg:grid-cols-2">
            <DirectOrdersCard orders={data.direct_orders} />
            <ReceivablesOverviewCard />
          </div>
        </>
      ) : null}
    </div>
  );
}
