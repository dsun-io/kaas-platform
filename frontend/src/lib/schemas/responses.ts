import { z } from "zod";

export const EventsResponseSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      event_type: z.string(),
      event_source: z.string(),
      schema_version: z.number(),
      actor_id: z.string().optional(),
      tenant_id: z.string(),
      session_id: z.string().optional(),
      trace_id: z.string().optional(),
      payload: z.record(z.unknown()),
      created_at: z.string(),
      sampled: z.boolean().optional(),
      oss_url: z.string().nullable().optional(),
    }),
  ),
  total: z.number(),
  page: z.number(),
  page_size: z.number(),
});

/**
 * @deprecated M3（2026-10-22 设计 §7）起 `GET /dashboard/summary` 是**三表混计数**
 * （报价数/客户数/事件数），回答不了「询盘后来怎样了」，dashboard 页已改用
 * `DashboardFunnelResponseSchema`。schema 保留只为旧端点兼容与既有测试，
 * 新代码不要再依赖它。
 */
export const DashboardResponseSchema = z.object({
  range: z.string(),
  quotations_total: z.number(),
  quotations_sampled: z.number(),
  active_customers: z.number(),
  customers_sampled: z.number(),
  dataset_hits: z.record(z.number()),
  token_total: z.number(),
  token_sampled: z.number(),
  p95_latency_ms: z.number(),
  latency_sampled: z.number(),
});

export const CustomersResponseSchema = z.array(
  z.object({
    customer_id: z.string(),
    customer_name: z.string(),
    category_count: z.number(),
    updated_at: z.string(),
    locale: z.string(),
    region: z.string(),
  }),
);

export const CapabilitiesResponseSchema = z.array(
  z.object({
    id: z.string(),
    product_category: z.string(),
    spec_constraints: z.record(z.unknown()),
    is_active: z.boolean(),
  }),
);

export const QuotationsResponseSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      quotation_id: z.string(),
      customer_id: z.string(),
      product_category: z.string(),
      product_spec: z.record(z.unknown()),
      quantity: z.number(),
      unit_price: z.number().nullable(),
      unit: z.string().nullable(),
      confidence: z.string(),
      source: z.string(),
      status: z.string(),
      discount: z.number().optional(),
      notes: z.string().optional(),
      spec_hash: z.string(),
      effective_from: z.string(),
      is_active: z.boolean(),
      created_at: z.string(),
    }),
  ),
  total: z.number(),
});

/**
 * 商机漏斗（M3 设计 §7 / D-6）—— `GET /api/v1/dashboard/funnel`。
 *
 * 形状真源 = 内核 `backend/kaas_common/workstation/funnel.py`（build_funnel /
 * channel_conversion_rates）+ `backend/worker/src/main.py:dashboard_funnel`。
 *
 * 关键口径（不要"修正"）：
 *  · `conversion_rates` 各项是 `float | None`：分母为 0 时后端回 **null**，
 *    前端必须保留 null（渲染「—」），不能 default 成 0；
 *  · `funnel.stages[3].amount` 只出现在「已成笔」阶段（成交金额汇总）；
 *  · `channels` 已按 `composite_score` 降序，前端重排只为渲染确定性；
 *  · `direct_orders` 是**直接下单**（source_type='direct'），不计入漏斗。
 */
export const DashboardFunnelStageSchema = z.object({
  name: z.string(),
  label: z.string(),
  count: z.number(),
  // 仅「已成笔」带金额；其余阶段无此键
  amount: z.number().optional(),
});

/** 直接下单按币种拆账行（内核 `funnel.py:direct_currency_breakdown`）。 */
export const DashboardDirectCurrencySchema = z.object({
  currency: z.string(),
  count: z.number(),
  amount: z.number(),
});

export const DashboardFunnelResponseSchema = z.object({
  range: z.string(),
  // 时间窗起点（ISO 8601，带时区）
  since: z.string(),
  funnel: z.object({
    stages: z.array(DashboardFunnelStageSchema),
    conversion_rates: z.object({
      inquiry_to_quote: z.number().nullable(),
      quote_to_order: z.number().nullable(),
      order_to_completed: z.number().nullable(),
      inquiry_to_completed: z.number().nullable(),
    }),
    composite_score: z.number(),
  }),
  channels: z.array(
    z.object({
      channel: z.string(),
      inquiry_count: z.number(),
      quote_count: z.number(),
      order_count: z.number(),
      completed_count: z.number(),
      conversion_rates: z.object({
        inquiry_to_order: z.number().nullable(),
        inquiry_to_completed: z.number().nullable(),
      }),
      composite_score: z.number(),
    }),
  ),
  direct_orders: z.object({
    // 单数可跨币种相加（就是订单个数）
    count: z.number(),
    // ⚠️ 跨币种**原值相加**，仅规模参考；精确金额只看 `by_currency`
    amount: z.number(),
    // P0-A A5：按币种拆账（内核 funnel.py:direct_currency_breakdown）。
    // optional：旧响应/旧 mock 可能还没有该字段，卡片需保持 count/amount 兼容。
    by_currency: z.array(DashboardDirectCurrencySchema).optional(),
  }),
  // 旧 /dashboard/summary 的废弃标记（M3 起页面不再依赖 summary）
  deprecated_summary: z.boolean().optional(),
});

/**
 * 应收概览（P0-A A3）—— `GET /api/v1/dashboard/receivables?range=`。
 *
 * 形状真源 = 内核 `backend/kaas_common/workstation/receivable_summary.py:summarize_receivables`
 * （聚合口径只在后端；前端不得重算）+ `backend/worker/src/main.py:dashboard_receivables`。
 *
 * 关键口径（不要"修正"）：
 *  · **金额只在同币种内相加**：`by_currency` 每币种一行，前端不做跨币种合计；
 *  · `by_status[].total` 是**跨币种原值相加**，只作规模参考（卡片不把它当金额展示）；
 *  · 未收 = max(0, 应收 − 已收)，逐行夹 0 后汇总（后端已算好）；
 *  · 币种缺失 → "—"（内核 UNKNOWN_CURRENCY，不伪造 USD）。
 */
export const DashboardReceivablesCurrencySchema = z.object({
  currency: z.string(),
  total: z.number(),
  received: z.number(),
  outstanding: z.number(),
  count: z.number(),
});

export const DashboardReceivablesStatusSchema = z.object({
  status: z.string(),
  count: z.number(),
  // ⚠️ 跨币种原值相加，仅规模参考（不展示成金额）
  total: z.number(),
});

export const DashboardReceivablesResponseSchema = z.object({
  range: z.string(),
  since: z.string(),
  by_currency: z.array(DashboardReceivablesCurrencySchema),
  by_status: z.array(DashboardReceivablesStatusSchema),
  // 行数是唯一可跨状态/跨币种的计数
  totals: z.object({ count: z.number() }),
});

export type EventsResponse = z.infer<typeof EventsResponseSchema>;
export type DashboardResponse = z.infer<typeof DashboardResponseSchema>;
export type DashboardFunnelResponse = z.infer<
  typeof DashboardFunnelResponseSchema
>;
export type DashboardFunnelStage = z.infer<typeof DashboardFunnelStageSchema>;
export type DashboardFunnelChannel =
  DashboardFunnelResponse["channels"][number];
export type DashboardDirectCurrency = z.infer<
  typeof DashboardDirectCurrencySchema
>;
export type DashboardReceivablesResponse = z.infer<
  typeof DashboardReceivablesResponseSchema
>;
export type DashboardReceivablesCurrency = z.infer<
  typeof DashboardReceivablesCurrencySchema
>;
export type DashboardReceivablesStatus = z.infer<
  typeof DashboardReceivablesStatusSchema
>;
export type CustomersResponse = z.infer<typeof CustomersResponseSchema>;
export type CapabilitiesResponse = z.infer<typeof CapabilitiesResponseSchema>;
export type QuotationsResponse = z.infer<typeof QuotationsResponseSchema>;
