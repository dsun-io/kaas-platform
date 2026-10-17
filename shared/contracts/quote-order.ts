/**
 * 报价单（quote_orders）契约 —— 「一个询盘 → 多个产品 → 一张报价单」的落库形状。
 *
 * 为什么要有这个文件：
 *   `quotes.py` 被判定为遗留实现（前端零调用 + 线上无路由），而"多产品报价 + 从报价单
 *   生成整单单证"必须有一个**现行**的报价单契约。本文件是它的唯一真相源，
 *   与后端 `app/api/quote_orders.py` 的 Pydantic 模型逐字段对齐。
 *
 * 设计要点：
 *  1. **行项是产品的载体**：一行 = 一个产品 + 它自己的一套规格与数量。
 *     多产品 = 多行，不是多个报价单。
 *  2. **试算不落库、草稿不落账**：本契约描述的是"报价单"这一实体；
 *     台账只在签发（draft→sent）时写一条，与平台既定纪律一致。
 *  3. 申报要素（`hs_code` / `package` / `gross_weight` / `net_weight` / `volume`
 *     / `specification`）放在 `spec_snapshot` 里 —— 单证装配层
 *     （`app/services/trade_doc_payload.py` 的 `_SPEC_FIELDS`）会按这些键摊平，
 *     因此**单证侧无需任何改动**即可渲染多产品行项。
 */
import { z } from 'zod';

/** 数量单位：一"卷"是丝网类产品的计价单位（Quantity = 卷数）。 */
export const QTY_UNIT_ROLLS = 'ROLLS';

/**
 * 报价单行项（写入形状）。
 *
 * `qty` / `unit_price` / `line_amount` 三者必须同口径：
 * **`line_amount = qty × unit_price`**（精确相乘，不做两次舍入）。
 * 这是单证审单第一条硬规则（单价×数量=总价），也是"报价工位汇总 =
 * 单证 TOTAL 行"的成立前提。
 */
export const QuoteOrderItemInSchema = z.object({
  /** 产品英文名（单证是英文单据，Description of Goods 直接取它） */
  product_name: z.string().min(1),
  sku_id: z.number().int().nullable().optional(),
  /**
   * 规格快照。约定必含：
   * `specification`(英文规格描述) / `hs_code` / `package` / `gross_weight`
   * / `net_weight` / `volume`，外加引擎原始参数（审计与重算用）。
   */
  spec_snapshot: z.record(z.unknown()).nullable().optional(),
  /** 数量 = 卷数 */
  qty: z.number().positive(),
  qty_unit: z.string().default(QTY_UNIT_ROLLS),
  /** 单价 = 单卷外币价 */
  unit_price: z.number().nullable().optional(),
  /** 行项币种；留空则继承单头币种 */
  currency: z.string().nullable().optional(),
  line_amount: z.number().nullable().optional(),
  /** 决定单证上的行序 */
  sort_order: z.number().int().default(0),
  /**
   * 内部分解快照（成本/利润，签发时从算价引擎 internal 视图带来）。
   * 仅 platform 员工（account_type=internal）可读——后端接口层对
   * customer 账号剥除本字段，前端不得把它渲染进任何对外/客户可见界面。
   */
  cost_breakdown: z.record(z.unknown()).nullable().optional(),
});
export type QuoteOrderItemIn = z.infer<typeof QuoteOrderItemInSchema>;

export const QuoteOrderItemSchema = QuoteOrderItemInSchema.extend({
  id: z.number().int(),
  quote_order_id: z.number().int(),
  created_at: z.string().nullable().default(null),
});
export type QuoteOrderItem = z.infer<typeof QuoteOrderItemSchema>;

/** 贸易条款：报价阶段谈定的，必须能被订单与单证继承（否则信用证审单会出不符点）。 */
export const TradeTermsSchema = z.object({
  incoterm: z.string().nullable().optional(),
  payment_terms: z.string().nullable().optional(),
  port_of_loading: z.string().nullable().optional(),
  port_of_destination: z.string().nullable().optional(),
  shipping_marks: z.string().nullable().optional(),
  country_of_origin: z.string().nullable().optional(),
});
export type TradeTerms = z.infer<typeof TradeTermsSchema>;

export const QuoteOrderCreateSchema = TradeTermsSchema.extend({
  customer_id: z.string().nullable().optional(),
  customer_name: z.string().nullable().optional(),
  /** 询盘来源：一个询盘一张报价单（`quote_orders.inquiry_id`） */
  inquiry_id: z.number().int().nullable().optional(),
  currency: z.string().default('USD'),
  valid_until: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  owner_scope: z.enum(['private', 'tenant']).default('private'),
  items: z.array(QuoteOrderItemInSchema).default([]),
});
export type QuoteOrderCreate = z.infer<typeof QuoteOrderCreateSchema>;

/** 单头可改字段 + 状态流转（draft → sent → accepted/rejected/expired）。 */
export const QuoteOrderPatchSchema = TradeTermsSchema.extend({
  // 允许改客户：报价单挂错客户要能纠正。
  // 后端契约：客户必须存在、未删除、且属于本团队（否则 404 CUSTOMER_NOT_FOUND）；
  // 改客户时应同时回填 customer_name 快照（单据显示的是开单当时的客户名）。
  customer_id: z.string().nullable().optional(),
  customer_name: z.string().nullable().optional(),
  currency: z.string().optional(),
  valid_until: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  status: z
    .enum(['draft', 'sent', 'accepted', 'rejected', 'expired'])
    .optional(),
});
export type QuoteOrderPatch = z.infer<typeof QuoteOrderPatchSchema>;

/** 行项**整批替换**（工作台保存的语义：整单一次提交，不留半截脏行）。 */
export const QuoteOrderItemsReplaceSchema = z.object({
  items: z.array(QuoteOrderItemInSchema),
});
export type QuoteOrderItemsReplace = z.infer<
  typeof QuoteOrderItemsReplaceSchema
>;

export const QuoteOrderSchema = TradeTermsSchema.extend({
  id: z.number().int(),
  quote_no: z.string(),
  customer_id: z.string().nullable().default(null),
  customer_name: z.string().nullable().default(null),
  inquiry_id: z.number().int().nullable().default(null),
  status: z.string(),
  currency: z.string(),
  total_amount: z.number().nullable().default(null),
  valid_until: z.string().nullable().default(null),
  notes: z.string().nullable().default(null),
  fx_rate: z.number().nullable().default(null),
  fx_rate_date: z.string().nullable().default(null),
  created_at: z.string().nullable().default(null),
  /** 报价人（用户 id 字符串）：历史报价「谁给的报价」维度 */
  created_by: z.string().nullable().default(null),
  owner_id: z.string().nullable().default(null),
  owner_scope: z.string().default('private'),
  /** 行数（列表页展示"含 N 个产品"，避免为了看行数再拉详情） */
  item_count: z.number().int().default(0),
  /** 行项；列表接口不返回（避免 N+1），详情接口返回 */
  items: z.array(QuoteOrderItemSchema).optional(),
});
export type QuoteOrder = z.infer<typeof QuoteOrderSchema>;

export const QuoteOrderListSchema = z.object({
  items: z.array(QuoteOrderSchema),
  total: z.number().int(),
  page: z.number().int(),
  page_size: z.number().int(),
});
export type QuoteOrderList = z.infer<typeof QuoteOrderListSchema>;
