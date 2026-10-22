/**
 * KaaS TS 门面 · orders 域（21 条路由：订单 14 + 实际成本 3 + 出运 4）。
 *
 * 2026-10-22（设计 §13.3）：订单域新增 5 条 —— 实收登记 GET/POST
 * /orders/{id}/receipts、订单附件 GET/POST /orders/{id}/files、
 * 到账截图 POST /payment-receipts/{id}/files。
 * 2026-10-23（M2-B）：POST /orders 也改**透传内核**（来源三元组 / 金额构成 / 收款安排 /
 * 报价额度 / quotation.converted 事件全在内核），门面不再写第二份建单 SQL；
 * GET /orders 补 source_type / source_channel / inquiry_id 筛选（非法枚举 422）。
 *
 * 真源逐条对齐：
 * - backend/worker/src/main.py:3389-4152（订单列表/新建/详情/改单/状态机/付款计划/应收）
 * - backend/worker/src/ws_extras.py:262-327（实际采购成本 3 条）
 * - backend/worker/src/ws_shipments.py:171-368（自有出运台账 4 条）
 *
 * 业务判定一律走 rules.ts 镜像（kaas_common 的 can_view/can_write/状态机/编号规则），
 * 本文件只做鉴权 / 参数校验 / SQL 直译。TODO(TODO:TS3) 换 KERNEL 的 /internal/rules/*。
 */
import { Hono } from "hono";
import { z } from "zod";

import { withDb, type Db, type Tx } from "../db";
import { getEnv, type Env } from "../env";
import { httpError, num, num0, parseBody, parseQuery, pyIso, respond } from "../http";
import {
  RuleError,
  SHIPMENT_NEXT,
  buildNumber,
  canTransition,
  canView,
  canWrite,
  isAdminRole,
  validateEnum,
} from "../rules";
import { requireUser, type CurrentUser } from "../session";
import { forwardAuthenticatedKernelRequest } from "../proxy";
import { rowToReceipt } from "../serializers";
import {
  META_COLS,
  createFileFromBytes,
  rowToFile,
  teamScope,
} from "./files";
import {
  ws_extras_ActualCostIn,
  ws_extras_ActualCostResolveIn,
  ws_shipments_ShipmentCreate,
  ws_shipments_ShipmentPatch,
} from "../generated/schemas";

const app = new Hono<{ Bindings: Env }>();

const DEFAULT_TENANT = "default";

/** ws_shipments.py:67 _PATCH_TEXT_FIELDS / :71 _PATCH_DATE_FIELDS。 */
const SHIPMENT_PATCH_TEXT = [
  "consignee", "notify_party", "cargo_desc", "bl_no", "vessel",
  "voyage", "container_no", "so_no", "booking_no", "freight_remark",
] as const;
const SHIPMENT_PATCH_DATE = ["etd", "eta", "atd", "ata"] as const;

type Row = Record<string, unknown>;
/** 事务内外都能用的 SQL 句柄（postgres.js Sql 与 TransactionSql 的公共面）。 */
type Queryable = Db | Tx;

// ── 共享判定（main.py:3359-3391 的三件套；判定本身在 rules.ts）────────────────

function canSeeAll(user: CurrentUser): boolean {
  return isAdminRole(user.role);
}

/** main.py:3370 _owner_visible：三层可见性（管理员 / 显式共享 / 我的 / 本团队）。 */
function ownerVisible(user: CurrentUser, row: Row): boolean {
  return canView({
    role: user.role,
    ownerId: row.owner_id,
    ownerScope: (row.owner_scope as string | null) ?? null,
    teamId: row.team_id,
    viewerId: user.id,
    viewerTeamId: user.team_id,
  });
}

/** main.py:3383 _check_write_access：同团队可见 ≠ 同团队可改。 */
function checkWriteAccess(user: CurrentUser, row: Row): void {
  if (!canWrite({ role: user.role, ownerId: row.owner_id, viewerId: user.id })) {
    throw httpError(403, {
      error: "forbidden", code: "NOT_OWNER", detail: "只能修改自己账号的数据",
    });
  }
}

/** main.py:1288 _as_bigint：空 → null；非数字 → 422（不静默取 0）。 */
function asBigint(raw: unknown, field: string, code: string): number | null {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  if (!text) return null;
  if (!/^[0-9]+$/.test(text)) {
    throw httpError(422, {
      error: "validation", code, field, value: String(raw), detail: field + " 必须是整数 id",
    });
  }
  return Number(text);
}

/** validate_enum 的 HTTP 落点（enums.py:88-109 的 detail 逐字对齐）。 */
function validateEnumField(field: string, value: string | null | undefined): string {
  try {
    return validateEnum(field, value) as string;
  } catch (err) {
    if (err instanceof RuleError && err.code === "INVALID_ENUM") {
      const info = JSON.parse(err.detail) as { field: string; value: string; allowed: string[] };
      throw httpError(422, {
        error: "invalid_enum_value", code: "INVALID_ENUM",
        field: info.field, value: info.value, allowed: info.allowed,
      });
    }
    if (err instanceof RuleError) throw httpError(500, err.detail);
    throw err;
  }
}

/**
 * 订单来源枚举（**仅** GET /orders 的 ?source_type / ?source_channel 过滤校验用）。
 *
 * ⚠️ 数据镜像（不是手写规则）：真源 backend/kaas_common/domain/enums.py:33/48
 * （ORDER_SOURCE_TYPE / ORDER_CHANNEL；source_channel 与 inquiry_channel 同源）。
 * rules.ts:ENUMS 目前未收录这两个 key（本次写入范围只含本文件），
 * TODO(TODO:TS3)：随 /internal/rules/* 收敛后改为从内核字典取，删除本地表。
 */
const ORDER_SOURCE_TYPES = ["inquiry", "direct"] as const;
const ORDER_SOURCE_CHANNELS = [
  "email", "whatsapp", "alibaba", "expo", "website", "phone", "referral", "other",
] as const;

/**
 * 来源枚举的 HTTP 落点（422 信封与 validateEnumField 逐字一致：
 * {error:"invalid_enum_value", code:"INVALID_ENUM", field, value, allowed}）。
 */
function validateOrderSourceEnum(
  field: "order_source_type" | "source_channel",
  value: string,
  allowed: readonly string[],
): string {
  if (!allowed.includes(value)) {
    throw httpError(422, {
      error: "invalid_enum_value", code: "INVALID_ENUM",
      field, value, allowed: [...allowed],
    });
  }
  return value;
}

/** Decimal 到分（ROUND_HALF_UP）的近似；差异登记见 README「语义差异登记」。 */
function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** pricing_rules.py:79 parse_date：空 → null；非法 → null；合法 → UTC 零点。 */
function parseDate(value: unknown): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const text = String(value).slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) return null;
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(date.getTime()) ? null : date;
}

// ── 共享序列化（kaas_common/workstation/order_serializers.py 逐字段对齐）──────

function isoDate(value: unknown): unknown {
  return value instanceof Date ? pyIso(value) : value;
}

function asFloat(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return Number(value);
}

/** row_to_order：28 键（金额一律 float，时间一律 isoformat）。
 * 2026-10-22（迁移 202610220004）：补来源三元组 + 确认痕迹 7 键。 */
function rowToOrder(row: Row): Record<string, unknown> {
  return {
    id: num(row.id), order_no: row.order_no, customer_id: num(row.customer_id),
    customer_name: row.customer_name, status: row.status, currency: row.currency,
    total_amount: asFloat(row.total_amount),
    // 金额构成（迁移 202610220001）：历史订单为 null，前端回退 total_amount
    amount_breakdown: row.amount_breakdown ?? null,
    order_date: isoDate(row.order_date), delivery_date: isoDate(row.delivery_date),
    notes: row.notes,
    fx_rate: asFloat(row.fx_rate), fx_rate_date: isoDate(row.fx_rate_date),
    created_at: isoDate(row.created_at),
    owner_id: row.owner_id, owner_scope: row.owner_scope,
    incoterm: row.incoterm, payment_terms: row.payment_terms,
    port_of_loading: row.port_of_loading, port_of_destination: row.port_of_destination,
    shipping_marks: row.shipping_marks, country_of_origin: row.country_of_origin,
    // ── 来源三元组（迁移 202610220004，设计 §3.2）──────────────────────
    source_type: row.source_type ?? "direct",
    source_channel: row.source_channel ?? null,
    inquiry_id: num(row.inquiry_id) ?? null,
    quote_id: num(row.quote_id) ?? null,
    // 确认痕迹（设计 §5.1）
    confirmed_at: isoDate(row.confirmed_at),
    confirmed_by: row.confirmed_by ?? null,
    confirmed_source: row.confirmed_source ?? null,
  };
}

/** row_to_order_item：11 键（不返回 tenant_id/owner_id 等内部列）。 */
function rowToOrderItem(row: Row): Record<string, unknown> {
  return {
    id: num(row.id), sku_id: row.sku_id, product_name: row.product_name,
    spec_snapshot: row.spec_snapshot,
    qty: asFloat(row.qty), qty_unit: row.qty_unit,
    unit_price: asFloat(row.unit_price), currency: row.currency,
    line_amount: asFloat(row.line_amount), sort_order: num(row.sort_order),
  };
}

/** row_to_schedule：14 键。 */
function rowToSchedule(row: Row): Record<string, unknown> {
  return {
    id: num(row.id), order_id: num(row.order_id), trade_doc_id: num(row.trade_doc_id),
    schedule_type: row.schedule_type,
    ratio: asFloat(row.ratio), amount: asFloat(row.amount),
    currency: row.currency, due_date: isoDate(row.due_date),
    actual_date: isoDate(row.actual_date), status: row.status,
    fx_rate: asFloat(row.fx_rate),
    exchange_gain_loss: asFloat(row.exchange_gain_loss),
    notes: row.notes, created_at: isoDate(row.created_at),
  };
}

/** row_to_receivable：12 键。 */
function rowToReceivable(row: Row): Record<string, unknown> {
  return {
    id: num(row.id), order_id: num(row.order_id), currency: row.currency,
    total_amount: asFloat(row.total_amount),
    fx_rate: asFloat(row.fx_rate), fx_rate_date: isoDate(row.fx_rate_date),
    base_currency: row.base_currency, base_amount: asFloat(row.base_amount),
    received_amount: asFloat(row.received_amount),
    exchange_gain_loss: asFloat(row.exchange_gain_loss),
    status: row.status, created_at: isoDate(row.created_at),
  };
}

// ── 金额构成 / 收款计划 / 实收重算（设计 §13.3 · 2026-10-22）──────────────────

/** 按 schedule_id 汇总实收（未分配收款 schedule_id 为空，不计入任何期次）。 */
function receiptsBySchedule(receipts: Row[]): Map<number, number> {
  const totals = new Map<number, number>();
  for (const r of receipts) {
    if (r.schedule_id === null || r.schedule_id === undefined) continue;
    const sid = Number(r.schedule_id);
    totals.set(sid, (totals.get(sid) ?? 0) + Number(r.amount ?? 0));
  }
  return totals;
}

/** 收款计划行 + received_amount（历史 paid 且无 receipts 的期次按金额显示）。 */
function scheduleWithReceived(
  row: Row, bySchedule: Map<number, number>,
): Record<string, unknown> {
  const out = rowToSchedule(row);
  let received = bySchedule.get(Number(row.id)) ?? 0;
  if (received === 0 && row.status === "paid") received = Number(row.amount ?? 0);
  out.received_amount = round2(received);
  return out;
}

/**
 * 重算期次状态 + 应收台账（Python main._recompute_payment_state 直译）。
 * 0 < 已收 < 应收 ⇒ partial；已收 ≥ 应收 ⇒ paid；无 receipts 且历史 paid ⇒ 保持 paid。
 */
async function recomputePaymentState(sql: Queryable, orderId: number): Promise<void> {
  const schedules = await sql.unsafe(
    "SELECT id, amount, status FROM payment_schedules"
    + " WHERE tenant_id=$1 AND order_id=$2",
    [DEFAULT_TENANT, orderId] as never[],
  ) as unknown as Row[];
  const receipts = await sql.unsafe(
    "SELECT schedule_id, amount FROM payment_receipts"
    + " WHERE tenant_id=$1 AND order_id=$2",
    [DEFAULT_TENANT, orderId] as never[],
  ) as unknown as Row[];
  const per = new Map<number, number>();
  let receiptsTotal = 0;
  for (const r of receipts) {
    const amount = Number(r.amount ?? 0);
    receiptsTotal += amount;
    if (r.schedule_id !== null && r.schedule_id !== undefined) {
      const sid = Number(r.schedule_id);
      per.set(sid, (per.get(sid) ?? 0) + amount);
    }
  }
  let legacyPaidTotal = 0;
  for (const s of schedules) {
    const sid = Number(s.id);
    const expected = Number(s.amount ?? 0);
    const got = per.get(sid) ?? 0;
    let target: string;
    if (got > 0) {
      target = got >= expected - 0.005 ? "paid" : "partial";
    } else if (s.status === "paid") {
      legacyPaidTotal += expected;
      target = "paid";
    } else if (s.status === "overdue") {
      target = "overdue";
    } else {
      target = "pending";
    }
    if (target !== s.status) {
      await sql.unsafe(
        "UPDATE payment_schedules SET status=$3, updated_at=now()"
        + " WHERE tenant_id=$1 AND id=$2",
        [DEFAULT_TENANT, sid, target] as never[],
      );
    }
  }
  const received = round2(receiptsTotal + legacyPaidTotal);
  const recvRows = await sql.unsafe(
    "SELECT id, total_amount FROM receivables"
    + " WHERE tenant_id=$1 AND order_id=$2 LIMIT 1",
    [DEFAULT_TENANT, orderId] as never[],
  ) as unknown as Row[];
  const recv = recvRows[0];
  if (!recv) return;
  const total = Number(recv.total_amount ?? 0);
  const status = total > 0 && received >= total - 0.005
    ? "paid" : (received > 0 ? "partial" : "unpaid");
  await sql.unsafe(
    "UPDATE receivables SET received_amount=$3, status=$4, updated_at=now()"
    + " WHERE tenant_id=$1 AND id=$2",
    [DEFAULT_TENANT, recv.id, received, status] as never[],
  );
}

// ── 单据闸门（main.py:1259-1369 的三个助手）──────────────────────────────────

/** 订单存在 + 可见（实收/附件端点共用；不可见一律 404 order_not_found）。 */
async function orderOr404(sql: Queryable, orderId: number, user: CurrentUser): Promise<Row> {
  const rows = await sql.unsafe(
    "SELECT * FROM orders WHERE tenant_id=$1 AND id=$2",
    [DEFAULT_TENANT, orderId] as never[],
  ) as unknown as Row[];
  const row = rows[0];
  if (!row || !ownerVisible(user, row)) {
    throw httpError(404, { error: "order_not_found" });
  }
  return row;
}

/** main.py:3296 _next_customer_doc_no：类型-国家-客户-时间戳（同秒冲突加后缀）。 */
async function nextCustomerDocNo(
  sql: Queryable, docType: string, table: string, customer: Row | null, col = "doc_no",
): Promise<string> {
  const like = new Map(Object.entries(customer ?? {}));
  for (let suffix = 1; suffix <= 20; suffix += 1) {
    const candidate = buildNumber(docType, like, null, { suffix });
    const exists = await sql.unsafe(
      "SELECT 1 FROM " + table + " WHERE tenant_id=$1 AND " + col + "=$2 LIMIT 1",
      [DEFAULT_TENANT, candidate] as never[],
    );
    if ((exists as unknown as Row[]).length === 0) return candidate;
  }
  return buildNumber(docType, like) + "-X";
}

// ── 订单 ─────────────────────────────────────────────────────────────────────

// GET /api/v1/orders（main.py:3394 list_orders_api）
app.get("/api/v1/orders", (c) => respond(c, async () => {
  const user = await requireUser(c);
  const query = parseQuery(z.object({
    page: z.coerce.number().int().gte(1).default(1),
    page_size: z.coerce.number().int().gte(1).lte(200).default(20),
    status: z.string().default(""),
    customer_id: z.coerce.number().int().optional(),
    // 来源筛选（设计 §8，对齐 main.py:3727-3729 list_orders_api）：
    // ?source_type=inquiry 只看询盘转化单；?source_channel=phone 看某渠道来的单。
    source_type: z.string().default(""),
    source_channel: z.string().default(""),
    inquiry_id: z.coerce.number().int().optional(),
    q: z.string().default(""),
  }), c.req.query());
  const where: string[] = ["tenant_id = $1"];
  const params: unknown[] = [DEFAULT_TENANT];
  if (query.status) {
    // PARITY-QUOTE-7：非法状态先 422 INVALID_ENUM（不能静默返回空列表）
    validateEnumField("order_status", query.status);
    params.push(query.status);
    where.push("status = $" + String(params.length));
  }
  if (query.customer_id) {
    params.push(query.customer_id);
    where.push("customer_id = $" + String(params.length));
  }
  if (query.source_type) {
    // 与 status 同理：非法值先 422 INVALID_ENUM（不能静默返回空列表）
    validateOrderSourceEnum("order_source_type", query.source_type, ORDER_SOURCE_TYPES);
    params.push(query.source_type);
    where.push("source_type = $" + String(params.length));
  }
  if (query.source_channel) {
    validateOrderSourceEnum("source_channel", query.source_channel, ORDER_SOURCE_CHANNELS);
    params.push(query.source_channel);
    where.push("source_channel = $" + String(params.length));
  }
  if (query.inquiry_id) {
    params.push(query.inquiry_id);
    where.push("inquiry_id = $" + String(params.length));
  }
  if (query.q) {
    params.push("%" + query.q + "%");
    where.push("(customer_name ILIKE $" + String(params.length)
      + " OR order_no ILIKE $" + String(params.length) + ")");
  }
  if (!canSeeAll(user)) {
    params.push(String(user.id));
    let scopeCond = "(owner_id = $" + String(params.length) + " OR owner_scope = 'tenant'";
    if (user.team_id !== null && user.team_id !== undefined) {
      params.push(user.team_id);
      scopeCond += " OR team_id = $" + String(params.length);
    }
    where.push(scopeCond + ")");
  }
  const cond = where.join(" AND ");
  const payload = await withDb(getEnv(c), async (sql: Db) => {
    const totalRows = await sql.unsafe(
      "SELECT count(*) AS n FROM orders WHERE " + cond, params as never[],
    );
    const rows = await sql.unsafe(
      "SELECT * FROM orders WHERE " + cond + " ORDER BY created_at DESC, id DESC"
      + " LIMIT $" + String(params.length + 1) + " OFFSET $" + String(params.length + 2),
      [...params, query.page_size, (query.page - 1) * query.page_size] as never[],
    );
    return {
      total: num0((totalRows as unknown as Row[])[0]?.n),
      rows: rows as unknown as Row[],
    };
  });
  return c.json({
    items: payload.rows.map(rowToOrder),
    total: payload.total,
    page: query.page,
    page_size: query.page_size,
  });
}));

// POST /api/v1/orders（main.py:3868 create_order_api；手动新建 / 报价转订单）
// 2026-10-23（M2-B）：改为透传内核 —— 来源三元组判定（inquiry_id / source_type /
// source_channel）、金额构成 + 收款安排、报价额度校验、quotation.converted 事件全在内核；
// 门面旧 SQL 实现会把 body.inquiry_id/source_type/source_channel **静默丢弃**（落成 direct）。
// 透传实现统一走 src/proxy.ts:forwardAuthenticatedKernelRequest（与 PATCH/status 同一份）。
app.post("/api/v1/orders", (c) =>
  respond(c, async () => forwardAuthenticatedKernelRequest(c)));

// GET /api/v1/orders/{order_id}（main.py:3688；404 detail 是**字符串**）
app.get("/api/v1/orders/:order_id", (c) => respond(c, async () => {
  const user = await requireUser(c);
  const orderId = Number(c.req.param("order_id"));
  const payload = await withDb(getEnv(c), async (sql: Db) => {
    const rows = await sql.unsafe(
      "SELECT * FROM orders WHERE tenant_id = $1 AND id = $2",
      [DEFAULT_TENANT, orderId] as never[],
    );
    const row = (rows as unknown as Row[])[0];
    if (!row || !ownerVisible(user, row)) {
      throw httpError(404, "ORDER_NOT_FOUND");
    }
    const items = await sql.unsafe(
      "SELECT * FROM order_items WHERE tenant_id = $1 AND order_id = $2 ORDER BY sort_order, id",
      [DEFAULT_TENANT, orderId] as never[],
    ) as unknown as Row[];
    const quoteLinks = await sql.unsafe(
      "SELECT dst_id AS quote_order_id, rel_type FROM entity_links"
      + " WHERE tenant_id = $1 AND src_type = 'order' AND src_id = $2"
      + " AND dst_type = 'quote' AND deleted_at IS NULL ORDER BY id",
      [DEFAULT_TENANT, orderId] as never[],
    ) as unknown as Row[];
    const schedules = await sql.unsafe(
      "SELECT * FROM payment_schedules WHERE tenant_id = $1 AND order_id = $2"
      + " ORDER BY due_date NULLS LAST, id",
      [DEFAULT_TENANT, orderId] as never[],
    ) as unknown as Row[];
    const receivables = await sql.unsafe(
      "SELECT * FROM receivables WHERE tenant_id = $1 AND order_id = $2 LIMIT 1",
      [DEFAULT_TENANT, orderId] as never[],
    ) as unknown as Row[];
    // 实收登记（设计 §13.3）：详情直接带 receipts + 每期 received_amount
    const receipts = await sql.unsafe(
      "SELECT * FROM payment_receipts WHERE tenant_id = $1 AND order_id = $2"
      + " ORDER BY received_date, id",
      [DEFAULT_TENANT, orderId] as never[],
    ) as unknown as Row[];
    return { row, items, quoteLinks, schedules, receivables, receipts };
  });
  const received = receiptsBySchedule(payload.receipts);
  return c.json({
    ...rowToOrder(payload.row),
    items: payload.items.map(rowToOrderItem),
    quote_refs: payload.quoteLinks.map((link) => ({
      quote_order_id: num(link.quote_order_id), ref_type: link.rel_type,
    })),
    payment_schedules: payload.schedules.map((s) => scheduleWithReceived(s, received)),
    receipts: payload.receipts.map(rowToReceipt),
    receivable: payload.receivables.length > 0 ? rowToReceivable(payload.receivables[0]!) : null,
  });
}));

// PATCH /api/v1/orders/{order_id}（main.py:4270 update_order_api）
// 2026-10-22（M1-f）：改为透传内核 —— 内核已完整实现 items 整批替换 + 重算金额，
// 门面不再重复实现业务规则（设计 §10「业务规则只在 Python 内核一处实现」）。
// 透传实现统一走 src/proxy.ts:forwardAuthenticatedKernelRequest
// （门面鉴权 + 原样转发；禁止在门面重写业务规则——含 body 解析/重算）。
app.patch("/api/v1/orders/:order_id", (c) =>
  respond(c, async () => forwardAuthenticatedKernelRequest(c)));

// POST /api/v1/orders/{order_id}/status（main.py:4389 change_order_status；§10.4 状态机）
// 2026-10-22（M1-f）：改为透传内核 —— 内核已完整实现确认痕迹（confirmed_at/by/source）
// + TS6 询盘阶段联动；门面不再重复实现业务规则。
app.post("/api/v1/orders/:order_id/status", (c) =>
  respond(c, async () => forwardAuthenticatedKernelRequest(c)));

// ── 付款计划 / 应收（main.py:3936-4152）──────────────────────────────────────

// GET /api/v1/orders/{order_id}/payment-schedules（main.py:3946）
app.get("/api/v1/orders/:order_id/payment-schedules", (c) => respond(c, async () => {
  const user = await requireUser(c);
  const orderId = Number(c.req.param("order_id"));
  const rows = await withDb(getEnv(c), async (sql: Db) => {
    const orderRows = await sql.unsafe(
      "SELECT * FROM orders WHERE tenant_id=$1 AND id=$2",
      [DEFAULT_TENANT, orderId] as never[],
    );
    const order = (orderRows as unknown as Row[])[0];
    if (!order || !ownerVisible(user, order)) {
      throw httpError(404, { error: "order_not_found" });
    }
    return sql.unsafe(
      "SELECT * FROM payment_schedules WHERE tenant_id=$1 AND order_id=$2"
      + " ORDER BY due_date NULLS LAST, id",
      [DEFAULT_TENANT, orderId] as never[],
    ) as unknown as Row[];
  });
  const receipts = await withDb(getEnv(c), async (sql: Db) => (
    await sql.unsafe(
      "SELECT schedule_id, amount FROM payment_receipts"
      + " WHERE tenant_id=$1 AND order_id=$2",
      [DEFAULT_TENANT, orderId] as never[],
    )
  ) as unknown as Row[]);
  const bySchedule = receiptsBySchedule(receipts);
  return c.json({
    items: rows.map((s) => scheduleWithReceived(s, bySchedule)),
    total: rows.length,
  });
}));

// POST /api/v1/orders/{order_id}/payment-schedules（main.py:3964）
app.post("/api/v1/orders/:order_id/payment-schedules", (c) => respond(c, async () => {
  const user = await requireUser(c);
  const orderId = Number(c.req.param("order_id"));
  const body = await parseBody(c, z.record(z.unknown()));
  const row = await withDb(getEnv(c), async (sql: Db) => {
    const orderRows = await sql.unsafe(
      "SELECT * FROM orders WHERE tenant_id=$1 AND id=$2",
      [DEFAULT_TENANT, orderId] as never[],
    );
    const order = (orderRows as unknown as Row[])[0];
    if (!order || !ownerVisible(user, order)) {
      throw httpError(404, { error: "order_not_found" });
    }
    checkWriteAccess(user, order);
    const rawType = body.schedule_type;
    if (rawType === null || rawType === undefined || !String(rawType).trim()) {
      // PARITY-QUOTE-14：schedule_type 必填（原先默认 "full" 会凭空建出全额计划）
      throw httpError(422, {
        error: "validation", code: "SCHEDULE_TYPE_REQUIRED", field: "schedule_type",
        detail: "付款计划必须指定 schedule_type",
      });
    }
    const scheduleType = String(rawType).trim();
    if (!["deposit", "balance", "full"].includes(scheduleType)) {
      throw httpError(422, { error: "bad_schedule_type" });
    }
    const ratio = body.ratio ?? null;
    let amount = body.amount ?? null;
    if (amount === null && ratio !== null && order.total_amount !== null
      && order.total_amount !== undefined) {
      amount = round2(Number(order.total_amount) * Number(ratio));
    }
    const inserted = await sql.unsafe(
      "INSERT INTO payment_schedules (tenant_id, order_id, schedule_type, ratio,"
      + " amount, currency, due_date, notes, status, owner_id, owner_scope, team_id)"
      + " VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9,$10,$11) RETURNING *",
      [DEFAULT_TENANT, orderId, scheduleType, ratio, amount,
        order.currency ?? "USD", parseDate(body.due_date),
        body.notes ?? null, String(user.id), order.owner_scope ?? "private",
        order.team_id ?? null] as never[],
    );
    return (inserted as unknown as Row[])[0] as Row;
  });
  return c.json({ ...rowToSchedule(row), received_amount: 0 }, 201);
}));

// PATCH /api/v1/payment-schedules/{schedule_id}（main.py:4011）
app.patch("/api/v1/payment-schedules/:schedule_id", (c) => respond(c, async () => {
  const user = await requireUser(c);
  const scheduleId = Number(c.req.param("schedule_id"));
  const body = await parseBody(c, z.record(z.unknown()));
  const updated = await withDb(getEnv(c), async (sql: Db) => {
    const rows = await sql.unsafe(
      "SELECT * FROM payment_schedules WHERE tenant_id=$1 AND id=$2",
      [DEFAULT_TENANT, scheduleId] as never[],
    );
    let schedule = (rows as unknown as Row[])[0];
    if (!schedule) {
      throw httpError(404, { error: "schedule_not_found" });
    }
    const orderRows = await sql.unsafe(
      "SELECT owner_id, owner_scope, team_id FROM orders WHERE tenant_id=$1 AND id=$2",
      [DEFAULT_TENANT, schedule.order_id] as never[],
    );
    const orderRow = (orderRows as unknown as Row[])[0];
    if (orderRow && !ownerVisible(user, orderRow)) {
      throw httpError(404, { error: "schedule_not_found" });
    }
    if (orderRow) checkWriteAccess(user, orderRow);
    if (body.status !== null && body.status !== undefined) {
      // PARITY-QUOTE-17：非法 status 必须 422（原先既不报错也不落库）
      validateEnumField("schedule_status", String(body.status));
    }
    const projected = rowToSchedule(schedule);
    const newAmount = body.amount ?? null;
    if (newAmount !== null) projected.amount = newAmount;
    const newStatus = String(
      body.status === null || body.status === undefined ? projected.status : body.status,
    ).trim();
    if (projected.status === "paid" && newStatus !== "paid") {
      throw httpError(409, {
        error: "conflict", code: "ILLEGAL_TRANSITION", field: "status",
        from: "paid", to: newStatus,
      });
    }
    const now = new Date();
    if (newStatus === "paid" && projected.status !== "paid") {
      // 标记收款：按实际汇率与锁定汇率差记汇兑损益（缺汇率则后补，不记损益）
      const actualRate = body.fx_rate === null || body.fx_rate === undefined
        ? null : Number(body.fx_rate);
      const recvRows = await sql.unsafe(
        "SELECT fx_rate FROM receivables WHERE tenant_id=$1 AND order_id=$2",
        [DEFAULT_TENANT, schedule.order_id] as never[],
      );
      const orderFxRows = await sql.unsafe(
        "SELECT fx_rate FROM orders WHERE tenant_id=$1 AND id=$2",
        [DEFAULT_TENANT, schedule.order_id] as never[],
      );
      let lockRate: number | null = null;
      const recv = (recvRows as unknown as Row[])[0];
      if (recv && recv.fx_rate !== null && recv.fx_rate !== undefined) {
        lockRate = Number(recv.fx_rate);
      }
      const orderFx = (orderFxRows as unknown as Row[])[0];
      if (lockRate === null && orderFx && orderFx.fx_rate !== null
        && orderFx.fx_rate !== undefined) {
        lockRate = Number(orderFx.fx_rate);
      }
      const amount = Number(projected.amount ?? 0);
      const gl = actualRate !== null && lockRate !== null
        ? round2(amount * (actualRate - lockRate)) : null;
      const actualDate = parseDate(body.actual_date) ?? now;
      await sql.unsafe(
        "UPDATE payment_schedules SET status='paid', actual_date=$3, fx_rate=$4,"
        + " exchange_gain_loss=$5, updated_at=$6, amount=COALESCE($7, amount)"
        + " WHERE tenant_id=$1 AND id=$2",
        [DEFAULT_TENANT, scheduleId, actualDate, actualRate, gl, now,
          newAmount] as never[],
      );
      await sql.unsafe(
        "UPDATE receivables SET received_amount=received_amount+$3,"
        + " exchange_gain_loss=COALESCE(exchange_gain_loss,0)+$4,"
        + " status=CASE WHEN received_amount+$3>=total_amount THEN 'paid'"
        + " ELSE 'partial' END, updated_at=$5 WHERE tenant_id=$1 AND order_id=$2",
        [DEFAULT_TENANT, schedule.order_id, amount, gl ?? 0, now] as never[],
      );
    } else {
      // PARITY-QUOTE-16：非 paid 分支也要能改金额
      await sql.unsafe(
        "UPDATE payment_schedules SET amount=COALESCE($3, amount),"
        + " due_date=COALESCE($4, due_date), notes=COALESCE($5, notes),"
        + " updated_at=$6 WHERE tenant_id=$1 AND id=$2",
        [DEFAULT_TENANT, scheduleId, newAmount, parseDate(body.due_date),
          body.notes ?? null, now] as never[],
      );
    }
    const finalRows = await sql.unsafe(
      "SELECT * FROM payment_schedules WHERE tenant_id=$1 AND id=$2",
      [DEFAULT_TENANT, scheduleId] as never[],
    );
    schedule = (finalRows as unknown as Row[])[0] as Row;
    // 标记收款也走同一套重算（期次 + 应收台账口径只有一份）
    await recomputePaymentState(sql, Number(schedule.order_id));
    return schedule;
  });
  const receiptRows = await withDb(getEnv(c), async (sql: Db) => (
    await sql.unsafe(
      "SELECT * FROM payment_receipts WHERE tenant_id=$1 AND order_id=$2"
      + " ORDER BY received_date, id",
      [DEFAULT_TENANT, Number(updated.order_id)] as never[],
    )
  ) as unknown as Row[]);
  return c.json(scheduleWithReceived(updated, receiptsBySchedule(receiptRows)));
}));

// ── 实收登记（设计 §13.3 · 2026-10-22）──────────────────────────────────────
// 一次收款一行：允许同一期多次收款、允许 schedule_id 为空（未分配收款）、
// 允许金额与期次金额不同 —— 只记录事实并重算状态，绝不静默改收款计划金额。

// GET /api/v1/orders/{order_id}/receipts（main.py:list_order_receipts）
app.get("/api/v1/orders/:order_id/receipts", (c) => respond(c, async () => {
  const user = await requireUser(c);
  const orderId = Number(c.req.param("order_id"));
  const rows = await withDb(getEnv(c), async (sql: Db) => {
    await orderOr404(sql, orderId, user);
    return sql.unsafe(
      "SELECT * FROM payment_receipts WHERE tenant_id=$1 AND order_id=$2"
      + " ORDER BY received_date, id",
      [DEFAULT_TENANT, orderId] as never[],
    ) as unknown as Row[];
  });
  return c.json({ items: rows.map(rowToReceipt), total: rows.length });
}));

// POST /api/v1/orders/{order_id}/receipts（main.py:create_order_receipt）
app.post("/api/v1/orders/:order_id/receipts", (c) => respond(c, async () => {
  const user = await requireUser(c);
  const orderId = Number(c.req.param("order_id"));
  const body = await parseBody(c, z.record(z.unknown()));
  const amountRaw = body.amount;
  const amount = amountRaw === null || amountRaw === undefined || amountRaw === ""
    ? Number.NaN : Number(amountRaw);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw httpError(422, {
      error: "validation", code: "INVALID_RECEIPT_AMOUNT", field: "amount",
      detail: "实收金额必须是大于 0 的数字",
    });
  }
  const receivedDate = parseDate(body.received_date);
  if (receivedDate === null) {
    throw httpError(422, {
      error: "validation", code: "RECEIVED_DATE_REQUIRED", field: "received_date",
      detail: "收款日期必填（YYYY-MM-DD）",
    });
  }
  const rawSchedule = body.schedule_id;
  const scheduleId = rawSchedule === null || rawSchedule === undefined || rawSchedule === ""
    ? null : asBigint(rawSchedule, "schedule_id", "INVALID_SCHEDULE_ID");
  const receipt = await withDb(getEnv(c), (sql: Db) => sql.begin(async (tx) => {
    const order = await orderOr404(tx, orderId, user);
    checkWriteAccess(user, order);
    if (scheduleId !== null) {
      const belongs = await tx.unsafe(
        "SELECT 1 FROM payment_schedules"
        + " WHERE tenant_id=$1 AND id=$2 AND order_id=$3",
        [DEFAULT_TENANT, scheduleId, orderId] as never[],
      ) as unknown as Row[];
      if (belongs.length === 0) {
        throw httpError(422, {
          error: "validation", code: "SCHEDULE_NOT_IN_ORDER", field: "schedule_id",
          detail: "该收款期次不属于当前订单",
        });
      }
    }
    const inserted = await tx.unsafe(
      "INSERT INTO payment_receipts (tenant_id, order_id, schedule_id, amount,"
      + " currency, received_date, fx_rate, notes, created_by, owner_id,"
      + " owner_scope, team_id)"
      + " VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *",
      [DEFAULT_TENANT, orderId, scheduleId, amount,
        order.currency ?? "USD", receivedDate,
        body.fx_rate === null || body.fx_rate === undefined || body.fx_rate === ""
          ? null : Number(body.fx_rate),
        body.notes ?? null, String(user.id), order.owner_id,
        order.owner_scope ?? "private", order.team_id ?? null] as never[],
    );
    await recomputePaymentState(tx, orderId);
    return (inserted as unknown as Row[])[0] as Row;
  }));
  return c.json(rowToReceipt(receipt), 201);
}));

// ── 订单随单附件（合同/PO/信用证扫描件）+ 到账截图（multipart）───────────────
// 复用 files.ts 的服务端代理上传（团队隔离/校验/版本化都在 rules.ts 共享口径）。

/** multipart 里的文件字段（duck-typing：Workers 与 Node 测试环境的 File 不同 realm）。 */
function uploadedFileOf(value: unknown): File | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as { arrayBuffer?: unknown };
  if (typeof candidate.arrayBuffer !== "function") return null;
  return value as File;
}

// GET /api/v1/orders/{order_id}/files（ws_files.py:list_order_files）
app.get("/api/v1/orders/:order_id/files", (c) => respond(c, async () => {
  const user = await requireUser(c);
  const orderId = Number(c.req.param("order_id"));
  const params: unknown[] = [DEFAULT_TENANT, String(orderId)];
  let sqlText = "SELECT " + META_COLS + " FROM file_objects"
    + " WHERE tenant_id=$1 AND owner_type='order' AND owner_id=$2 AND is_current";
  const scope = teamScope(user, params.length + 1);
  sqlText += scope.frag;
  params.push(...scope.extra);
  sqlText += " ORDER BY is_primary DESC, sort_order, id";
  const rows = await withDb(getEnv(c), async (sql: Db) => {
    await orderOr404(sql, orderId, user);
    return sql.unsafe(sqlText, params as never[]) as unknown as Row[];
  });
  return c.json({ items: rows.map(rowToFile) });
}));

// POST /api/v1/orders/{order_id}/files（ws_files.py:upload_order_file）
app.post("/api/v1/orders/:order_id/files", (c) => respond(c, async () => {
  const user = await requireUser(c);
  const orderId = Number(c.req.param("order_id"));
  const form = await c.req.parseBody();
  const file = uploadedFileOf(form.file);
  if (file === null) {
    throw httpError(422, {
      error: "validation", code: "FILE_REQUIRED", detail: "缺少上传文件",
    });
  }
  const kindRaw = typeof form.kind === "string" && form.kind.trim()
    ? form.kind.trim() : "other";
  if (kindRaw !== "other") {
    throw httpError(422, {
      error: "validation", code: "BAD_FILE_KIND",
      detail: "订单附件只接受 kind=other（合同/PO/信用证扫描件）",
    });
  }
  const nameRaw = typeof form.name === "string" ? form.name.trim() : "";
  const name = nameRaw || file.name || "订单附件";
  await withDb(getEnv(c), async (sql: Db) => {
    const order = await orderOr404(sql, orderId, user);
    checkWriteAccess(user, order);
  });
  const bytes = new Uint8Array(await file.arrayBuffer());
  const row = await createFileFromBytes(getEnv(c), user, {
    ownerType: "order",
    ownerId: String(orderId),
    kind: "other",
    name,
    contentType: file.type || "application/octet-stream",
    fileName: file.name || null,
    bytes,
  });
  return c.json(row, 201);
}));

// POST /api/v1/payment-receipts/{receipt_id}/files（ws_files.py:upload_receipt_file）
app.post("/api/v1/payment-receipts/:receipt_id/files", (c) => respond(c, async () => {
  const user = await requireUser(c);
  const receiptId = Number(c.req.param("receipt_id"));
  const form = await c.req.parseBody();
  const file = uploadedFileOf(form.file);
  if (file === null) {
    throw httpError(422, {
      error: "validation", code: "FILE_REQUIRED", detail: "缺少上传文件",
    });
  }
  const nameRaw = typeof form.name === "string" ? form.name.trim() : "";
  const name = nameRaw || file.name || "到账截图";
  const receiptAndOrder = await withDb(getEnv(c), async (sql: Db) => {
    const rows = await sql.unsafe(
      "SELECT * FROM payment_receipts WHERE tenant_id=$1 AND id=$2",
      [DEFAULT_TENANT, receiptId] as never[],
    ) as unknown as Row[];
    const receipt = rows[0];
    if (!receipt) throw httpError(404, { error: "receipt_not_found" });
    const order = await orderOr404(sql, Number(receipt.order_id), user);
    checkWriteAccess(user, order);
    return { receipt };
  });
  const bytes = new Uint8Array(await file.arrayBuffer());
  const row = await createFileFromBytes(getEnv(c), user, {
    ownerType: "payment_receipt",
    ownerId: String(receiptAndOrder.receipt.id),
    kind: "other",
    name,
    contentType: file.type || "application/octet-stream",
    fileName: file.name || null,
    bytes,
  });
  await withDb(getEnv(c), (sql: Db) => sql.unsafe(
    "UPDATE payment_receipts SET file_id=$3 WHERE tenant_id=$1 AND id=$2",
    [DEFAULT_TENANT, receiptId, row.id] as never[],
  ));
  return c.json(row, 201);
}));

// GET /api/v1/receivables（main.py:4105）
app.get("/api/v1/receivables", (c) => respond(c, async () => {
  const user = await requireUser(c);
  const query = parseQuery(z.object({
    status: z.string().optional(),
    page: z.coerce.number().int().gte(1).default(1),
    page_size: z.coerce.number().int().gte(1).lte(200).default(20),
  }), c.req.query());
  let cond = "";
  const params: unknown[] = [DEFAULT_TENANT];
  if (query.status) {
    const status = query.status.trim();
    if (!["unpaid", "partial", "paid"].includes(status)) {
      throw httpError(422, { error: "bad_receivable_status" });
    }
    cond = " AND r.status=$2";
    params.push(status);
  }
  if (!canSeeAll(user)) {
    // Q21（安全）：非管理员必须按归属过滤（规则与 orchestrator scope_filter 同源）
    const parts: string[] = [];
    params.push(String(user.id));
    parts.push("r.owner_id = $" + String(params.length));
    if (user.team_id !== null && user.team_id !== undefined) {
      params.push(user.team_id);
      parts.push("r.team_id = $" + String(params.length));
    }
    cond += " AND (r.owner_scope = 'tenant' OR " + parts.join(" OR ") + ")";
  }
  const payload = await withDb(getEnv(c), async (sql: Db) => {
    const rows = await sql.unsafe(
      "SELECT r.*, o.order_no, o.customer_name FROM receivables r"
      + " LEFT JOIN orders o ON o.id=r.order_id AND o.tenant_id=r.tenant_id"
      + " WHERE r.tenant_id=$1" + cond + " ORDER BY r.id DESC"
      + " LIMIT $" + String(params.length + 1) + " OFFSET $" + String(params.length + 2),
      [...params, query.page_size, (query.page - 1) * query.page_size] as never[],
    );
    const totalRows = await sql.unsafe(
      "SELECT count(*) AS n FROM receivables r WHERE r.tenant_id=$1" + cond,
      params as never[],
    );
    return {
      rows: rows as unknown as Row[],
      total: num0((totalRows as unknown as Row[])[0]?.n),
    };
  });
  const items = payload.rows.map((row) => ({
    ...rowToReceivable(row),
    order_no: row.order_no ?? null,
    customer_name: row.customer_name ?? null,
  }));
  return c.json({
    items, total: payload.total, page: query.page, page_size: query.page_size,
  });
}));

// ── 实际采购成本（ws_extras.py:262-327）──────────────────────────────────────

// GET /api/v1/actual-costs（ws_extras.py:262；**裸数组**，不是 {items}）
app.get("/api/v1/actual-costs", (c) => respond(c, async () => {
  await requireUser(c);
  const query = parseQuery(z.object({
    product_key: z.string().optional(),
    limit: z.coerce.number().int().gte(1).lte(500).default(50),
  }), c.req.query());
  const rows = await withDb(getEnv(c), (sql: Db) => {
    if (query.product_key) {
      return sql.unsafe(
        "SELECT * FROM actual_procurement_costs WHERE product_key=$1"
        + " ORDER BY created_at DESC LIMIT $2",
        [query.product_key, query.limit] as never[],
      );
    }
    return sql.unsafe(
      "SELECT * FROM actual_procurement_costs ORDER BY created_at DESC LIMIT $1",
      [query.limit] as never[],
    );
  }) as unknown as Row[];
  return c.json(rows.map((row) => ({
    id: num(row.id),
    product_key: row.product_key,
    supplier_name: row.supplier_name,
    unit_cost_actual: row.unit_cost_actual === null || row.unit_cost_actual === undefined
      ? null : Number(row.unit_cost_actual),
    total_cost_actual: row.total_cost_actual === null || row.total_cost_actual === undefined
      ? null : Number(row.total_cost_actual),
    cost_basis: row.cost_basis,
    currency: row.currency,
    notes: row.notes,
    created_at: pyIso(row.created_at),
  })));
}));

// POST /api/v1/actual-costs（ws_extras.py:284）
app.post("/api/v1/actual-costs", (c) => respond(c, async () => {
  const user = await requireUser(c);
  const body = await parseBody(c, ws_extras_ActualCostIn);
  if ((body.unit_cost_actual === null || body.unit_cost_actual === undefined)
    && (body.total_cost_actual === null || body.total_cost_actual === undefined)) {
    throw httpError(422, {
      error: "missing_cost", message: "unit_cost_actual or total_cost_actual required",
    });
  }
  if (body.cost_basis !== "pretax" && body.cost_basis !== "incl_tax") {
    throw httpError(422, { error: "invalid_cost_basis" });
  }
  const row = await withDb(getEnv(c), async (sql: Db) => {
    const inserted = await sql.unsafe(
      "INSERT INTO actual_procurement_costs"
      + " (tenant_id, product_key, supplier_name, effective_from, effective_to,"
      + "  unit_cost_actual, total_cost_actual, qty_snapshot, qty_unit, cost_basis,"
      + "  input_vat_rate_snapshot, currency, notes, created_by)"
      + " VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *",
      [DEFAULT_TENANT, body.product_key, body.supplier_name ?? null,
        parseDate(body.effective_from), parseDate(body.effective_to),
        body.unit_cost_actual ?? null, body.total_cost_actual ?? null,
        body.qty_snapshot ?? null, body.qty_unit ?? null, body.cost_basis,
        body.input_vat_rate_snapshot ?? null, body.currency, body.notes ?? null,
        String(user.id)] as never[],
    );
    return (inserted as unknown as Row[])[0] as Row;
  });
  return c.json({ id: num(row.id), product_key: row.product_key }, 201);
}));

// POST /api/v1/actual-costs/resolve（ws_extras.py:311；纯计算，不触库）
app.post("/api/v1/actual-costs/resolve", (c) => respond(c, async () => {
  await requireUser(c);
  const body = await parseBody(c, ws_extras_ActualCostResolveIn);
  let unit = body.unit_cost_actual ?? null;
  let total = body.total_cost_actual ?? null;
  const qty = body.qty ?? null;
  if (unit === null && total !== null && qty !== null && qty > 0) {
    unit = total / qty;
  }
  if (total === null && unit !== null && qty !== null && qty > 0) {
    total = unit * qty;
  }
  let unitPretax = unit;
  if (body.cost_basis === "incl_tax" && unit !== null
    && body.input_vat_rate !== null && body.input_vat_rate !== undefined) {
    const rate = body.input_vat_rate;
    if (rate < 1) unitPretax = unit * (1 - rate);
  }
  return c.json({
    unit_cost_actual: unit,
    total_cost_actual: total,
    unit_cost_pretax: unitPretax,
  });
}));

// ── 自有出运台账（ws_shipments.py:171-368）──────────────────────────────────

/** ws_shipments.py:134 _row_to_shipment（字段与 orchestrator 逐条对齐）。 */
function rowToShipment(row: Row): Record<string, unknown> {
  return {
    id: num(row.id), shipment_no: row.shipment_no, order_id: num(row.order_id),
    customer_id: num(row.customer_id), customer_name: row.customer_name,
    consignee: row.consignee, notify_party: row.notify_party,
    cargo_desc: row.cargo_desc, cargo_qty: asFloat(row.cargo_qty),
    cargo_qty_unit: row.cargo_qty_unit, cargo_weight_kg: asFloat(row.cargo_weight_kg),
    cargo_volume_cbm: asFloat(row.cargo_volume_cbm),
    pol: row.pol, pod: row.pod, pol_name: row.pol_name, pod_name: row.pod_name,
    vessel: row.vessel, voyage: row.voyage, container_no: row.container_no,
    so_no: row.so_no, booking_no: row.booking_no, bl_no: row.bl_no,
    bl_type: row.bl_type,
    etd: isoDate(row.etd), eta: isoDate(row.eta),
    atd: isoDate(row.atd), ata: isoDate(row.ata),
    status: row.status, freight_remark: row.freight_remark,
    created_at: pyIso(row.created_at),
    owner_id: row.owner_id, owner_scope: row.owner_scope,
  };
}

/** ws_shipments.py:156 _get_or_404：不可见一律 404（不泄露存在性）。 */
async function shipmentOr404(sql: Queryable, shipmentId: number, user: CurrentUser): Promise<Row> {
  const rows = await sql.unsafe(
    "SELECT * FROM shipments WHERE tenant_id=$1 AND id=$2",
    [DEFAULT_TENANT, shipmentId] as never[],
  );
  const row = (rows as unknown as Row[])[0];
  if (!row || !ownerVisible(user, row)) {
    throw httpError(404, { error: "not_found", code: "SHIPMENT_NOT_FOUND" });
  }
  return row;
}

// GET /api/v1/shipments（ws_shipments.py:171）
app.get("/api/v1/shipments", (c) => respond(c, async () => {
  const user = await requireUser(c);
  const query = parseQuery(z.object({
    status: z.string().optional(),
    order_id: z.coerce.number().int().optional(),
    page: z.coerce.number().int().gte(1).default(1),
    page_size: z.coerce.number().int().gte(1).lte(200).default(20),
  }), c.req.query());
  const where: string[] = ["tenant_id = $1"];
  const params: unknown[] = [DEFAULT_TENANT];
  if (query.status) {
    validateEnumField("shipment_status", query.status);
    params.push(query.status);
    where.push("status = $" + String(params.length));
  }
  if (query.order_id) {
    params.push(query.order_id);
    where.push("order_id = $" + String(params.length));
  }
  if (!canSeeAll(user)) {
    params.push(String(user.id));
    let scopeCond = "(owner_id = $" + String(params.length) + " OR owner_scope = 'tenant'";
    if (user.team_id !== null && user.team_id !== undefined) {
      params.push(user.team_id);
      scopeCond += " OR team_id = $" + String(params.length);
    }
    where.push(scopeCond + ")");
  }
  const cond = where.join(" AND ");
  const payload = await withDb(getEnv(c), async (sql: Db) => {
    const totalRows = await sql.unsafe(
      "SELECT count(*) AS n FROM shipments WHERE " + cond, params as never[],
    );
    const rows = await sql.unsafe(
      "SELECT * FROM shipments WHERE " + cond
      + " ORDER BY created_at DESC, id DESC LIMIT $" + String(params.length + 1)
      + " OFFSET $" + String(params.length + 2),
      [...params, query.page_size, (query.page - 1) * query.page_size] as never[],
    );
    return {
      total: num0((totalRows as unknown as Row[])[0]?.n),
      rows: rows as unknown as Row[],
    };
  });
  return c.json({
    items: payload.rows.map(rowToShipment),
    total: payload.total, page: query.page, page_size: query.page_size,
  });
}));

// POST /api/v1/shipments（ws_shipments.py:213；带 order_id 时快照客户/货物 + 建关联 + 回写状态）
app.post("/api/v1/shipments", (c) => respond(c, async () => {
  const user = await requireUser(c);
  const body = await parseBody(c, ws_shipments_ShipmentCreate);
  const ownerScope = validateEnumField("owner_scope", body.owner_scope) || "private";
  const blType = body.bl_type ? validateEnumField("bl_type", body.bl_type) : null;
  const created = await withDb(getEnv(c), async (sql: Db) => {
    let customerName: string | null = null;
    let order: Row | null = null;
    let cargoDesc = body.cargo_desc ?? null;
    let cargoQty: unknown = body.cargo_qty ?? null;
    let cargoQtyUnit = body.cargo_qty_unit ?? null;
    if (body.order_id !== null && body.order_id !== undefined) {
      const orderRows = await sql.unsafe(
        "SELECT * FROM orders WHERE tenant_id=$1 AND id=$2",
        [DEFAULT_TENANT, body.order_id] as never[],
      );
      order = (orderRows as unknown as Row[])[0] ?? null;
      if (!order || !ownerVisible(user, order)) {
        throw httpError(404, { error: "not_found", code: "ORDER_NOT_FOUND" });
      }
      checkWriteAccess(user, order);
      customerName = (order.customer_name as string | null) ?? null;
      if (cargoDesc === null || cargoQty === null) {
        // 货物快照：从订单行项汇总（未手动覆盖时）
        const items = await sql.unsafe(
          "SELECT product_name, qty, qty_unit FROM order_items"
          + " WHERE tenant_id=$1 AND order_id=$2 ORDER BY sort_order, id",
          [DEFAULT_TENANT, order.id] as never[],
        ) as unknown as Row[];
        if (cargoDesc === null) {
          const names = items
            .map((item) => item.product_name)
            .filter((name): name is string => typeof name === "string" && name.length > 0);
          cargoDesc = names.length > 0 ? names.join(", ") : null;
        }
        if (cargoQty === null) {
          const sum = items.reduce((acc: number, item) =>
            acc + (item.qty === null || item.qty === undefined ? 0 : Number(item.qty)), 0);
          cargoQty = items.length > 0 ? sum : null;
          if (cargoQtyUnit === null && items.length > 0) {
            cargoQtyUnit = (items[0]!.qty_unit as string | null) ?? null;
          }
        }
      }
    }
    let customer: Row | null = null;
    let customerId = body.customer_id ?? null;
    if (order !== null && order.customer_id !== null && order.customer_id !== undefined) {
      customerId = customerId ?? num(order.customer_id);
    }
    if (customerId !== null) {
      const customerRows = await sql.unsafe(
        "SELECT * FROM customers WHERE tenant_id=$1 AND id=$2",
        [DEFAULT_TENANT, customerId] as never[],
      );
      customer = (customerRows as unknown as Row[])[0] ?? null;
    }
    const shipmentNo = await nextCustomerDocNo(
      sql, "shipment", "shipments", customer ?? {}, "shipment_no",
    );
    const row = await sql.begin(async (tx) => {
      const inserted = await tx.unsafe(
        "INSERT INTO shipments (tenant_id, shipment_no, order_id, customer_id,"
        + " customer_name, consignee, notify_party, cargo_desc, cargo_qty, cargo_qty_unit,"
        + " cargo_weight_kg, cargo_volume_cbm, pol, pod, pol_name, pod_name, vessel,"
        + " voyage, container_no, so_no, booking_no, bl_no, bl_type, etd, eta, atd, ata,"
        + " status, freight_remark, owner_id, owner_scope, team_id)"
        + " VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,"
        + " $19,$20,$21,$22,$23,$24,$25,$26,$27,'booking',$28,$29,$30,$31) RETURNING *",
        [DEFAULT_TENANT, shipmentNo, body.order_id ?? null, body.customer_id ?? null,
          customerName, body.consignee ?? null, body.notify_party ?? null, cargoDesc,
          cargoQty, cargoQtyUnit, body.cargo_weight_kg ?? null,
          body.cargo_volume_cbm ?? null, body.pol ?? null, body.pod ?? null,
          body.pol_name ?? null, body.pod_name ?? null, body.vessel ?? null,
          body.voyage ?? null, body.container_no ?? null, body.so_no ?? null,
          body.booking_no ?? null, body.bl_no ?? null, blType, parseDate(body.etd),
          parseDate(body.eta), parseDate(body.atd), parseDate(body.ata),
          body.freight_remark ?? null, String(user.id), ownerScope,
          user.team_id] as never[],
      );
      const shipment = (inserted as unknown as Row[])[0] as Row;
      if (order !== null) {
        // §10.6 回写：订单↔出运关联；producing → shipped
        await tx.unsafe(
          "INSERT INTO order_shipment_refs (tenant_id, order_id, shipment_id, ref_type)"
          + " VALUES ($1,$2,$3,'actual_shipment')",
          [DEFAULT_TENANT, order.id, shipment.id] as never[],
        );
        if (order.status === "producing") {
          await tx.unsafe(
            "UPDATE orders SET status='shipped', updated_at=now() WHERE tenant_id=$1 AND id=$2",
            [DEFAULT_TENANT, order.id] as never[],
          );
        }
        // TODO(TODO:TS6)：inquiry_stage.advance_for_order（询盘阶段联动）未镜像，登记见 README
      }
      return shipment;
    });
    return row;
  });
  return c.json(rowToShipment(created), 201);
}));

// GET /api/v1/shipments/{shipment_id}（ws_shipments.py:314）
app.get("/api/v1/shipments/:shipment_id", (c) => respond(c, async () => {
  const user = await requireUser(c);
  const shipmentId = Number(c.req.param("shipment_id"));
  const row = await withDb(getEnv(c), (sql: Db) => shipmentOr404(sql, shipmentId, user));
  return c.json(rowToShipment(row));
}));

// PATCH /api/v1/shipments/{shipment_id}（ws_shipments.py:323）
app.patch("/api/v1/shipments/:shipment_id", (c) => respond(c, async () => {
  const user = await requireUser(c);
  const shipmentId = Number(c.req.param("shipment_id"));
  const body = await parseBody(c, ws_shipments_ShipmentPatch);
  const updated = await withDb(getEnv(c), async (sql: Db) => {
    const shipment = await shipmentOr404(sql, shipmentId, user);
    checkWriteAccess(user, shipment);
    const sets: string[] = [];
    const params: unknown[] = [DEFAULT_TENANT, shipmentId];
    for (const field of SHIPMENT_PATCH_TEXT) {
      const value = body[field];
      if (value !== null && value !== undefined) {
        params.push(value);
        sets.push(field + " = $" + String(params.length));
      }
    }
    for (const field of SHIPMENT_PATCH_DATE) {
      const value = body[field];
      if (value !== null && value !== undefined) {
        params.push(parseDate(value));
        sets.push(field + " = $" + String(params.length));
      }
    }
    if (body.bl_type !== null && body.bl_type !== undefined) {
      params.push(validateEnumField("bl_type", body.bl_type));
      sets.push("bl_type = $" + String(params.length));
    }
    if (body.status !== null && body.status !== undefined) {
      const target = validateEnumField("shipment_status", body.status);
      if (!canTransition("shipment", String(shipment.status ?? ""), target)) {
        throw httpError(409, {
          error: "conflict", code: "ILLEGAL_TRANSITION", field: "status",
          from: shipment.status, to: target,
          allowed: [...(SHIPMENT_NEXT[String(shipment.status ?? "")] ?? [])],
        });
      }
      params.push(target);
      sets.push("status = $" + String(params.length));
    }
    sets.push("updated_at = now()");
    const rows = await sql.unsafe(
      "UPDATE shipments SET " + sets.join(", ")
      + " WHERE tenant_id=$1 AND id=$2 RETURNING *",
      params as never[],
    );
    return (rows as unknown as Row[])[0] as Row;
  });
  return c.json(rowToShipment(updated));
}));

export default app;
