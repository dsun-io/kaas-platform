/**
 * KaaS TS 门面 · customers 域（20 条路由）。
 *
 * 真源逐条对齐：
 * - backend/worker/src/main.py:1137-1708（列表/新建/详情/联系人/软删/询盘/阶段）
 * - backend/worker/src/ws_crm_ext.py（档案更新/询盘总表/询盘流转/阶段日志）
 * - backend/worker/src/ws_customer_records.py（往来记录树）
 * - backend/worker/src/main.py:3080-3222（capabilities 5 条）
 *
 * 可见性/写权限/枚举/编号规则判定在 rules.ts（kaas_common 镜像，TODO(TODO:TS3) 换 KERNEL）。
 */
import { Hono, type Context } from "hono";
import type postgres from "postgres";
import { z } from "zod";

import { DIRECT_ROUTE_IDS, useDirectRoute } from "../boot-flag";
import { withDb, type Db, type Tx } from "../db";
import { getEnv, type Env } from "../env";
import { directDb } from "../hot-read";
import { httpError, num, num0, parseBody, parseQuery, pyIso, respond } from "../http";
import { forwardAuthenticatedKernelRequest } from "../proxy";
import {
  buildRecords,
  buildNumber,
  canView,
  canWrite,
  customerStageSql,
  isAdminRole,
  normalizeAbbr,
  NumberRuleError,
  validateManualStage,
} from "../rules";
import {
  capabilityRow,
  contactApi,
  customerApi,
  inquiryStageLogApi,
  normalizeInquiryItems,
  rowToCustomer,
  rowToInquiry,
  stageLogApi,
} from "../serializers";
import { requireUser, type CurrentUser } from "../session";
import { rowToOrder } from "./orders";

const app = new Hono<{ Bindings: Env }>();

// 入参 schema 当前手写（TODO(TODO:TS1)：待 pydantic→zod 生成器覆盖本域后替换）。

const DEFAULT_TENANT = "default";

/** 行别名（与 orders.ts / products.ts 同风格；只按列名读取）。 */
type Row = Record<string, unknown>;

// ── 业务枚举（kaas_common/domain/enums.py:ENUMS 的镜像子集；TODO(TODO:TS3) 换 KERNEL 字典端点）──
const ENUMS: Record<string, readonly string[]> = {
  inquiry_status: ["unquoted", "quoted", "closed"],
  customer_stage: ["active", "inactive", "ordered"],
  inquiry_channel: ["email", "whatsapp", "alibaba", "expo", "website", "phone", "referral", "other"],
  owner_scope: ["private", "tenant"],
};

/** validate_enum 逐字对齐（enums.py:88-109；None 原样返回）。 */
function validateEnum(field: string, value: string | null | undefined): string | null | undefined {
  if (value === null || value === undefined) return value;
  const allowed = ENUMS[field];
  if (!allowed) {
    throw httpError(500, `unknown enum field: ${field}`);
  }
  if (!allowed.includes(value)) {
    throw httpError(422, {
      error: "invalid_enum_value", code: "INVALID_ENUM",
      field, value, allowed: [...allowed],
    });
  }
  return value;
}

// ── 归属/可见性（main.py:_can_see_all / _owner_visible / _check_write_access）─────

function canSeeAll(user: CurrentUser): boolean {
  return isAdminRole(user.role);
}

function ownerVisible(user: CurrentUser, row: Record<string, unknown>): boolean {
  return canView({
    role: user.role,
    ownerId: row.owner_id,
    ownerScope: row.owner_scope as string | null,
    teamId: row.team_id,
    viewerId: user.id,
    viewerTeamId: user.team_id,
  });
}

function checkWriteAccess(user: CurrentUser, row: Record<string, unknown>): void {
  if (!canWrite({ role: user.role, ownerId: row.owner_id, viewerId: user.id })) {
    throw httpError(403, {
      error: "forbidden", code: "NOT_OWNER", detail: "只能修改自己账号的数据",
    });
  }
}

/** main.py:_customer_or_404（未删除 + 三层可见性；不可见一律 404 不泄露存在性）。 */
async function customerOr404(
  sql: Db,
  customerId: number,
  user: CurrentUser,
): Promise<Record<string, unknown>> {
  const rows = await sql.unsafe(
    `SELECT c.*, c.name AS company_name, ${customerStageSql("c")} AS stage_display`
    + " FROM customers c WHERE c.id=$1 AND c.tenant_id=$2 AND c.is_deleted = false",
    [customerId, DEFAULT_TENANT],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row || !ownerVisible(user, row)) {
    throw httpError(404, { error: "not_found", code: "CUSTOMER_NOT_FOUND" });
  }
  return row;
}

/** main.py:_norm_abbr（空 → null；非空不合法 → 422）。 */
function normAbbr(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined || String(raw).trim() === "") return null;
  const value = normalizeAbbr(raw);
  if (value === null) {
    throw httpError(422, {
      error: "validation", code: "INVALID_CUSTOMER_ABBR",
      detail: "客户缩写需为 2-6 位字母/数字（用于询盘编号）",
    });
  }
  return value;
}

const idParam = z.object({ customer_id: z.coerce.number().int() });
const contactParam = z.object({
  customer_id: z.coerce.number().int(),
  contact_id: z.coerce.number().int(),
});

// ── GET /api/v1/customers（main.py:1372-1430）────────────────────────────────
const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(200).default(20),
  stage: z.string().nullish(),
  q: z.string().nullish(),
});

app.get("/api/v1/customers", (c) => respond(c, async () => {
  const user = await requireUser(c);
  const query = parseQuery(listQuery, c.req.queries() as Record<string, string | string[] | undefined>);
  const page = query.page ?? 1;
  const pageSize = query.page_size ?? 20;
  const stage = query.stage ?? null;
  const q = query.q ?? null;

  const where: string[] = ["c.tenant_id = $1", "c.is_deleted = false"];
  const params: unknown[] = [DEFAULT_TENANT];
  if (stage) {
    // stage 是展示值：ordered 由订单推导，active/inactive 是手动列
    validateEnum("customer_stage", stage);
    const hasOpen = ("EXISTS (SELECT 1 FROM orders o"
      + " WHERE o.tenant_id = c.tenant_id AND o.customer_id = c.id"
      + " AND o.status IN ('pending','confirmed','producing','shipped'))");
    if (stage === "ordered") {
      where.push(hasOpen);
    } else if (stage === "inactive") {
      where.push(`NOT ${hasOpen} AND c.stage IN ('inactive','lost')`);
    } else {
      where.push(`NOT ${hasOpen} AND c.stage NOT IN ('inactive','lost')`);
    }
  }
  if (q) {
    params.push(`%${q}%`);
    where.push(`c.name ILIKE ${"$" + params.length}`);
  }
  // §10.3：谁创建的客户，就在其团队可见；管理员全可见
  if (!canSeeAll(user)) {
    params.push(String(user.id));
    let scopeCond = `(c.owner_id = ${"$" + params.length} OR c.owner_scope = 'tenant'`;
    if (user.team_id !== null) {
      params.push(user.team_id);
      scopeCond += ` OR c.team_id = ${"$" + params.length}`;
    }
    where.push(scopeCond + ")");
  }
  const whereSql = where.join(" AND ");

  const result = await withDb(getEnv(c), async (sql: Db) => {
    const totalRows = await sql.unsafe(
      `SELECT COUNT(*) FROM customers c WHERE ${whereSql}`, params);
    const rows = await sql.unsafe(
      `SELECT c.*, c.name AS company_name, ${customerStageSql("c")} AS stage_display`
      + ` FROM customers c WHERE ${whereSql}`
      + ` ORDER BY c.updated_at DESC LIMIT ${"$" + (params.length + 1)} OFFSET ${"$" + (params.length + 2)}`,
      [...params, pageSize, (page - 1) * pageSize],
    );
    return {
      items: (rows as Record<string, unknown>[]).map(customerApi),
      total: num0(totalRows[0]?.count),
      page,
      page_size: pageSize,
    };
  });
  return c.json(result);
}));

// ── POST /api/v1/customers（main.py:1433-1493，201）──────────────────────────
const customerCreateSchema = z.object({
  company_name: z.string().nullish(),
  contact_name: z.string().nullish(),
  contact_phone: z.string().nullish(),
  contact_email: z.string().nullish(),
  abbr: z.string().nullish(),
  country: z.string().nullish(),
  address: z.string().nullish(),
  default_port: z.string().nullish(),
  credit_level: z.string().nullish(),
  stage: z.string().nullish(),
  notes: z.string().nullish(),
  owner_scope: z.string().nullish(),
});

app.post("/api/v1/customers", (c) => respond(c, async () => {
  const env = getEnv(c);
  const user = await requireUser(c);
  const body = await parseBody(c, customerCreateSchema);

  const companyName = (body.company_name ?? "").trim();
  const contactName = (body.contact_name ?? "").trim();
  if (!companyName && !contactName) {
    throw httpError(422, {
      error: "missing_identity", code: "CUSTOMER_IDENTITY_REQUIRED",
      detail: "公司名称和联系人至少填写一个",
    });
  }
  const stage = body.stage || "active";
  const check = validateManualStage(stage);
  if (!check.ok) {
    throw httpError(422, { error: "invalid_enum", code: "INVALID_CUSTOMER_STAGE", detail: check.msg });
  }
  const ownerScope = validateEnum("owner_scope", body.owner_scope) ?? "private";

  const row = await withDb(env, async (sql: Db) => {
    return sql.begin(async (tx: Tx) => {
      const inserted = await tx`
        INSERT INTO customers
               (tenant_id, name, abbr, plan, status, country, address, default_port,
                credit_level, stage, notes, created_by, owner_id, owner_scope, team_id)
        VALUES (${DEFAULT_TENANT}, ${companyName || contactName}, ${normAbbr(body.abbr)},
                'free', 'active', ${body.country}, ${body.address}, ${body.default_port},
                ${body.credit_level}, ${stage}, ${body.notes}, ${String(user.id)},
                ${String(user.id)}, ${ownerScope}, ${user.team_id})
        RETURNING *, name AS company_name`;
      const customer = inserted[0] as Record<string, unknown>;
      if (contactName) {
        await tx`
          INSERT INTO cust_contacts
                 (tenant_id, customer_id, name, phone, email, is_primary)
          VALUES (${DEFAULT_TENANT}, ${num(customer.id)}, ${contactName},
                  ${(body.contact_phone ?? "").trim() || null},
                  ${(body.contact_email ?? "").trim() || null}, true)`;
      }
      // PARITY-CRM-5：新建客户落一条阶段日志
      await tx`
        INSERT INTO cust_stage_log
               (tenant_id, customer_id, from_stage, to_stage, changed_by, reason)
        VALUES (${DEFAULT_TENANT}, ${num(customer.id)}, ${null}, ${stage},
                ${String(user.id)}, '新建客户')`;
      return customer;
    });
  });
  return c.json(customerApi(row), 201);
}));

// ── GET /api/v1/customers/{customer_id}（main.py:1506-1534）──────────────────
app.get("/api/v1/customers/:customer_id", (c) => respond(c, async () => {
  const user = await requireUser(c);
  const { customer_id: customerId } = parseQuery(idParam, c.req.param(), "path");
  const payload = await withDb(getEnv(c), async (sql: Db) => {
    const customer = await customerOr404(sql, customerId, user);
    const contacts = await sql`
      SELECT * FROM cust_contacts WHERE customer_id=${customerId}
      ORDER BY is_primary DESC, created_at`;
    const inquiries = await sql`
      SELECT * FROM cust_inquiries WHERE customer_id=${customerId}
      ORDER BY created_at DESC`;
    const stageLog = await sql`
      SELECT * FROM cust_stage_log WHERE customer_id=${customerId}
      ORDER BY created_at DESC LIMIT 50`;
    // PARITY-CRM-23：每项多一个 inquiry_no_editable（有意保留差异）
    const inquiryItems: Record<string, unknown>[] = [];
    for (const i of inquiries as Record<string, unknown>[]) {
      const hasQuote = await sql`
        SELECT 1 FROM quote_orders WHERE tenant_id=${DEFAULT_TENANT}
        AND inquiry_id=${num(i.id)} LIMIT 1`;
      inquiryItems.push({ ...rowToInquiry(i), inquiry_no_editable: hasQuote.length === 0 });
    }
    return {
      ...customerApi(customer),
      contacts: (contacts as Record<string, unknown>[]).map(contactApi),
      inquiries: inquiryItems,
      stage_log: (stageLog as Record<string, unknown>[]).map(stageLogApi),
    };
  });
  return c.json(payload);
}));

// ── POST /api/v1/customers/{customer_id}/contacts（main.py:1537-1556，201）────
const contactCreateSchema = z.object({
  customer_id: z.number().int().nullish(),
  name: z.string(),
  position: z.string().nullish(),
  phone: z.string().nullish(),
  email: z.string().nullish(),
  whatsapp: z.string().nullish(),
  wechat: z.string().nullish(),
  is_primary: z.boolean().default(false),
});

app.post("/api/v1/customers/:customer_id/contacts", (c) => respond(c, async () => {
  const user = await requireUser(c);
  const { customer_id: customerId } = parseQuery(idParam, c.req.param(), "path");
  const body = await parseBody(c, contactCreateSchema);
  const row = await withDb(getEnv(c), async (sql: Db) => {
    const customer = await customerOr404(sql, customerId, user);
    checkWriteAccess(user, customer);
    if (body.is_primary) {
      // CRM-12：设为默认联系人时先清掉其它
      await sql`
        UPDATE cust_contacts SET is_primary=false
         WHERE customer_id=${customerId} AND tenant_id=${DEFAULT_TENANT}`;
    }
    const inserted = await sql`
      INSERT INTO cust_contacts
             (tenant_id, customer_id, name, position, phone, email, whatsapp, wechat, is_primary)
      VALUES (${DEFAULT_TENANT}, ${customerId}, ${body.name}, ${body.position}, ${body.phone},
              ${body.email}, ${body.whatsapp}, ${body.wechat}, ${body.is_primary})
      RETURNING *`;
    return inserted[0] as Record<string, unknown>;
  });
  // PARITY-CRM-11：响应是 7 键投影
  return c.json(contactApi(row), 201);
}));

// ── PATCH /api/v1/customers/{customer_id}/contacts/{contact_id}（main.py:1569-1598）──
const contactUpdateSchema = z.object({
  name: z.string().nullish(),
  position: z.string().nullish(),
  phone: z.string().nullish(),
  email: z.string().nullish(),
  whatsapp: z.string().nullish(),
  wechat: z.string().nullish(),
  is_primary: z.boolean().nullish(),
});

app.patch("/api/v1/customers/:customer_id/contacts/:contact_id", (c) => respond(c, async () => {
  const user = await requireUser(c);
  const { customer_id: customerId, contact_id: contactId } = parseQuery(contactParam, c.req.param(), "path");
  const rawBody = await c.req.json().catch(() => httpErrorThrow422());
  const body = await parseBody(c, contactUpdateSchema);
  const row = await withDb(getEnv(c), async (sql: Db) => {
    const customer = await customerOr404(sql, customerId, user);
    checkWriteAccess(user, customer);
    const found = await sql`
      SELECT * FROM cust_contacts WHERE id=${contactId} AND customer_id=${customerId}
      AND tenant_id=${DEFAULT_TENANT}`;
    const existing = found[0] as Record<string, unknown> | undefined;
    if (!existing) {
      throw httpError(404, { error: "not_found", code: "CONTACT_NOT_FOUND" });
    }
    // 显式出现的字段才更新（CRM-14：显式 null 必须能清空字段）
    const data: Record<string, unknown> = {};
    for (const key of ["name", "position", "phone", "email", "whatsapp", "wechat", "is_primary"]) {
      if (rawBody !== null && typeof rawBody === "object" && key in (rawBody as Record<string, unknown>)) {
        data[key] = (rawBody as Record<string, unknown>)[key];
      }
    }
    if (Object.keys(data).length === 0) {
      return existing;
    }
    if (data.is_primary === true) {
      await sql`
        UPDATE cust_contacts SET is_primary=false
         WHERE customer_id=${customerId} AND tenant_id=${DEFAULT_TENANT} AND id != ${contactId}`;
    }
    // 列名只来自字段白名单，不拼用户输入
    const cols = Object.keys(data);
    const setSql = cols.map((col, idx) => `${col}=${"$" + (idx + 2)}`).join(", ");
    const updated = await sql.unsafe(
      `UPDATE cust_contacts SET ${setSql} WHERE id=$1 RETURNING *`,
      [contactId, ...cols.map((col) => data[col])],
    );
    return updated[0] as Record<string, unknown>;
  });
  return c.json(contactApi(row));
}));

function httpErrorThrow422(): never {
  throw httpError(422, [
    { type: "json_invalid", loc: ["body"], msg: "Invalid JSON", input: null },
  ]);
}

// ── DELETE /api/v1/customers/{customer_id}/contacts/{contact_id}（main.py:1601-1616，204）──
app.delete("/api/v1/customers/:customer_id/contacts/:contact_id", (c) => respond(c, async () => {
  const user = await requireUser(c);
  const { customer_id: customerId, contact_id: contactId } = parseQuery(contactParam, c.req.param(), "path");
  await withDb(getEnv(c), async (sql: Db) => {
    const customer = await customerOr404(sql, customerId, user);
    checkWriteAccess(user, customer);
    const found = await sql`
      SELECT 1 FROM cust_contacts WHERE id=${contactId} AND customer_id=${customerId}
      AND tenant_id=${DEFAULT_TENANT}`;
    if (found.length === 0) {
      throw httpError(404, { error: "not_found", code: "CONTACT_NOT_FOUND" });
    }
    await sql`
      DELETE FROM cust_contacts WHERE id=${contactId} AND customer_id=${customerId}
      AND tenant_id=${DEFAULT_TENANT}`;
  });
  return c.body(null, 204);
}));

// ── DELETE /api/v1/customers/{customer_id}（main.py:1619-1647，204）───────────
app.delete("/api/v1/customers/:customer_id", (c) => respond(c, async () => {
  const user = await requireUser(c);
  const { customer_id: customerId } = parseQuery(idParam, c.req.param(), "path");
  await withDb(getEnv(c), async (sql: Db) => {
    const customer = await customerOr404(sql, customerId, user);
    checkWriteAccess(user, customer);
    const openOrders = await sql`
      SELECT id, order_no, status FROM orders
      WHERE tenant_id=${DEFAULT_TENANT} AND customer_id=${customerId}
      AND status IN ('pending','confirmed','producing','shipped') ORDER BY id`;
    if (openOrders.length > 0) {
      throw httpError(409, {
        error: "conflict", code: "OPEN_ORDERS_EXIST",
        detail: `客户名下有 ${openOrders.length} 张开启中的订单，请先关闭订单再删除`,
        open_orders: (openOrders as Record<string, unknown>[]).map((o) => ({
          id: num(o.id), order_no: o.order_no, status: o.status,
        })),
      });
    }
    await sql`
      UPDATE customers SET is_deleted=true, deleted_at=now()
      WHERE id=${customerId} AND tenant_id=${DEFAULT_TENANT}`;
  });
  return c.body(null, 204);
}));

// ── POST /api/v1/customers/{customer_id}/inquiries（main.py:1650-1676，201）───
const inquiryCreateSchema = z.object({
  customer_id: z.number().int().nullish(),
  channel: z.string().nullish(),
  lead_id: z.number().int().nullish(),
  owner_scope: z.string().nullish(),
  category_id: z.number().int().nullish(),
  product_name_raw: z.string().nullish(),
  quantity: z.coerce.number().nullish(),
  quantity_unit: z.string().nullish(),
  application: z.string().nullish(),
  // 多产品行（设计 §5）：一个询盘可录多个产品；第一行同步写上面四个旧字段。
  items: z.array(z.record(z.unknown())).optional(),
  status: z.string().default("unquoted"),
  notes: z.string().nullish(),
});

/** main.py:_next_inquiry_no（build_number 同秒冲突加后缀，20 次后兜底 -X）。 */
async function nextInquiryNo(sql: postgres.Sql, customer: Record<string, unknown>): Promise<string> {
  const like = {
    get: (key: string): unknown => (key === "company_name" ? customer.name : customer[key]),
  };
  for (let suffix = 1; suffix <= 20; suffix++) {
    const candidate = buildNumber("inquiry", like, null, { suffix });
    const exists = await sql`
      SELECT 1 FROM cust_inquiries WHERE tenant_id=${DEFAULT_TENANT}
      AND inquiry_no=${candidate} LIMIT 1`;
    if (exists.length === 0) return candidate;
  }
  return `${buildNumber("inquiry", like)}-X`;
}

app.post("/api/v1/customers/:customer_id/inquiries", (c) => respond(c, async () => {
  const user = await requireUser(c);
  const { customer_id: customerId } = parseQuery(idParam, c.req.param(), "path");
  const body = await parseBody(c, inquiryCreateSchema);
  const row = await withDb(getEnv(c), async (sql: Db) => {
    const customer = await customerOr404(sql, customerId, user);
    checkWriteAccess(user, customer);
    // channel / owner_scope 走共享枚举校验；新建询盘状态恒为 unquoted（CRM-20）
    const channel = validateEnum("inquiry_channel", body.channel);
    const ownerScope = validateEnum("owner_scope", body.owner_scope) ?? "private";
    const inquiryNo = await nextInquiryNo(sql, customer);
    // 多产品行（设计 §5）：items 是权威来源，**第一行同步写旧标量字段**
    // （旧报表/链式分析读 product_name_raw/quantity，不能只写 items）。
    const items = normalizeInquiryItems(body.items ?? []);
    const first = items[0];
    const productNameRaw = body.product_name_raw || first?.product_name_raw || null;
    const quantity = body.quantity !== null && body.quantity !== undefined
      ? body.quantity
      : (first?.quantity ?? null);
    const quantityUnit = body.quantity_unit || first?.quantity_unit || null;
    const application = body.application || first?.application || null;
    const inserted = await sql`
      INSERT INTO cust_inquiries
             (tenant_id, customer_id, inquiry_no, channel, lead_id, category_id,
              product_name_raw, quantity, quantity_unit, application, status, notes,
              created_by, owner_id, owner_scope, team_id, items)
      VALUES (${DEFAULT_TENANT}, ${customerId}, ${inquiryNo}, ${channel}, ${body.lead_id},
              ${body.category_id}, ${productNameRaw}, ${quantity},
              ${quantityUnit}, ${application}, 'unquoted', ${body.notes},
              ${String(user.id)}, ${String(user.id)}, ${ownerScope}, ${user.team_id},
              ${JSON.stringify(items)}::jsonb)
      RETURNING *`;
    return inserted[0] as Record<string, unknown>;
  });
  // PARITY-CRM-22：响应走共享 row_to_inquiry 投影
  return c.json(rowToInquiry(row), 201);
}));

// ── PATCH /api/v1/customers/{customer_id}/stage（main.py:1679-1708）──────────
const stageUpdateSchema = z.object({
  stage: z.string(),
  reason: z.string().nullish(),
});

app.patch("/api/v1/customers/:customer_id/stage", (c) => respond(c, async () => {
  const user = await requireUser(c);
  const { customer_id: customerId } = parseQuery(idParam, c.req.param(), "path");
  const body = await parseBody(c, stageUpdateSchema);
  const target = body.stage;
  const check = validateManualStage(target);
  if (!check.ok) {
    throw httpError(422, { error: "invalid_enum", code: "INVALID_CUSTOMER_STAGE", detail: check.msg });
  }
  const payload = await withDb(getEnv(c), async (sql: Db) => {
    const customer = await customerOr404(sql, customerId, user);
    checkWriteAccess(user, customer);
    const fromStage = customer.stage;
    const reason = (body.reason ?? "").trim() || null;
    await sql`UPDATE customers SET stage=${target}, updated_at=NOW() WHERE id=${customerId}`;
    await sql`
      INSERT INTO cust_stage_log (tenant_id, customer_id, from_stage, to_stage, changed_by, reason)
      VALUES (${DEFAULT_TENANT}, ${customerId}, ${fromStage as string | null}, ${target},
              ${String(user.id)}, ${reason})`;
    const refreshed = await customerOr404(sql, customerId, user);
    return { ...customerApi(refreshed), closed_inquiries: [] };
  });
  return c.json(payload);
}));

// ── PATCH /api/v1/customers/{customer_id}（ws_crm_ext.py:166-211）────────────
const customerUpdateSchema = z.object({
  company_name: z.string().nullish(),
  abbr: z.string().nullish(),
  country: z.string().nullish(),
  address: z.string().nullish(),
  default_port: z.string().nullish(),
  credit_level: z.string().nullish(),
  notes: z.string().nullish(),
  owner_scope: z.string().nullish(),
});

/** 可更新列白名单（ws_crm_ext.py:_CUSTOMER_COLUMNS）。 */
const CUSTOMER_COLUMNS: [string, string][] = [
  ["company_name", "name"], ["abbr", "abbr"], ["country", "country"],
  ["address", "address"], ["default_port", "default_port"],
  ["credit_level", "credit_level"], ["notes", "notes"], ["owner_scope", "owner_scope"],
];

app.patch("/api/v1/customers/:customer_id", (c) => respond(c, async () => {
  const user = await requireUser(c);
  const { customer_id: customerId } = parseQuery(idParam, c.req.param(), "path");
  const rawBody = await c.req.json().catch(() => httpErrorThrow422());
  const body = await parseBody(c, customerUpdateSchema);
  const payload = await withDb(getEnv(c), async (sql: Db) => {
    const customer = await customerOr404(sql, customerId, user);
    checkWriteAccess(user, customer);

    const provided = (key: string): boolean => (
      rawBody !== null && typeof rawBody === "object" && key in (rawBody as Record<string, unknown>)
    );
    const data: Record<string, unknown> = {};
    for (const [field] of CUSTOMER_COLUMNS) {
      if (provided(field)) {
        data[field] = (body as Record<string, unknown>)[field];
      }
    }
    if (provided("owner_scope")) {
      validateEnum("owner_scope", data.owner_scope as string | null | undefined);
    }
    if (provided("abbr")) {
      data.abbr = normAbbr(data.abbr as string | null | undefined);
    }

    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [field, column] of CUSTOMER_COLUMNS) {
      if (field in data) {
        params.push(data[field]);
        sets.push(`${column} = ${"$" + params.length}`);
      }
    }
    if (sets.length === 0) {
      // 没有任何字段变更时不发 UPDATE，原样回显（updated_at 不动）
      return customerApi(customer);
    }
    sets.push("updated_at = now()");
    params.push(customerId);
    const updated = await sql.unsafe(
      `UPDATE customers SET ${sets.join(", ")} WHERE id=${"$" + params.length}`
      + ` AND tenant_id=${"$" + (params.length + 1)} RETURNING *`,
      [...params, DEFAULT_TENANT],
    );
    // 档案编辑不改 stage，沿用编辑前那一行的 stage_display
    return customerApi({
      ...(updated[0] as Record<string, unknown>),
      stage_display: customer.stage_display,
    });
  });
  return c.json(payload);
}));

// ── GET /api/v1/customers/{customer_id}/inquiries（ws_crm_ext.py:216-256）────
app.get("/api/v1/customers/:customer_id/inquiries", (c) => respond(c, async () => {
  const user = await requireUser(c);
  const { customer_id: customerId } = parseQuery(idParam, c.req.param(), "path");
  const status = c.req.query("status");
  const payload = await withDb(getEnv(c), async (sql: Db) => {
    await customerOr404(sql, customerId, user);
    let rows: Record<string, unknown>[];
    if (status) {
      validateEnum("inquiry_status", status);
      rows = await sql`
        SELECT * FROM cust_inquiries WHERE customer_id=${customerId}
        AND tenant_id=${DEFAULT_TENANT} AND status=${status} ORDER BY created_at DESC`;
    } else {
      rows = await sql`
        SELECT * FROM cust_inquiries WHERE customer_id=${customerId}
        AND tenant_id=${DEFAULT_TENANT} ORDER BY created_at DESC`;
    }
    const items: Record<string, unknown>[] = [];
    for (const r of rows) {
      const hasQuote = await sql`
        SELECT 1 FROM quote_orders WHERE tenant_id=${DEFAULT_TENANT}
        AND inquiry_id=${num(r.id)} LIMIT 1`;
      items.push({ ...rowToInquiry(r), inquiry_no_editable: hasQuote.length === 0 });
    }
    return { items, total: rows.length };
  });
  return c.json(payload);
}));

// ══════════════════════════════════════════════════════════════════════════════
// P3 批次A · 询盘读端点门面直连（AUTH_DB_SPLIT=on 时启用；off = 与今天逐字一致）
//
// 为什么是这三条：customers 域剩下的读**早已**在门面直连（列表 main.py:1372 起、
// 详情 main.py:1506、records ws_customer_records.py:36 都走 withDb）；M1-f 因
// 「形状全在内核」而把这三条询盘 GET 留成 forwardAuthenticatedKernelRequest。
// 内核 Pyodide 冷启动失败（2026-10-24 事故）时，询盘工位 /inquiries 与客户页
// 询盘抽屉因此整块不可用 —— 迁到门面直连后不再依赖内核冷启动。
//
// 真源逐条直译（SQL 文本、参数顺序、排序、响应键一律照抄，禁止顺手优化）：
// - backend/worker/src/ws_crm_ext.py:303-399  list_inquiries
// - backend/worker/src/ws_crm_ext.py:402-479  get_inquiry
// - backend/worker/src/ws_crm_ext.py:609-646  list_inquiry_stage_log
// 序列化复用 src/serializers.ts（rowToInquiry / inquiryStageLogApi = kaas_common 镜像）
// 与 src/routes/orders.ts 的 rowToOrder（= main.py:3811 _order_dict → row_to_order）。
// ══════════════════════════════════════════════════════════════════════════════

/** inquiry_stage.py:30-34：阶段序 + 终态 closed（只用于 stage 筛选值校验，不做计算）。 */
const INQUIRY_STAGES = ["inquiry", "quotation", "order", "shipment", "completed", "closed"] as const;

/** ws_crm_ext.py:111-125 `_parse_day`：空 → null；非法 → 422 INVALID_DATE。
 * 静默忽略比报错更糟（用户以为筛了某月，实际拿到全量）。 */
function parseDay(raw: string | undefined, field: string): string | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const text = String(raw).slice(0, 10);
  const ok = /^\d{4}-\d{2}-\d{2}$/.test(text)
    && !Number.isNaN(new Date(text + "T00:00:00Z").getTime())
    && new Date(text + "T00:00:00Z").toISOString().slice(0, 10) === text;
  if (!ok) {
    throw httpError(422, {
      error: "validation", code: "INVALID_DATE",
      field, detail: field + " 必须是 YYYY-MM-DD",
    });
  }
  return text;
}

/** Python `dict.get` 口径：缺列/None 一律 null —— 保证响应键**不会**因
 * JSON.stringify 丢掉 undefined 而少一个（内核响应逐字段对齐）。 */
function at(row: Row, key: string): unknown {
  const value = row[key];
  return value === undefined ? null : value;
}

/** kaas_common/workstation/quote_serializers.py:102 `_float`：None → None，其余 float。 */
function quoteFloat(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

/** DATE 列 → 'YYYY-MM-DD'（Python 侧是 `date`，`.isoformat()` 只出日期；不是 timestamptz）。 */
function pyDate(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return value;
}

/** quote_serializers.py:11-44 `row_to_quote`：32 键逐字直译（只读投影）。
 * 询盘详情的报价历史直接复用它 —— 不在这里定义第二份「报价是什么」的判定。 */
function rowToQuote(q: Row, itemCount: number): Record<string, unknown> {
  const v = (key: string): unknown => at(q, key);
  return {
    id: num(v("id")), quote_no: v("quote_no"),
    customer_id: num(v("customer_id")), customer_name: v("customer_name"),
    inquiry_id: num(v("inquiry_id")),
    status: v("status"), currency: v("currency"),
    total_amount: quoteFloat(v("total_amount")),
    valid_until: pyIso(v("valid_until")),
    notes: v("notes"),
    fx_rate: quoteFloat(v("fx_rate")),
    // DATE 列（quote_orders.fx_rate_date 是 Date，不是 timestamptz）：Python `.isoformat()` 只出日期
    fx_rate_date: pyDate(v("fx_rate_date")),
    tax_archive_id: v("tax_archive_id"),
    tax_archive_code: v("tax_archive_code"),
    tax_archive_name: v("tax_archive_name"),
    tax_snapshot: v("tax_snapshot"),
    created_at: pyIso(v("created_at")),
    created_by: v("created_by"),
    owner_id: v("owner_id"), owner_scope: v("owner_scope"),
    item_count: itemCount,
    incoterm: v("incoterm"), payment_terms: v("payment_terms"),
    port_of_loading: v("port_of_loading"),
    port_of_destination: v("port_of_destination"),
    shipping_marks: v("shipping_marks"),
    country_of_origin: v("country_of_origin"),
    destination_country: v("destination_country"),
    destination_region: v("destination_region"),
    carrier: v("carrier"),
    // 同上：Date 列 ⇒ 只出日期（freight_valid_from/to 均为 Date）
    freight_valid_from: pyDate(v("freight_valid_from")),
    freight_valid_to: pyDate(v("freight_valid_to")),
  };
}

/** FastAPI 侧 `list_inquiries` 的查询参数（Optional[str]/Optional[int]，空串视为未传）。 */
const inquiryListQuery = z.object({
  status: z.string().optional(),
  // FastAPI 的 Optional[int]：空串/非整数 → 422（不是静默 coerce 成 0）
  customer_id: z.string().regex(/^-?\d+$/, "Input should be a valid integer").transform(Number).optional(),
  stage: z.string().optional(),
  channel: z.string().optional(),
  date_from: z.string().optional(),
  date_to: z.string().optional(),
  q: z.string().optional(),
});

/** GET /api/v1/inquiries —— ws_crm_ext.py:303-399 `list_inquiries` 逐字直译。
 *
 * SQL 三段结构与原函数一致：① 相关子查询带 quote_count / order_count /
 * latest_quote_at（一次查询取回，禁止逐行 N+1）；② WHERE i.tenant_id=$1 + 三层可见性
 * 谓词 + 各筛选（参数顺序：scope → status → customer_id → stage → channel →
 * date_from → date_to → q，与 Python params.append 顺序逐条对应）；③ 排序
 * `ORDER BY i.customer_id, i.created_at DESC`（按客户归类、客户内时间倒序）。
 * 没有分页：内核返回全部，total = len(rows)。 */
export async function listInquiriesDirect(
  c: Context,
  user: CurrentUser,
): Promise<Response> {
  const query = parseQuery(inquiryListQuery, c.req.query());
  // FastAPI 的 Optional[str]：?status=（空串）在 Python 里是假值 ⇒ 等同未传
  const text = (raw: string | undefined): string => (raw === undefined ? "" : raw);
  const status = text(query.status);
  const stage = text(query.stage);
  const channel = text(query.channel);
  const q = text(query.q);

  const params: unknown[] = [DEFAULT_TENANT];
  let statement =
    "SELECT i.*, c.name AS company_name,"
    // 报价数：一个询盘可以多次报价（改价重报），所以是计数不是布尔
    + " (SELECT count(*) FROM quote_orders q"
    + "    WHERE q.tenant_id = i.tenant_id AND q.inquiry_id = i.id) AS quote_count,"
    // 订单数：正列 inquiry_id + 经报价传递的历史单**都算**（迁移前的订单只有后者）
    + " (SELECT count(*) FROM orders o"
    + "    WHERE o.tenant_id = i.tenant_id"
    + "      AND (o.inquiry_id = i.id"
    + "           OR o.quote_id IN (SELECT q2.id FROM quote_orders q2"
    + "                              WHERE q2.tenant_id = i.tenant_id"
    + "                                AND q2.inquiry_id = i.id))) AS order_count,"
    // 最近一次报价时间：报价历史的入口提示
    + " (SELECT max(q3.created_at) FROM quote_orders q3"
    + "    WHERE q3.tenant_id = i.tenant_id AND q3.inquiry_id = i.id)"
    + "   AS latest_quote_at"
    + " FROM cust_inquiries i"
    + " JOIN customers c ON i.customer_id = c.id"
    + " WHERE i.tenant_id = $1";
  if (!canSeeAll(user)) {
    // §10.3 + 三层组织：自己名下 + 租户共享 + **本团队**（与 dev scope_filter 同序）
    params.push(String(user.id));
    let scopeCond = "(i.owner_id = $" + params.length + " OR i.owner_scope = 'tenant'";
    if (user.team_id !== null && user.team_id !== undefined) {
      params.push(user.team_id);
      scopeCond += " OR i.team_id = $" + params.length;
    }
    statement += " AND " + scopeCond + ")";
  }
  if (status) {
    validateEnum("inquiry_status", status);
    params.push(status);
    statement += " AND i.status = $" + params.length;
  }
  if (query.customer_id) {
    params.push(query.customer_id);
    statement += " AND i.customer_id = $" + params.length;
  }
  if (stage) {
    // 阶段与 status 是两层语义（流程进度 vs 报价三态）：非法值先 422，
    // 否则会被当成「没有询盘」静默返回空列表（ws_crm_ext.py:364-372）。
    if (!(INQUIRY_STAGES as readonly string[]).includes(stage)) {
      throw httpError(422, {
        error: "invalid_enum_value", code: "INVALID_ENUM",
        field: "stage", value: stage, allowed: [...INQUIRY_STAGES],
      });
    }
    params.push(stage);
    statement += " AND i.stage = $" + params.length;
  }
  if (channel) {
    validateEnum("inquiry_channel", channel);
    params.push(channel);
    statement += " AND i.channel = $" + params.length;
  }
  if (query.date_from) {
    params.push(parseDay(query.date_from, "date_from"));
    statement += " AND i.created_at::date >= $" + params.length;
  }
  if (query.date_to) {
    params.push(parseDay(query.date_to, "date_to"));
    statement += " AND i.created_at::date <= $" + params.length;
  }
  if (q) {
    params.push("%" + q.trim() + "%");
    statement += " AND (i.product_name_raw ILIKE $" + params.length
      + " OR i.inquiry_no ILIKE $" + params.length
      + " OR c.name ILIKE $" + params.length + ")";
  }
  statement += " ORDER BY i.customer_id, i.created_at DESC";

  const rows = (await withDb(getEnv(c), (sql: Db) =>
    sql.unsafe(statement, params as never[]))) as unknown as Row[];
  return c.json({
    items: rows.map((r) => ({
      ...rowToInquiry(r),
      company_name: at(r, "company_name"),
      quote_count: num0(at(r, "quote_count")),
      order_count: num0(at(r, "order_count")),
      latest_quote_at: pyIso(at(r, "latest_quote_at")),
    })),
    total: rows.length,
  });
}

/** GET /api/v1/inquiries/{inquiry_id} —— ws_crm_ext.py:402-479 `get_inquiry` 直译。
 *
 * 响应 = row_to_inquiry 全键 + company_name + quotes[]（报价历史：时间正序，每张带
 * item_count 与 order_count）+ orders[]（正列 inquiry_id 优先、经报价传递的历史单兜底）
 * + stage_log[]（含 id，与本文件 stage-log 端点形状不同，逐字照抄）+ counts{}。
 * 不可见与不存在一律 404 INQUIRY_NOT_FOUND（不泄露存在性）。
 * 只读：Python 侧虽用 `_acquire` 事务，但全程 SELECT，这里等价用 withDb。 */
export async function getInquiryDirect(
  c: Context,
  user: CurrentUser,
): Promise<Response> {
  const { inquiry_id: inquiryId } = parseQuery(
    z.object({ inquiry_id: z.coerce.number().int() }),
    c.req.param(),
    "path",
  );
  const payload = await withDb(getEnv(c), async (sql: Db) => {
    const inqRows = (await sql.unsafe(
      "SELECT i.*, c.name AS company_name FROM cust_inquiries i"
      + " JOIN customers c ON i.customer_id = c.id"
      + " WHERE i.tenant_id = $1 AND i.id = $2",
      [DEFAULT_TENANT, inquiryId] as never[],
    )) as unknown as Row[];
    const inq = inqRows[0];
    if (!inq || !ownerVisible(user, inq)) {
      throw httpError(404, { error: "not_found", code: "INQUIRY_NOT_FOUND" });
    }
    const detail: Record<string, unknown> = {
      ...rowToInquiry(inq),
      company_name: at(inq, "company_name"),
    };

    // 报价历史：时间正序（看改价轨迹），带行项数与该次报价金额
    const quotes = (await sql.unsafe(
      "SELECT * FROM quote_orders WHERE tenant_id=$1 AND inquiry_id=$2"
      + " ORDER BY created_at, id",
      [DEFAULT_TENANT, inquiryId] as never[],
    )) as unknown as Row[];
    const quoteItems: Record<string, unknown>[] = [];
    for (const quote of quotes) {
      const itemCount = (await sql.unsafe(
        "SELECT count(*) FROM quote_order_items"
        + " WHERE tenant_id=$1 AND quote_order_id=$2",
        [DEFAULT_TENANT, num(quote.id)] as never[],
      )) as unknown as Row[];
      const orderCount = (await sql.unsafe(
        "SELECT count(*) FROM orders"
        + " WHERE tenant_id=$1 AND quote_id=$2 AND status <> 'cancelled'",
        [DEFAULT_TENANT, num(quote.id)] as never[],
      )) as unknown as Row[];
      quoteItems.push({
        ...rowToQuote(quote, num0(itemCount[0]?.count)),
        order_count: num0(orderCount[0]?.count),
      });
    }
    detail.quotes = quoteItems;

    // 关联订单：正列 inquiry_id 优先，经报价传递的历史单补上
    const orderRows = (await sql.unsafe(
      "SELECT * FROM orders WHERE tenant_id=$1"
      + "   AND (inquiry_id = $2"
      + "        OR quote_id IN (SELECT id FROM quote_orders"
      + "                        WHERE tenant_id=$1 AND inquiry_id=$2))"
      + " ORDER BY created_at DESC, id DESC",
      [DEFAULT_TENANT, inquiryId] as never[],
    )) as unknown as Row[];
    detail.orders = orderRows.map((row) => rowToOrder(row));

    // 阶段流水（TODO(F4) 落库口径）：谁 / 哪个事件 / 从哪到哪
    const stageRows = (await sql.unsafe(
      "SELECT * FROM inquiry_stage_log WHERE tenant_id=$1 AND inquiry_id=$2"
      + " ORDER BY created_at, id",
      [DEFAULT_TENANT, inquiryId] as never[],
    )) as unknown as Row[];
    detail.stage_log = stageRows.map((row) => ({
      id: num(at(row, "id")),
      from_stage: at(row, "from_stage"),
      to_stage: at(row, "to_stage"),
      source_event: at(row, "source_event"),
      actor_id: at(row, "actor_id"),
      note: at(row, "note"),
      created_at: pyIso(at(row, "created_at")),
    }));

    detail.counts = {
      quotes: quoteItems.length,
      orders: orderRows.length,
      open_orders: orderRows.filter(
        (row) => row.status !== "completed" && row.status !== "cancelled",
      ).length,
    };
    return detail;
  });
  return c.json(payload);
}

/** GET /api/v1/inquiries/{inquiry_id}/stage-log —— ws_crm_ext.py:609-646 直译。
 *
 * 响应 `{items:[{from_stage,to_stage,source_event,actor_id,note,created_at}]}`：**没有 id**
 * （与详情里的 stage_log[] 不同，逐字照抄），故复用 serializers.inquiryStageLogApi。
 * 可见性：Python 这条只 SELECT id，再交给 `_owner_visible` —— 行上没有 owner_id/
 * owner_scope/team_id ⇒ 非管理员恒 404（前端「失败静默隐藏」）。这是内核**现状**，
 * 逐字保留以免门面与内核行为分叉；是否修内核另议（见交付疑问 Q1）。 */
export async function listInquiryStageLogDirect(
  c: Context,
  user: CurrentUser,
): Promise<Response> {
  const { inquiry_id: inquiryId } = parseQuery(
    z.object({ inquiry_id: z.coerce.number().int() }),
    c.req.param(),
    "path",
  );
  const payload = await withDb(getEnv(c), async (sql: Db) => {
    const inqRows = (await sql.unsafe(
      "SELECT id FROM cust_inquiries WHERE id=$1 AND tenant_id=$2",
      [inquiryId, DEFAULT_TENANT] as never[],
    )) as unknown as Row[];
    const inq = inqRows[0];
    if (!inq || !ownerVisible(user, inq)) {
      throw httpError(404, { error: "not_found", code: "INQUIRY_NOT_FOUND" });
    }
    const rows = (await sql.unsafe(
      "SELECT from_stage, to_stage, source_event, actor_id, note, created_at"
      + " FROM inquiry_stage_log WHERE tenant_id=$1 AND inquiry_id=$2"
      + " ORDER BY created_at, id",
      [DEFAULT_TENANT, inquiryId] as never[],
    )) as unknown as Row[];
    return { items: rows.map(inquiryStageLogApi) };
  });
  return c.json(payload);
}

// ── GET /api/v1/inquiries（ws_crm_ext.py:303-399）────────────────────────────
// 2026-10-22（M1-f）：改为透传内核 —— 内核 M1-d 已扩 quote_count/order_count/
// latest_quote_at 与 stage/channel/date_from/date_to/q 筛选；门面不再写第二份 SQL。
// 2026-10-24（P3 批次A）：AUTH_DB_SPLIT=on ⇒ 走上面的 listInquiriesDirect（SQL 逐字
// 直译回门面，询盘工位不再依赖内核冷启动）；**off（默认）⇒ 仍是 M1-f 那一句**
// forwardAuthenticatedKernelRequest，行为与今天逐字一致（一键回退）。
// 判定次序：先看开关（纯 var 读，不触 DB/内核）⇒ 命中才 requireUser；未命中直接调
// 原函数（它自己做的就是 requireUser + 原样转发，401 同样不打 DB/内核）。
app.get("/api/v1/inquiries", (c) =>
  respond(c, async () => {
    if (useDirectRoute(getEnv(c), DIRECT_ROUTE_IDS.inquiriesList)) {
      const user = await requireUser(c);
      return directDb(c, () => listInquiriesDirect(c, user));
    }
    return forwardAuthenticatedKernelRequest(c);
  }));

// ── GET /api/v1/inquiries/{inquiry_id}（ws_crm_ext.py:402-479）────────────────
// 询盘详情（含报价历史/关联订单/阶段流水）：2026-10-24（P3 批次A）起开关 on 走
// getInquiryDirect；off（默认）仍是下面这一句透传，行为逐字不变。
app.get("/api/v1/inquiries/:inquiry_id", (c) =>
  respond(c, async () => {
    if (useDirectRoute(getEnv(c), DIRECT_ROUTE_IDS.inquiriesDetail)) {
      const user = await requireUser(c);
      return directDb(c, () => getInquiryDirect(c, user));
    }
    return forwardAuthenticatedKernelRequest(c);
  }));

// ── PATCH /api/v1/inquiries/{inquiry_id}（ws_crm_ext.py:301-410）─────────────
// 2026-10-22（M1-f）：改为透传内核 —— 状态机/编号锁定/线索池联动/多产品行全在内核
// （门面旧实现是第二份 SQL + 状态机镜像，已删除；ADR-008 铁纪律）。
app.patch("/api/v1/inquiries/:inquiry_id", (c) =>
  respond(c, async () => forwardAuthenticatedKernelRequest(c)));

// ── GET /api/v1/inquiries/{inquiry_id}/stage-log（ws_crm_ext.py:609-646）──────
// 2026-10-22（M1-f）：改为透传内核 —— 阶段日志的可见性/投影全在内核。
// 2026-10-24（P3 批次A）：开关 on 走 listInquiryStageLogDirect；off（默认）仍透传。
app.get("/api/v1/inquiries/:inquiry_id/stage-log", (c) =>
  respond(c, async () => {
    if (useDirectRoute(getEnv(c), DIRECT_ROUTE_IDS.inquiriesStageLog)) {
      const user = await requireUser(c);
      return directDb(c, () => listInquiryStageLogDirect(c, user));
    }
    return forwardAuthenticatedKernelRequest(c);
  }));

// ── GET /api/v1/customers/{customer_id}/records（ws_customer_records.py:36-65）──
app.get("/api/v1/customers/:customer_id/records", (c) => respond(c, async () => {
  const user = await requireUser(c);
  const { customer_id: customerId } = parseQuery(idParam, c.req.param(), "path");
  const payload = await withDb(getEnv(c), async (sql: Db) => {
    const customer = await customerOr404(sql, customerId, user);
    const quotes = await sql`
      SELECT id, quote_no, inquiry_id, status, currency, total_amount, created_at
        FROM quote_orders WHERE customer_id=${customerId} AND tenant_id=${DEFAULT_TENANT}
       ORDER BY created_at DESC`;
    const orders = await sql`
      SELECT id, order_no, quote_id, status, currency, total_amount, created_at
        FROM orders WHERE customer_id=${customerId} AND tenant_id=${DEFAULT_TENANT}
       ORDER BY created_at`;
    const docs = await sql`
      SELECT id, doc_no, doc_type, quote_id, order_id, status, currency,
             total_amount, created_at
        FROM trade_docs WHERE customer_id=${customerId} AND tenant_id=${DEFAULT_TENANT}
       ORDER BY created_at`;
    return buildRecords(
      { ...customer, id: customerId },
      quotes as Record<string, unknown>[],
      orders as Record<string, unknown>[],
      docs as Record<string, unknown>[],
    );
  });
  return c.json(payload);
}));

// ── 阶段 3 · 客户能力（main.py:3080-3222，表 customer_capabilities）────────────

// GET /api/v1/capability-customers（main.py:3101-3120）
app.get("/api/v1/capability-customers", (c) => respond(c, async () => {
  await requireUser(c);
  const payload = await withDb(getEnv(c), (sql: Db) => sql`
    SELECT customer_id, customer_name,
           count(DISTINCT product_category) AS category_count,
           max(updated_at) AS updated_at
      FROM customer_capabilities
     WHERE tenant_id = ${DEFAULT_TENANT}
     GROUP BY customer_id, customer_name
     ORDER BY max(updated_at) DESC`);
  const items = (payload as Record<string, unknown>[]).map((r) => ({
    customer_id: r.customer_id,
    customer_name: r.customer_name,
    category_count: num0(r.category_count),
    updated_at: pyIso(r.updated_at),
    locale: "zh-CN",
    region: "CN",
  }));
  return c.json({ items });
}));

// GET /api/v1/capabilities（main.py:3123-3142）
app.get("/api/v1/capabilities", (c) => respond(c, async () => {
  await requireUser(c);
  const customerId = c.req.query("customer_id") ?? "";
  const rows = await withDb(getEnv(c), (sql: Db) => {
    if (customerId) {
      return sql`
        SELECT * FROM customer_capabilities
         WHERE tenant_id = ${DEFAULT_TENANT} AND customer_id = ${customerId}
         ORDER BY product_category`;
    }
    return sql`
      SELECT * FROM customer_capabilities
       WHERE tenant_id = ${DEFAULT_TENANT} ORDER BY customer_id, product_category`;
  });
  return c.json({ capabilities: (rows as Record<string, unknown>[]).map(capabilityRow) });
}));

// POST /api/v1/capabilities（main.py:3145-3182）
const capabilityUpsertSchema = z.object({
  customer_id: z.string().nullish(),
  customer_name: z.string().nullish(),
  product_category: z.string().nullish(),
  spec_constraints: z.unknown().nullish(),
  notes: z.unknown().nullish(),
  effective_from: z.unknown().nullish(),
});

app.post("/api/v1/capabilities", (c) => respond(c, async () => {
  await requireUser(c);
  const body = await parseBody(c, capabilityUpsertSchema);
  const customerId = (body.customer_id ?? "").toString().trim();
  const customerName = (body.customer_name ?? "").toString().trim();
  const productCategory = (body.product_category ?? "").toString().trim();
  if (!customerId || !productCategory) {
    throw httpError(422, "customer_id and product_category are required");
  }
  const specConstraints = body.spec_constraints ?? {};
  const notes = body.notes ?? null;
  const effectiveFrom = body.effective_from ?? null;
  const row = await withDb(getEnv(c), async (sql: Db) => {
    const existing = await sql`
      SELECT id FROM customer_capabilities
       WHERE tenant_id = ${DEFAULT_TENANT} AND customer_id = ${customerId}
       AND product_category = ${productCategory}`;
    const found = existing[0] as Record<string, unknown> | undefined;
    if (found) {
      const updated = await sql`
        UPDATE customer_capabilities
           SET customer_name = ${customerName || null}, spec_constraints = ${sql.json(specConstraints as unknown as postgres.JSONValue)},
               notes = ${notes as string | null},
               effective_from = COALESCE(${effectiveFrom as string | null}, effective_from),
               updated_at = now()
         WHERE id = ${num(found.id)} RETURNING id`;
      return updated[0] as Record<string, unknown>;
    }
    const inserted = await sql`
      INSERT INTO customer_capabilities
             (tenant_id, customer_id, customer_name, product_category,
              spec_constraints, notes, effective_from, schema_version)
      VALUES (${DEFAULT_TENANT}, ${customerId}, ${customerName || null}, ${productCategory},
              ${sql.json(specConstraints as unknown as postgres.JSONValue)}, ${notes as string | null},
              ${effectiveFrom as string | null}, 1) RETURNING id`;
    return inserted[0] as Record<string, unknown>;
  });
  return c.json({ id: num(row.id) });
}));

// GET /api/v1/customer/{customer_id}/capabilities（main.py:3185-3200；注意单数 customer + str id）
app.get("/api/v1/customer/:customer_id/capabilities", (c) => respond(c, async () => {
  await requireUser(c);
  const { customer_id: customerId } = c.req.param();
  const rows = await withDb(getEnv(c), (sql: Db) => sql`
    SELECT * FROM customer_capabilities
     WHERE tenant_id = ${DEFAULT_TENANT} AND customer_id = ${customerId}
     ORDER BY product_category`);
  const items = (rows as Record<string, unknown>[]).map((r) => ({
    ...capabilityRow(r),
    is_active: true,
  }));
  return c.json(items);
}));

// PATCH /api/v1/customer/{customer_id}/capabilities（main.py:3203-3222）
app.patch("/api/v1/customer/:customer_id/capabilities", (c) => respond(c, async () => {
  await requireUser(c);
  const { customer_id: customerId } = c.req.param();
  const body = await parseBody(c, z.object({
    id: z.coerce.number().int().nullish(),
    spec_constraints: z.unknown().nullish(),
    is_active: z.boolean().nullish(),
  }));
  if (typeof body.id !== "number") {
    throw httpError(422, "id is required");
  }
  const rows = await withDb(getEnv(c), (sql: Db) => sql`
    UPDATE customer_capabilities
       SET spec_constraints = ${sql.json((body.spec_constraints ?? {}) as unknown as postgres.JSONValue)}, updated_at = now()
     WHERE id = ${body.id} AND tenant_id = ${DEFAULT_TENANT} AND customer_id = ${customerId}
     RETURNING id`);
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) {
    return c.json({ error: "not_found" });
  }
  return c.json({ id: num(row.id), is_active: body.is_active ?? true });
}));

export default app;
