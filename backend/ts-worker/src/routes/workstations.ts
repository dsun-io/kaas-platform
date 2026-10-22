/**
 * KaaS TS 门面 · workstations 域（35 条路由：17 门面移植 + 18 内核透传）。
 *
 * 真源逐条对齐：
 * - backend/worker/src/ws_workstations.py（我的工位 / 个人订阅 / 生效编码判定）
 * - backend/worker/src/ws_enums.py（业务枚举字典）
 * - backend/worker/src/ws_products.py（租户产品 / 工位启停矩阵）
 * - backend/worker/src/main.py:1845-1860（套餐 + 套餐包）
 * - backend/worker/src/main.py:2552-2780（品类树 / 绑定属性；wizard 2 条见下）
 * - backend/worker/src/main.py:4833-4911（企业抬头）
 *
 * ── 移植口径（ADR-008 铁纪律）──────────────────────────────────────────────
 * · **门面移植**（17 条）：鉴权 + zod 入参 + SQL 参数化直译 + 出参投影，无业务 if。
 *   小型纯函数镜像（normalize_swift / normalize_codes / has_workstation /
 *   is_same_team 之外的判定）均标出 Python 行号，TODO(TODO:TS3) 换 KERNEL 规则端点。
 * · **内核透传**（18 条）：端点依赖**报价引擎**（产品注册表 ProductSpec / spec
 *   校验与指纹 / 档位覆盖合并 apply_option_overrides）、**价格生命周期**
 *   （_compute_sku_hash / _upsert_price）、**difflib 近似名建议**、**PNG 校验与
 *   R2 存储**（公章）—— 在 TS 重写即"第二份实现"，故门面只鉴权后原样转发。
 *   清单：tenant-products 写 3 条、products 5 条、product-options/overrides 2 条、
 *   spec/wizard 2 条、company-seals 6 条。
 *
 * SQL 风格：一律 sql.unsafe + 位置参数（$n），与 Python 侧 f-string + $n 逐条对照。
 */
import { Hono, type Context } from "hono";
import { z } from "zod";

import { withDb, type Db } from "../db";
import { getEnv, type Env } from "../env";
import {
  ws_products__TenantProductStatusIn,
  ws_products_WorkstationProductIn,
  ws_workstations_SubscriptionIn,
} from "../generated/schemas";
import { bool, httpError, num, parseBody, parseQuery, pyIso, respond } from "../http";
import { allWorkstations, FULL_CHAIN, isAdminRole, isTeamAdmin } from "../rules";
import { requireUser, type CurrentUser } from "../session";

const app = new Hono<{ Bindings: Env }>();

const DEFAULT_TENANT = "default";
type Row = Record<string, unknown>;
type AppEnv = { Bindings: Env };

const KERNEL_BASE = "https://kernel.internal";

/** 有效订阅 SQL 片段（ws_workstations.py:47 / ws_products.py:56 同一条）。 */
const LIVE_SUB = "active = true AND (expires_at IS NULL OR expires_at > now())";

// ── 行投影 ──────────────────────────────────────────────────────────────────
/** 本域有的 jsonb 文本列（spec / info / overrides）：字符串形态才解析。 */
const JSONB_TEXT_COLS = new Set(["spec", "info", "overrides"]);

/** BIGINT 主键：postgres.js 返回 string，Python asyncpg 返回 int。 */
const INT_ID_RE = /^-?[0-9]+$/;

function rowOut(row: Row): Row {
  const out: Row = {};
  for (const [key, value] of Object.entries(row)) {
    if (JSONB_TEXT_COLS.has(key)) {
      out[key] = safeJsonMaybe(value);
      continue;
    }
    if (key === "id" && typeof value === "string" && INT_ID_RE.test(value)) {
      out[key] = Number(value);
      continue;
    }
    out[key] = pyIso(value);
  }
  return out;
}

function safeJsonMaybe(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function rowsOut(rows: Row[]): Row[] {
  return rows.map(rowOut);
}

// ── 内核透传（引擎端点；禁止在门面重写引擎逻辑）──────────────────────────────
async function forwardToKernel(c: Context<AppEnv>): Promise<Response> {
  const kernel = getEnv(c).KERNEL;
  if (!kernel) {
    return c.json({ error: "kernel_error", message: "kernel binding not configured", status: 503 }, 503);
  }
  const url = new URL(c.req.url);
  const method = c.req.method;
  const init: RequestInit = { method, headers: new Headers(c.req.raw.headers) };
  if (method !== "GET" && method !== "HEAD") {
    init.body = c.req.raw.body;
    (init as { duplex?: string }).duplex = "half";
  }
  let upstream: Response;
  try {
    upstream = await kernel.fetch(new Request(KERNEL_BASE + url.pathname + url.search, init));
  } catch (err) {
    console.error("[workstations] kernel fetch failed", err);
    return c.json({ error: "kernel_error", message: "kernel unreachable", status: 502 }, 502);
  }
  if (upstream.status >= 500) {
    const text = await upstream.text();
    return c.json(
      { error: "kernel_error", message: text.slice(0, 500), status: upstream.status },
      upstream.status as never,
    );
  }
  return new Response(upstream.body, { status: upstream.status, headers: upstream.headers });
}

/** 查询参数压平（c.req.queries() 给的是 string[]；FastAPI 单值参数取首个值）。 */
function queries(c: Context<AppEnv>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, values] of Object.entries(c.req.queries())) {
    const first = values[0];
    if (first !== undefined) out[key] = first;
  }
  return out;
}

const idParam = (name: string) => z.object({ [name]: z.coerce.number().int() });

// ══════════════════════════════════════════════════════════════════════════════
// 业务枚举字典（ws_enums.py:25-32；数据常量 = kaas_common/domain/enums.py 镜像）
// ══════════════════════════════════════════════════════════════════════════════
// ⚠️ 这是**数据镜像**（不是手写规则）：真源 backend/kaas_common/domain/enums.py:13-85，
// 由 scripts/contracts-check.ts 的 R3 与前端 manifest.json 交叉校验。
// TODO(TODO:TS1) 改由生成脚本产出（与 generated/schemas.ts 同一条流水线），删掉手写表。
const ENUMS: Record<string, readonly string[]> = {
  inquiry_status: ["unquoted", "quoted", "closed"],
  customer_stage: ["active", "inactive", "ordered"],
  quote_status: ["draft", "sent", "accepted", "rejected", "expired", "closed"],
  order_status: ["pending", "confirmed", "producing", "shipped", "completed", "cancelled"],
  shipment_status: ["booking", "in_transit", "arrived", "customs", "delivered"],
  inquiry_channel: ["email", "whatsapp", "alibaba", "expo", "website", "quote", "other"],
  doc_type: [
    "quotation", "pi", "contract", "ci", "pl",
    "shipping_advice", "draft", "beneficiary_cert", "beneficiary_decl",
    "non_wood_packing", "weight_list", "quality_cert", "manufacturer_cert",
    "bl", "co", "insurance", "customs_declaration", "fumigation_cert",
    "saso_coc", "vessel_cert", "export_license", "ciq",
    "other",
  ],
  doc_status: ["draft", "issued", "void"],
  currency: ["USD", "CNY", "EUR", "GBP", "JPY", "AUD", "CAD", "HKD"],
  owner_scope: ["private", "tenant"],
  schedule_type: ["deposit", "balance", "full"],
  schedule_status: ["pending", "paid", "overdue"],
  receivable_status: ["unpaid", "partial", "paid"],
  bl_type: ["original", "telex", "seaway"],
};

// GET /api/v1/enums（ws_enums.py:25-32）—— 无鉴权（静态常量，前端登录前后都要用）
app.get("/api/v1/enums", (c) => respond(c, async () => c.json(ENUMS)));

// ══════════════════════════════════════════════════════════════════════════════
// 工位订阅判定（ws_workstations.py:46-118 + kaas_common/workstation/subscriptions.py）
// ══════════════════════════════════════════════════════════════════════════════

/** subscriptions.py:93-102 normalize_codes（逐字直译：去空白、小写、丢空值）。 */
function normalizeCodes(codes: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const code of codes) {
    const text = String(code).trim().toLowerCase();
    if (text) out.add(text);
  }
  return out;
}

/** subscriptions.py:105-113 has_workstation（full_chain 命中即视为开通一切）。 */
function hasWorkstation(codes: Set<string>, workstation: string): boolean {
  return codes.has(FULL_CHAIN) || codes.has(workstation.trim().toLowerCase());
}

/** ws_workstations.py:_known_codes（全部工位 + full_chain）。 */
function knownSubscriptionCodes(): string[] {
  return [...new Set([...allWorkstations(), FULL_CHAIN])].sort();
}

/** ws_workstations.py:_validate_code（未知工位 422，detail 文案逐字对齐）。 */
function validateSubscriptionCode(code: string): string {
  const text = (code ?? "").trim().toLowerCase();
  if (!new Set(knownSubscriptionCodes()).has(text)) {
    throw httpError(422, {
      error: "validation", code: "UNKNOWN_WORKSTATION",
      detail: "未知工位：" + code + "；可选：" + knownSubscriptionCodes().join(", "),
    });
  }
  return text;
}

/** ws_workstations.py:_parse_expires（ISO 时间；非法 422 INVALID_EXPIRES_AT）。 */
function parseExpires(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value.replace("Z", "+00:00"));
  if (Number.isNaN(parsed.getTime())) {
    throw httpError(422, {
      error: "validation", code: "INVALID_EXPIRES_AT",
      detail: "expires_at 需为 ISO 时间，如 2026-12-31T00:00:00+08:00",
    });
  }
  return parsed;
}

/** ws_workstations.py:_codes_for_user（生效编码 = 团队 ∪ 个人；平台管理员 = 全工位）。 */
async function codesForUser(sql: Db, user: CurrentUser): Promise<Set<string>> {
  if (isAdminRole(user.role)) return new Set([FULL_CHAIN]);
  const codes = new Set<string>();
  if (user.team_id !== null) {
    const teamRows = await sql.unsafe(
      "SELECT code FROM team_subscriptions WHERE team_id=$1 AND " + LIVE_SUB,
      [user.team_id]);
    for (const row of teamRows as Row[]) codes.add(String(row.code));
  }
  const userRows = await sql.unsafe(
    "SELECT code FROM user_subscriptions WHERE user_id=$1 AND " + LIVE_SUB, [user.id]);
  for (const row of userRows as Row[]) codes.add(String(row.code));
  return normalizeCodes(codes);
}

/** ws_workstations.py:_require_platform_admin（个人工位开通仅平台管理员）。 */
function requirePlatformAdmin(user: CurrentUser): void {
  if (!isAdminRole(user.role)) {
    throw httpError(403, {
      error: "forbidden", code: "ADMIN_ONLY",
      message: "个人工位开通仅平台管理员可操作",
    });
  }
}

// GET /api/v1/me/workstations（ws_workstations.py:123-137）
app.get("/api/v1/me/workstations", (c) => respond(c, async () => {
  const user = await requireUser(c);
  const payload = await withDb(getEnv(c), async (sql: Db) => {
    const codes = await codesForUser(sql, user);
    const enabled = allWorkstations().filter((workstation) => hasWorkstation(codes, workstation));
    return {
      workstations: enabled,
      codes: [...codes].sort(),
      is_admin: isAdminRole(user.role),
      has_team: user.team_id !== null,
    };
  });
  return c.json(payload);
}));

// ── 个人订阅（仅平台管理员）──────────────────────────────────────────────────

// GET /api/v1/users/{user_id}/subscriptions（ws_workstations.py:230-241）
app.get("/api/v1/users/:user_id/subscriptions", (c) => respond(c, async () => {
  const user = await requireUser(c);
  requirePlatformAdmin(user);
  const { user_id: userId } = parseQuery(idParam("user_id"), c.req.param(), "path");
  const payload = await withDb(getEnv(c), async (sql: Db) => {
    const rows = await sql.unsafe(
      "SELECT * FROM user_subscriptions WHERE user_id=$1 ORDER BY code", [userId]);
    const items = (rows as Row[]).map((row) => ({
      code: row.code,
      active: bool(row.active),
      expires_at: pyIso(row.expires_at),
      source: row.source,
      created_at: pyIso(row.created_at),
    }));
    return { items, total: items.length };
  });
  return c.json(payload);
}));

// PUT /api/v1/users/{user_id}/subscriptions/{code}（ws_workstations.py:244-269）
app.put("/api/v1/users/:user_id/subscriptions/:code", (c) => respond(c, async () => {
  const user = await requireUser(c);
  requirePlatformAdmin(user);
  const { user_id: userId } = parseQuery(idParam("user_id"), c.req.param(), "path");
  const target = validateSubscriptionCode(c.req.param("code"));
  const body = await parseBody(c, ws_workstations_SubscriptionIn);
  const expires = parseExpires(body.expires_at);
  const payload = await withDb(getEnv(c), async (sql: Db) => {
    const exists = await sql.unsafe("SELECT 1 AS ok FROM users WHERE id=$1", [userId]);
    if (exists.length === 0) {
      throw httpError(404, { error: "not_found", code: "USER_NOT_FOUND" });
    }
    const rows = await sql.unsafe(
      "INSERT INTO user_subscriptions (user_id, code, active, expires_at, source)"
      + " VALUES ($1,$2,$3,$4,'manual')"
      + " ON CONFLICT (user_id, code) DO UPDATE SET"
      + "   active = EXCLUDED.active, expires_at = EXCLUDED.expires_at,"
      + "   source = 'manual', updated_at = now()"
      + " RETURNING *",
      [userId, target, body.active, expires]);
    const row = rows[0] as Row;
    return {
      code: row.code,
      active: bool(row.active),
      expires_at: pyIso(row.expires_at),
      source: row.source,
    };
  });
  return c.json(payload);
}));

// DELETE /api/v1/users/{user_id}/subscriptions/{code}（ws_workstations.py:272-289）
app.delete("/api/v1/users/:user_id/subscriptions/:code", (c) => respond(c, async () => {
  const user = await requireUser(c);
  requirePlatformAdmin(user);
  const { user_id: userId } = parseQuery(idParam("user_id"), c.req.param(), "path");
  const target = validateSubscriptionCode(c.req.param("code"));
  const payload = await withDb(getEnv(c), async (sql: Db) => {
    const rows = await sql.unsafe(
      "UPDATE user_subscriptions SET active=false, updated_at=now()"
      + " WHERE user_id=$1 AND code=$2 RETURNING id", [userId, target]);
    if (rows.length === 0) {
      throw httpError(404, { error: "not_found", code: "SUBSCRIPTION_NOT_FOUND" });
    }
    return { revoked: true, code: target };
  });
  return c.json(payload);
}));

// ══════════════════════════════════════════════════════════════════════════════
// 套餐 / 套餐包（main.py:1845-1860）
// ══════════════════════════════════════════════════════════════════════════════

app.get("/api/v1/subscriptions", (c) => respond(c, async () => {
  await requireUser(c);
  const payload = await withDb(getEnv(c), async (sql: Db) => {
    const rows = await sql.unsafe(
      "SELECT * FROM subscriptions WHERE tenant_id=$1 AND status='active' ORDER BY plan_code",
      [DEFAULT_TENANT]);
    return rowsOut(rows as Row[]);
  });
  return c.json(payload);
}));

app.get("/api/v1/subscriptions/bundles", (c) => respond(c, async () => {
  await requireUser(c);
  const payload = await withDb(getEnv(c), async (sql: Db) => {
    const rows = await sql.unsafe(
      "SELECT * FROM subscription_bundles WHERE is_active=true ORDER BY bundle_code");
    return rowsOut(rows as Row[]);
  });
  return c.json(payload);
}));

// ══════════════════════════════════════════════════════════════════════════════
// 品类树 / 品类绑定属性（main.py:2552-2667）
// ══════════════════════════════════════════════════════════════════════════════

/** main.py:2552-2566 _build_category_tree（纯出参装配，无业务判定）。 */
function buildCategoryTree(flat: Row[], parentId: number | null = null): Row[] {
  const nodes: Row[] = [];
  for (const cat of flat) {
    const catParent = (cat.parent_id ?? null) as number | null;
    if (catParent === parentId) {
      const node: Row = {
        id: cat.id,
        code: cat.code,
        name: cat.name,
        parent_id: cat.parent_id,
        path: cat.path,
        level: cat.level,
        industry_code: cat.industry_code,
        is_leaf: cat.is_leaf,
        is_active: cat.is_active,
      };
      node.children = buildCategoryTree(flat, cat.id as number);
      nodes.push(node);
    }
  }
  return nodes;
}

// GET /api/v1/spec/categories（main.py:2582-2595）
app.get("/api/v1/spec/categories", (c) => respond(c, async () => {
  await requireUser(c);
  const payload = await withDb(getEnv(c), async (sql: Db) => {
    const rows = await sql.unsafe(
      "SELECT id, code, name, parent_id, path, level, industry_code,"
      + " sort_order, is_leaf, is_active"
      + " FROM product_categories WHERE is_active = TRUE"
      + " ORDER BY sort_order, id");
    return { items: buildCategoryTree(rowsOut(rows as Row[])) };
  });
  return c.json(payload);
}));

// GET /api/v1/spec/categories/{category_id}（main.py:2598-2610）
// 注意：Python 未命中时返回 **200** + {"error": "not_found"}（历史形状，前端按此消费）。
app.get("/api/v1/spec/categories/:category_id", (c) => respond(c, async () => {
  await requireUser(c);
  const { category_id: categoryId } = parseQuery(idParam("category_id"), c.req.param(), "path");
  const payload = await withDb(getEnv(c), async (sql: Db) => {
    const rows = await sql.unsafe(
      "SELECT id, code, name, parent_id, path, level, industry_code, is_leaf"
      + " FROM product_categories WHERE id = $1", [categoryId]);
    const row = rows[0] as Row | undefined;
    if (!row) return { error: "not_found" };
    return rowOut(row);
  });
  return c.json(payload);
}));

// GET /api/v1/spec/categories/{category_id}/bindings（main.py:2613-2667）
app.get("/api/v1/spec/categories/:category_id/bindings", (c) => respond(c, async () => {
  await requireUser(c);
  const { category_id: categoryId } = parseQuery(idParam("category_id"), c.req.param(), "path");
  const payload = await withDb(getEnv(c), async (sql: Db) => {
    const rows = await sql.unsafe(
      "SELECT b.id AS binding_id, b.attr_role, b.is_required, b.is_locked,"
      + " b.sort_order, b.group_code,"
      + " a.id AS attr_id, a.code, a.name, a.data_type,"
      + " a.group_code AS attr_group, a.scope, a.unit, a.unit_group,"
      + " a.number_min, a.number_max, a.number_step"
      + " FROM category_attribute_bindings b"
      + " JOIN spec_attributes a ON a.id = b.attribute_id"
      + " WHERE b.category_id = $1"
      + "   AND (a.scope = 'global' OR a.tenant_id = $2)"
      + "   AND a.status = 'active'"
      + " ORDER BY b.sort_order, b.id",
      [categoryId, DEFAULT_TENANT]);
    const items: Row[] = [];
    for (const row of rows as Row[]) {
      const values = await sql.unsafe(
        "SELECT id, value_code AS code, value_label AS label"
        + " FROM spec_attribute_values"
        + " WHERE attribute_id = $1"
        + "   AND (scope = 'global' OR tenant_id = $2)"
        + "   AND status = 'active'"
        + " ORDER BY sort_order, id",
        [row.attr_id, DEFAULT_TENANT]);
      items.push({
        binding_id: row.binding_id,
        attr_role: row.attr_role,
        is_required: bool(row.is_required),
        is_locked: bool(row.is_locked),
        sort_order: row.sort_order,
        group_code: row.group_code,
        attribute: {
          id: row.attr_id,
          code: row.code,
          name: row.name,
          data_type: row.data_type,
          group_code: row.attr_group,
          scope: row.scope,
          unit: row.unit,
          unit_group: row.unit_group,
          number_min: row.number_min === null || row.number_min === undefined ? null : Number(row.number_min),
          number_max: row.number_max === null || row.number_max === undefined ? null : Number(row.number_max),
          number_step: row.number_step === null || row.number_step === undefined ? null : Number(row.number_step),
          values: (values as Row[]).map((value) => ({
            id: value.id, code: value.code, label: value.label,
          })),
        },
      });
    }
    return { items };
  });
  return c.json(payload);
}));

// ══════════════════════════════════════════════════════════════════════════════
// 企业抬头 / 收款信息（main.py:4833-4911）
// ══════════════════════════════════════════════════════════════════════════════

/** main.py:4833-4835 _COMPANY_FIELDS（列顺序即 INSERT 列序，必须与内核逐项一致）。 */
const COMPANY_FIELDS = [
  "name_en", "name_zh", "address_en", "address_zh", "phone", "email",
  "website", "bank_name", "bank_account", "swift_code", "logo_url",
  "default_incoterm", "default_payment_terms", "default_country_of_origin",
  "tax_id", "bank_name_zh", "bank_address_en", "bank_address_zh",
] as const;

/** company_rules.py:15-31 normalize_swift（逐字直译：空→None，合法→大写）。 */
const SWIFT_RE = /^[A-Z0-9]{8}([A-Z0-9]{3})?$/;

function normalizeSwift(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim().toUpperCase().replace(/ /g, "");
  if (!text) return null;
  if (!SWIFT_RE.test(text)) {
    throw httpError(422, {
      error: "validation", code: "INVALID_SWIFT",
      detail: "SWIFT 编码必须是 8 位或 11 位字母/数字（如 BKCHCNBJ 或 BKCHCNBJ220）",
    });
  }
  return text;
}

/** company_rules.py normalize_tax_id（冻结契约）：空→None，非空 6–32 位字母/数字→大写。 */
const TAX_ID_RE = /^[0-9A-Z]{6,32}$/;

function normalizeTaxId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim().toUpperCase();
  if (!text) return null;
  if (!TAX_ID_RE.test(text)) {
    throw httpError(422, {
      error: "validation", code: "INVALID_TAX_ID",
      detail: "税号必须是 6–32 位字母/数字（统一社会信用代码 18 位）",
    });
  }
  return text;
}

/** main.py:4838-4858 _require_team_admin（团队管理员或平台管理员）。 */
async function requireTeamAdmin(sql: Db, user: CurrentUser): Promise<void> {
  if (isAdminRole(user.role)) return;
  const denied = httpError(403, {
    error: "forbidden", code: "TEAM_ADMIN_REQUIRED",
    detail: "仅团队管理员可修改企业抬头/收款信息/公章",
  });
  if (user.team_id === null) throw denied;
  const rows = await sql.unsafe("SELECT created_by FROM teams WHERE id=$1", [user.team_id]);
  const row = rows[0] as Row | undefined;
  if (!row || !isTeamAdmin(row.created_by, user.id, user.role)) throw denied;
}

function companyProfileOut(row: Row | undefined): Row {
  if (!row) {
    const empty: Row = {};
    for (const field of COMPANY_FIELDS) empty[field] = null;
    empty.configured = false;
    return empty;
  }
  const out: Row = {};
  for (const field of COMPANY_FIELDS) out[field] = pyIso(row[field] ?? null);
  out.configured = Boolean(row.name_en);
  return out;
}

// GET /api/v1/tenant/company-profile（main.py:4863-4873）
app.get("/api/v1/tenant/company-profile", (c) => respond(c, async () => {
  await requireUser(c);
  const payload = await withDb(getEnv(c), async (sql: Db) => {
    const rows = await sql.unsafe(
      "SELECT * FROM tenant_company_profile WHERE tenant_id=$1", [DEFAULT_TENANT]);
    return companyProfileOut(rows[0] as Row | undefined);
  });
  return c.json(payload);
}));

// PUT /api/v1/tenant/company-profile（main.py:4876-4911）
app.put("/api/v1/tenant/company-profile", (c) => respond(c, async () => {
  const user = await requireUser(c);
  const body = await parseBody(c, z.record(z.string(), z.any()));
  const nameEn = String(body.name_en ?? "").trim();
  if (!nameEn) {
    throw httpError(422, {
      error: "validation", code: "NAME_EN_REQUIRED",
      detail: "英文公司名必填（对外单据的卖方主体名）",
    });
  }
  const payload = await withDb(getEnv(c), async (sql: Db) => {
    await requireTeamAdmin(sql, user);
    const swiftCode = normalizeSwift(body.swift_code);
    const taxId = normalizeTaxId(body.tax_id);
    const values = COMPANY_FIELDS.map((field) => {
      if (field === "swift_code") return swiftCode;
      if (field === "tax_id") return taxId;
      if (field === "name_en") return nameEn;
      return body[field] ?? null;
    });
    const placeholders = COMPANY_FIELDS.map((_field, index) => "$" + String(index + 2));
    const updates = COMPANY_FIELDS.map((field) => field + "=EXCLUDED." + field);
    await sql.unsafe(
      "INSERT INTO tenant_company_profile (tenant_id, " + COMPANY_FIELDS.join(", ") + ")"
      + " VALUES ($1, " + placeholders.join(", ") + ")"
      + " ON CONFLICT (tenant_id) DO UPDATE SET " + updates.join(", ") + ", updated_at=now()",
      [DEFAULT_TENANT, ...values]);
    const rows = await sql.unsafe(
      "SELECT * FROM tenant_company_profile WHERE tenant_id=$1", [DEFAULT_TENANT]);
    return companyProfileOut(rows[0] as Row | undefined);
  });
  return c.json(payload);
}));

// ══════════════════════════════════════════════════════════════════════════════
// 租户产品 / 工位启停矩阵（ws_products.py:180-556）
// ══════════════════════════════════════════════════════════════════════════════

/** 报价工位订阅编码（ws_products.py:52）。 */
const QUOTE_SUB_CODES = ["full_chain", "quotes"];

/** ws_products.py:69-73 _tenant_of（单租户部署回落到 default）。 */
function tenantOf(user: CurrentUser): string {
  const tid = user.tenant_id;
  return typeof tid === "string" && tid ? tid : DEFAULT_TENANT;
}

/** ws_products.py:148-177 _require_quote_subscription（团队 ∪ 历史租户级订阅）。 */
async function requireQuoteSubscription(sql: Db, user: CurrentUser): Promise<void> {
  const rows = await sql.unsafe(
    "SELECT 1 AS ok FROM ("
    + "  SELECT 1 FROM team_subscriptions"
    + "   WHERE team_id=$1 AND code=ANY($2) AND " + LIVE_SUB
    + "  UNION ALL"
    + "  SELECT 1 FROM tenant_subscriptions"
    + "   WHERE tenant_id=$3 AND code=ANY($2) AND active=true"
    + ") AS live LIMIT 1",
    [user.team_id, QUOTE_SUB_CODES, DEFAULT_TENANT]);
  if (rows.length === 0) {
    throw httpError(404, {
      error: "not_found", code: "SUBSCRIPTION_REQUIRED",
      workstation: "quote", required_any: QUOTE_SUB_CODES,
      detail: "未订阅该工位，请先开通对应订阅编码",
    });
  }
}

/** ws_products.py:180-204 _product_out（字段与默认值逐条对齐）。 */
function productOut(row: Row): Row {
  return {
    id: num(row.id),
    product_key: row.product_key,
    product_name: row.product_name,
    product_name_en: row.product_name_en,
    category_code: row.category_code,
    cost_field: row.cost_field || "raw_price",
    cost_basis: row.cost_basis || "pretax",
    cost_unit: row.cost_unit,
    profit_mode: row.profit_mode || "margin_on_price",
    profit_value: row.profit_value === null || row.profit_value === undefined ? 0.06 : Number(row.profit_value),
    misc_fee_rate: row.misc_fee_rate === null || row.misc_fee_rate === undefined ? 0.03 : Number(row.misc_fee_rate),
    spec: safeJsonMaybe(row.spec) ?? {},
    is_system: bool(row.is_system),
    is_active: bool(row.is_active),
    created_at: pyIso(row.created_at),
  };
}

/** ws_products.py:415-422 _matrix_rows（系统级 + 本租户启用中的产品）。 */
async function matrixRows(sql: Db, tenantId: string): Promise<Row[]> {
  return await sql.unsafe(
    "SELECT product_key, product_name, is_system FROM tenant_products"
    + " WHERE is_system = true"
    + "    OR (tenant_id = $1 AND is_system = false AND is_active = true)"
    + " ORDER BY is_system DESC, product_key",
    [tenantId]) as Row[];
}

/** 可选布尔查询参数（FastAPI 口径：true/1/yes/on / false/0/no/off）。 */
const optionalBoolQuery = z.preprocess((value) => {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "boolean") return value;
  const text = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "on", "t"].includes(text)) return true;
  if (["false", "0", "no", "off", "f"].includes(text)) return false;
  return value;
}, z.boolean().nullable());

// GET /api/v1/tenant-products（ws_products.py:233-266）
const tenantProductsQuery = z.object({
  tenant_id: z.string().nullish(),
  is_active: optionalBoolQuery,
  limit: z.coerce.number().int().min(1).max(500).default(50),
});

app.get("/api/v1/tenant-products", (c) => respond(c, async () => {
  const user = await requireUser(c);
  const query = parseQuery(tenantProductsQuery, queries(c));
  const tenantId = query.tenant_id || tenantOf(user);
  const conds: string[] = ["(tenant_id = $1 OR is_system = true)"];
  const params: unknown[] = [tenantId];
  if (!isAdminRole(user.role)) {
    if (user.team_id === null) {
      conds.push("(is_system = true OR team_id IS NULL)");
    } else {
      params.push(user.team_id);
      conds.push("(is_system = true OR team_id = $" + String(params.length) + ")");
    }
  }
  if (query.is_active !== null && query.is_active !== undefined) {
    params.push(query.is_active);
    conds.push("is_active = $" + String(params.length));
  }
  params.push(query.limit ?? 50);
  const payload = await withDb(getEnv(c), async (sql: Db) => {
    const rows = await sql.unsafe(
      "SELECT * FROM tenant_products WHERE " + conds.join(" AND ")
      + " ORDER BY created_at DESC LIMIT $" + String(params.length), params);
    return (rows as Row[]).map(productOut);
  });
  return c.json(payload);
}));

// GET /api/v1/workstation-products（ws_products.py:426-455）
const workstationQuery = z.object({ workstation: z.string().default("quote") });

app.get("/api/v1/workstation-products", (c) => respond(c, async () => {
  const user = await requireUser(c);
  const query = parseQuery(workstationQuery, queries(c));
  const workstation = query.workstation ?? "quote";
  const tenantId = tenantOf(user);
  const payload = await withDb(getEnv(c), async (sql: Db) => {
    await requireQuoteSubscription(sql, user);
    const products = await matrixRows(sql, tenantId);
    const enabledRows = await sql.unsafe(
      "SELECT product_key, is_enabled FROM tenant_workstation_products"
      + " WHERE tenant_id=$1 AND workstation=$2", [tenantId, workstation]);
    const enabledMap = new Map<string, boolean>();
    for (const row of enabledRows as Row[]) {
      enabledMap.set(String(row.product_key), bool(row.is_enabled));
    }
    return products.map((product) => ({
      product_key: product.product_key,
      product_name: product.product_name,
      is_system: bool(product.is_system),
      // 未显式登记过的产品默认「启用」（orchestrator: enabled_map.get(key, True)）
      is_enabled: enabledMap.get(String(product.product_key)) ?? true,
    }));
  });
  return c.json(payload);
}));

// POST /api/v1/workstation-products（ws_products.py:458-493，201）
app.post("/api/v1/workstation-products", (c) => respond(c, async () => {
  const user = await requireUser(c);
  const body = await parseBody(c, ws_products_WorkstationProductIn);
  const query = parseQuery(workstationQuery, queries(c));
  const workstation = query.workstation ?? "quote";
  const tenantId = tenantOf(user);
  const payload = await withDb(getEnv(c), async (sql: Db) => {
    await requireQuoteSubscription(sql, user);
    const products = await sql.unsafe(
      "SELECT product_key, product_name, is_system FROM tenant_products"
      + " WHERE product_key=$1 AND (tenant_id=$2 OR is_system = true)"
      + " ORDER BY is_system DESC LIMIT 1", [body.product_key, tenantId]);
    const product = products[0] as Row | undefined;
    if (!product) {
      throw httpError(404, { error: "not_found", code: "PRODUCT_NOT_FOUND" });
    }
    const rows = await sql.unsafe(
      "INSERT INTO tenant_workstation_products"
      + " (tenant_id, team_id, workstation, product_key, is_enabled)"
      + " VALUES ($1,$2,$3,$4,$5)"
      + " ON CONFLICT (tenant_id, (COALESCE(team_id, 0)), workstation, product_key)"
      + " DO UPDATE SET is_enabled = EXCLUDED.is_enabled, updated_at = now()"
      + " RETURNING product_key, is_enabled",
      [tenantId, user.team_id, workstation, body.product_key, body.is_enabled]);
    const row = rows[0] as Row;
    return {
      product_key: row.product_key,
      product_name: product.product_name,
      is_system: bool(product.is_system),
      is_enabled: bool(row.is_enabled),
    };
  });
  return c.json(payload, 201);
}));

// GET /api/v1/tenant-product-status（ws_products.py:502-522）
app.get("/api/v1/tenant-product-status", (c) => respond(c, async () => {
  const user = await requireUser(c);
  const query = parseQuery(workstationQuery, queries(c));
  const workstation = query.workstation ?? "quote";
  const tenantId = tenantOf(user);
  const team = user.team_id;
  const teamSql = team === null ? "team_id IS NULL" : "(team_id IS NULL OR team_id=$3)";
  const args: unknown[] = [tenantId, workstation];
  if (team !== null) args.push(team);
  const payload = await withDb(getEnv(c), async (sql: Db) => {
    const rows = await sql.unsafe(
      "SELECT product_key, is_enabled FROM tenant_workstation_products"
      + " WHERE tenant_id=$1 AND workstation=$2 AND " + teamSql, args);
    return {
      items: (rows as Row[]).map((row) => ({
        product_key: row.product_key, is_enabled: bool(row.is_enabled),
      })),
    };
  });
  return c.json(payload);
}));

// POST /api/v1/tenant-product-status（ws_products.py:525-556）
app.post("/api/v1/tenant-product-status", (c) => respond(c, async () => {
  const user = await requireUser(c);
  const body = await parseBody(c, ws_products__TenantProductStatusIn);
  const query = parseQuery(workstationQuery, queries(c));
  const workstation = query.workstation ?? "quote";
  const tenantId = tenantOf(user);
  const payload = await withDb(getEnv(c), async (sql: Db) => {
    const products = await sql.unsafe(
      "SELECT product_key, product_name, is_system FROM tenant_products"
      + " WHERE product_key=$1 AND (tenant_id=$2 OR is_system = true)"
      + " ORDER BY is_system DESC LIMIT 1", [body.product_key, tenantId]);
    const product = products[0] as Row | undefined;
    if (!product) {
      throw httpError(404, { error: "not_found", code: "PRODUCT_NOT_FOUND" });
    }
    const rows = await sql.unsafe(
      "INSERT INTO tenant_workstation_products"
      + " (tenant_id, team_id, workstation, product_key, is_enabled)"
      + " VALUES ($1,$2,$3,$4,$5)"
      + " ON CONFLICT (tenant_id, (COALESCE(team_id, 0)), workstation, product_key)"
      + " DO UPDATE SET is_enabled = EXCLUDED.is_enabled, updated_at = now()"
      + " RETURNING product_key, is_enabled",
      [tenantId, user.team_id, workstation, body.product_key, body.is_enabled]);
    const row = rows[0] as Row;
    return {
      product_key: row.product_key,
      product_name: product.product_name,
      is_system: bool(product.is_system),
      is_enabled: bool(row.is_enabled),
    };
  });
  return c.json(payload);
}));

// ══════════════════════════════════════════════════════════════════════════════
// 内核透传（18 条）
// ══════════════════════════════════════════════════════════════════════════════

// 租户产品写侧（ws_products.py:269-409）：spec 深校验 / spec_fingerprint 在报价引擎。
app.post("/api/v1/tenant-products", (c) => respond(c, async () => {
  await requireUser(c);
  return forwardToKernel(c);
}));
app.put("/api/v1/tenant-products/:product_id", (c) => respond(c, async () => {
  await requireUser(c);
  return forwardToKernel(c);
}));
app.delete("/api/v1/tenant-products/:product_id", (c) => respond(c, async () => {
  await requireUser(c);
  return forwardToKernel(c);
}));

// 产品注册表 / 产品档案 / 产品图（ws_files.py:378-495）—— ProductSpec 注册表在引擎。
app.get("/api/v1/products", (c) => respond(c, async () => {
  await requireUser(c);
  return forwardToKernel(c);
}));
app.get("/api/v1/products/:product_key/profile", (c) => respond(c, async () => {
  await requireUser(c);
  return forwardToKernel(c);
}));
app.put("/api/v1/products/:product_key/profile", (c) => respond(c, async () => {
  await requireUser(c);
  return forwardToKernel(c);
}));
app.get("/api/v1/products/:product_key/media", (c) => respond(c, async () => {
  await requireUser(c);
  return forwardToKernel(c);
}));
app.post("/api/v1/products/:product_key/media", (c) => respond(c, async () => {
  await requireUser(c);
  return forwardToKernel(c);
}));

// 团队档位覆盖（ws_option_overrides.py:169-266）—— apply_option_overrides 在引擎。
app.get("/api/v1/product-options/overrides", (c) => respond(c, async () => {
  await requireUser(c);
  return forwardToKernel(c);
}));
app.put("/api/v1/product-options/overrides", (c) => respond(c, async () => {
  await requireUser(c);
  return forwardToKernel(c);
}));

// 规格向导（main.py:2671-2780）—— _compute_sku_hash / _upsert_price 价格生命周期、
// propose-attribute 的 difflib.get_close_matches 近似名建议都在引擎/内核实现。
app.post("/api/v1/spec/wizard/submit", (c) => respond(c, async () => {
  await requireUser(c);
  return forwardToKernel(c);
}));
app.post("/api/v1/spec/wizard/propose-attribute", (c) => respond(c, async () => {
  await requireUser(c);
  return forwardToKernel(c);
}));

// 公章（ws_seals.py:125-330）—— PNG IHDR 校验（kaas_common.trade_doc.png）、
// R2/blob 存储与 render-content 的令牌签名都不在门面重写。
app.post("/api/v1/tenant/company-seals", (c) => respond(c, async () => {
  await requireUser(c);
  return forwardToKernel(c);
}));
app.get("/api/v1/tenant/company-seals", (c) => respond(c, async () => {
  await requireUser(c);
  return forwardToKernel(c);
}));
app.get("/api/v1/tenant/company-seals/:seal_id/image", (c) => respond(c, async () => {
  await requireUser(c);
  return forwardToKernel(c);
}));
// render-content 在 Python 侧**不挂 _get_current_user**（走令牌校验，ws_seals.py:239）：
// 门面保持同一口径，不做门面鉴权、原样转发由内核裁决。
app.get("/api/v1/tenant/company-seals/:seal_id/render-content", (c) => respond(c, async () => forwardToKernel(c)));
app.put("/api/v1/tenant/company-seals/:seal_id/default", (c) => respond(c, async () => {
  await requireUser(c);
  return forwardToKernel(c);
}));
app.delete("/api/v1/tenant/company-seals/:seal_id", (c) => respond(c, async () => {
  await requireUser(c);
  return forwardToKernel(c);
}));

export default app;
