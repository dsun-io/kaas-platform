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
import { Hono } from "hono";
import type postgres from "postgres";
import { z } from "zod";

import { withDb, type Db, type Tx } from "../db";
import { getEnv, type Env } from "../env";
import { httpError, num, num0, parseBody, parseQuery, pyIso, respond } from "../http";
import {
  buildRecords,
  buildNumber,
  canView,
  canWrite,
  customerStageSql,
  isAdminRole,
  normalizeAbbr,
  normalizeNumber,
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

const app = new Hono<{ Bindings: Env }>();

// 入参 schema 当前手写（TODO(TODO:TS1)：待 pydantic→zod 生成器覆盖本域后替换）。

const DEFAULT_TENANT = "default";

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

// ── GET /api/v1/inquiries（ws_crm_ext.py:259-298）─────────────────────────────
app.get("/api/v1/inquiries", (c) => respond(c, async () => {
  const user = await requireUser(c);
  const status = c.req.query("status");
  const customerIdRaw = c.req.query("customer_id");
  const payload = await withDb(getEnv(c), async (sql: Db) => {
    let sqlText = (
      "SELECT i.*, c.name AS company_name FROM cust_inquiries i"
      + " JOIN customers c ON i.customer_id = c.id"
      + " WHERE i.tenant_id = $1"
    );
    const params: unknown[] = [DEFAULT_TENANT];
    if (!canSeeAll(user)) {
      // §10.3 + 三层组织：自己名下 + 租户共享 + 本团队
      params.push(String(user.id));
      let scopeCond = `(i.owner_id = ${"$" + params.length} OR i.owner_scope = 'tenant'`;
      if (user.team_id !== null) {
        params.push(user.team_id);
        scopeCond += ` OR i.team_id = ${"$" + params.length}`;
      }
      sqlText += ` AND ${scopeCond})`;
    }
    if (status) {
      validateEnum("inquiry_status", status);
      params.push(status);
      sqlText += ` AND i.status = ${"$" + params.length}`;
    }
    if (customerIdRaw) {
      params.push(Number(customerIdRaw));
      sqlText += ` AND i.customer_id = ${"$" + params.length}`;
    }
    sqlText += " ORDER BY i.customer_id, i.created_at DESC";
    const rows = await sql.unsafe(sqlText, params);
    const items = (rows as Record<string, unknown>[]).map((r) => ({
      ...rowToInquiry(r),
      company_name: r.company_name,
    }));
    return { items, total: rows.length };
  });
  return c.json(payload);
}));

// ── PATCH /api/v1/inquiries/{inquiry_id}（ws_crm_ext.py:301-410）─────────────

/** 询盘状态机（ws_crm_ext.py:_INQUIRY_NEXT，真源 = orchestrator allowed_flows）。 */
const INQUIRY_NEXT: Record<string, readonly string[]> = {
  unquoted: ["closed"],
  quoted: ["closed"],
  closed: ["unquoted", "quoted"],
};

/** 询盘状态 → 线索池 lead_candidates.inquiry_status（ws_crm_ext.py:_LEAD_INQUIRY_STATUS）。 */
const LEAD_INQUIRY_STATUS: Record<string, string> = {
  unquoted: "new", quoted: "following", closed: "lost",
};

/** 询盘可更新列（ws_crm_ext.py:_INQUIRY_COLUMNS；status/inquiry_no 单独处理）。 */
const INQUIRY_COLUMNS = [
  "channel", "product_name_raw", "quantity", "quantity_unit",
  "application", "notes", "owner_scope",
];

const inquiryUpdateSchema = z.object({
  status: z.string().nullish(),
  inquiry_no: z.string().nullish(),
  channel: z.string().nullish(),
  product_name_raw: z.string().nullish(),
  quantity: z.coerce.number().nullish(),
  quantity_unit: z.string().nullish(),
  application: z.string().nullish(),
  // 多产品行（设计 §5）：PATCH 支持改 items，第一行同步回旧标量字段
  items: z.array(z.record(z.unknown())).optional(),
  notes: z.string().nullish(),
  owner_scope: z.string().nullish(),
});

const inquiryParam = z.object({ inquiry_id: z.coerce.number().int() });

app.patch("/api/v1/inquiries/:inquiry_id", (c) => respond(c, async () => {
  const user = await requireUser(c);
  const { inquiry_id: inquiryId } = parseQuery(inquiryParam, c.req.param(), "path");
  const rawBody = await c.req.json().catch(() => httpErrorThrow422());
  const body = await parseBody(c, inquiryUpdateSchema);
  const payload = await withDb(getEnv(c), async (sql: Db) => {
    return sql.begin(async (tx: Tx) => {
      const found = await tx`
        SELECT * FROM cust_inquiries WHERE id = ${inquiryId} AND tenant_id = ${DEFAULT_TENANT}`;
      const inquiry = found[0] as Record<string, unknown> | undefined;
      if (!inquiry || !ownerVisible(user, inquiry)) {
        throw httpError(404, { error: "not_found", code: "INQUIRY_NOT_FOUND" });
      }
      checkWriteAccess(user, inquiry);

      const provided = (key: string): boolean => (
        rawBody !== null && typeof rawBody === "object" && key in (rawBody as Record<string, unknown>)
      );
      const newStatus = provided("status") ? (body.status ?? null) : null;
      const newNo = provided("inquiry_no") ? (body.inquiry_no ?? null) : undefined;

      const sets: string[] = [];
      const params: unknown[] = [];
      let current: Record<string, unknown> = inquiry;

      if (newNo !== undefined && newNo !== inquiry.inquiry_no) {
        let normalizedNo: string;
        try {
          normalizedNo = normalizeNumber(newNo);
        } catch (e) {
          if (e instanceof NumberRuleError) {
            throw httpError(422, {
              error: "validation", code: "INVALID_INQUIRY_NO", detail: e.message,
            });
          }
          throw e;
        }
        const hasQuote = await tx`
          SELECT 1 FROM quote_orders WHERE tenant_id=${DEFAULT_TENANT}
          AND inquiry_id=${inquiryId} LIMIT 1`;
        if (hasQuote.length > 0) {
          throw httpError(409, {
            error: "conflict", code: "INQUIRY_NO_LOCKED",
            detail: "该询盘已生成报价单，编号已锁定；如需改号请先处理关联报价",
          });
        }
        const taken = await tx`
          SELECT 1 FROM cust_inquiries WHERE tenant_id=${DEFAULT_TENANT}
          AND inquiry_no=${normalizedNo} AND id<>${inquiryId} LIMIT 1`;
        if (taken.length > 0) {
          throw httpError(409, {
            error: "conflict", code: "INQUIRY_NO_TAKEN",
            detail: `询盘编号「${normalizedNo}」已被占用，请换一个`,
          });
        }
        current = { ...current, inquiry_no: normalizedNo };
        params.push(normalizedNo);
        sets.push(`inquiry_no = ${"$" + params.length}`);
      }

      if (newStatus !== null) {
        validateEnum("inquiry_status", newStatus);
        // 三态流转：只有「关闭」是手动动作；关闭后重开若已有报价则回到已报价
        let target = newStatus;
        if (newStatus === "unquoted") {
          const hasQuote = await tx`
            SELECT 1 FROM quote_orders WHERE tenant_id=${DEFAULT_TENANT}
            AND inquiry_id=${inquiryId} LIMIT 1`;
          if (hasQuote.length > 0) {
            target = "quoted";
          }
        }
        const currentStatus = current.status as string;
        if (target !== currentStatus
          && !(INQUIRY_NEXT[currentStatus] ?? []).includes(target)) {
          throw httpError(409, {
            error: "conflict", code: "ILLEGAL_TRANSITION",
            detail: `询盘状态不允许从 ${currentStatus} 流转到 ${target}`,
          });
        }
        if (target !== currentStatus) {
          params.push(target);
          sets.push(`status = ${"$" + params.length}`);
          // 回写线索池 lead_candidates.inquiry_status（§7.2），值没变不写
          const leadId = current.lead_id;
          const mapped = LEAD_INQUIRY_STATUS[target];
          if (leadId !== null && leadId !== undefined && mapped !== undefined) {
            await tx`
              UPDATE lead_candidates SET inquiry_status = ${mapped}, updated_at = now()
              WHERE tenant_id = ${DEFAULT_TENANT} AND id = ${num(leadId)}
              AND inquiry_status IS DISTINCT FROM ${mapped}`;
          }
        }
      }

      if (provided("channel")) {
        validateEnum("inquiry_channel", body.channel);
      }
      if (provided("owner_scope")) {
        validateEnum("owner_scope", body.owner_scope);
      }
      // 多产品行（设计 §5）：items 落 jsonb，**第一行同步写旧标量字段**
      // （显式传了同名列时以显式值为准 —— 与 Python ws_crm_ext 同序）。
      if (provided("items")) {
        const items = normalizeInquiryItems(body.items ?? []);
        params.push(JSON.stringify(items));
        sets.push("items = $" + String(params.length) + "::jsonb");
        const first = items[0];
        const legacy: [string, unknown][] = [
          ["product_name_raw", first?.product_name_raw ?? null],
          ["quantity", first?.quantity ?? null],
          ["quantity_unit", first?.quantity_unit ?? null],
          ["application", first?.application ?? null],
        ];
        for (const [column, value] of legacy) {
          if (provided(column)) continue;
          params.push(value);
          sets.push(column + " = $" + String(params.length));
        }
      }
      for (const column of INQUIRY_COLUMNS) {
        if (provided(column)) {
          params.push((body as Record<string, unknown>)[column]);
          sets.push(`${column} = ${"$" + params.length}`);
        }
      }

      let row: Record<string, unknown>;
      if (sets.length > 0) {
        sets.push("updated_at = now()");
        params.push(inquiryId);
        const updated = await tx.unsafe(
          `UPDATE cust_inquiries SET ${sets.join(", ")} WHERE id = ${"$" + params.length} RETURNING *`,
          params,
        );
        row = updated[0] as Record<string, unknown>;
      } else {
        row = current; // 无变更：dev 也不会发 UPDATE，原样回显
      }

      // 询盘阶段（TODO(TODO:F4)，inquiry_stage.py 语义直译）：
      // 手动关闭 → closed（终态；只前进不后退，重复事件 no-op）
      if (newStatus === "closed" && inquiry.status !== "closed") {
        const stageSequence = ["inquiry", "quotation", "order", "shipment", "completed"];
        const allStages = [...stageSequence, "closed"];
        let currentStage = allStages.includes(current.stage as string)
          ? current.stage as string
          : (current.status === "closed" ? "closed" : "inquiry");
        if (currentStage !== "closed") {
          const target = "closed";
          await tx`
            UPDATE cust_inquiries SET stage=${target}, stage_updated_at=now(), updated_at=now()
            WHERE tenant_id=${DEFAULT_TENANT} AND id=${inquiryId}`;
          await tx`
            INSERT INTO inquiry_stage_log
                   (tenant_id, inquiry_id, from_stage, to_stage, source_event, actor_id, note)
            VALUES (${DEFAULT_TENANT}, ${inquiryId}, ${currentStage}, ${target},
                    'inquiry_closed', ${String(user.id)}, ${null})`;
          currentStage = target;
        }
      }
      return rowToInquiry(row);
    });
  });
  return c.json(payload);
}));

// ── GET /api/v1/inquiries/{inquiry_id}/stage-log（ws_crm_ext.py:413-450）──────
app.get("/api/v1/inquiries/:inquiry_id/stage-log", (c) => respond(c, async () => {
  const user = await requireUser(c);
  const { inquiry_id: inquiryId } = parseQuery(inquiryParam, c.req.param(), "path");
  const payload = await withDb(getEnv(c), async (sql: Db) => {
    const found = await sql`
      SELECT id FROM cust_inquiries WHERE id=${inquiryId} AND tenant_id=${DEFAULT_TENANT}`;
    const inquiry = found[0] as Record<string, unknown> | undefined;
    if (!inquiry || !ownerVisible(user, inquiry)) {
      throw httpError(404, { error: "not_found", code: "INQUIRY_NOT_FOUND" });
    }
    const rows = await sql`
      SELECT from_stage, to_stage, source_event, actor_id, note, created_at
        FROM inquiry_stage_log WHERE tenant_id=${DEFAULT_TENANT} AND inquiry_id=${inquiryId}
       ORDER BY created_at, id`;
    return { items: (rows as Record<string, unknown>[]).map(inquiryStageLogApi) };
  });
  return c.json(payload);
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
