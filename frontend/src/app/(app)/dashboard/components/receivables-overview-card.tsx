"use client";

/**
 * 订单应收概览（M3 设计 §7 要求；后端聚合端点**尚未提供**）。
 *
 * 现状（2026-10-22 核实）：
 *  · 内核只有 `GET /api/v1/receivables` 分页台账（按 status 筛选），
 *    没有「按时间窗汇总应收总额/已收/未收」的端点；
 *  · 前端自己把列表拼成"概览"会算出**只覆盖当前页**的假数字，还会忽略
 *    每行币种（`lib/receivables/summary.ts` 已明确「应收金额不能跨币种相加」）。
 *
 * 所以这里不造数：给「待补后端」的明确空态，并在任务报告登记为缺口。
 * 后端补 `GET /dashboard/receivables`（或 funnel 响应内嵌 receivable_summary）后，
 * 本卡直接换成真实数字即可，页面其它部分不用动。
 */
import { Wallet } from "lucide-react";

import { EmptyState } from "@/components/shared/empty-state";
import { SectionCard } from "@/components/shared/section-card";

export function ReceivablesOverviewCard() {
  return (
    <SectionCard
      title="订单应收概览"
      description="设计 §7 要求：按时间窗看应收总额 / 已收 / 未收。"
    >
      <EmptyState
        icon={Wallet}
        title="待补后端聚合接口"
        description="内核目前只有 GET /receivables 分页台账（无时间窗汇总），没有 dashboard 维度的应收聚合。为避免用前端拼数冒充汇总，这里如实留空；接口就绪后接到本卡。"
      />
    </SectionCard>
  );
}
