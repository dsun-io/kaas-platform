/**
 * KaaS TS 门面 · intel 域（37 条路由：37 = 29 门面移植 + 8 内核透传）。
 *
 * 真源逐条对齐：
 * - backend/worker/src/chain.py:761-2432（leadgen / leads / research）
 * - backend/worker/src/main.py:946-1120（intel shipments / trade-stats / adapter-runs / channels）
 * - backend/worker/src/main.py:1962-2168（market 9 条）
 *
 * ── 移植口径（ADR-008 铁纪律）──────────────────────────────────────────────
 * · **门面移植**（26 条）：只做鉴权 / zod 入参 / SQL 参数化直译 / 出参投影，
 *   不含任何业务判定；行投影对齐 dbjson.row_to_dict（jsonb 列 + iso 时间）。
 * · **内核透传**（8 条）：端点内部依赖**报价/抓取/AI 引擎**（run_ai_task、
 *   _run_pipeline、_crawl_one、_lead_indices 需求/空白指数），在 TS 重写即成
 *   "第二份实现" ⇒ 门面只鉴权后原样转发 KERNEL（见 src/proxy.ts:forwardKernelRequest）。
 *   透传清单：POST /leadgen/validate、POST /leadgen/runs、
 *   POST /leadgen/runs/from-csv、GET /leads、GET /leads/{id}、
 *   POST /leads/scan-replied、POST /leads/{id}/crawl、POST /leads/crawl-batch。
 *
 * SQL 风格：一律 sql.unsafe + 位置参数（$n），与 Python 侧 f-string + $n 逐条对照。
 * 订阅闸门 _require_sub（chain.py:234-250）是**同一份**判定：SUB_CODES 与
 * SELECT 1 FROM tenant_subscriptions 逐字直译（TODO(TODO:TS3) 换 KERNEL /internal/rules/*）。
 */
import { Hono, type Context } from "hono";
import { z } from "zod";

import { withDb, type Db } from "../db";
import { getEnv, type Env } from "../env";
import {
  chain_LeadCreate,
  chain_LeadPatch,
  chain_PickFromLeadgen,
  chain_ResearchCreate,
  chain_ResearchPatch,
  main_NameMappingCreate,
  main_NameMappingPatch,
  main_ShipmentCreate,
} from "../generated/schemas";
import { httpError, num, num0, parseBody, parseQuery, pyIso, respond } from "../http";
import { forwardKernelRequest } from "../proxy";
import { requireUser } from "../session";

const app = new Hono<{ Bindings: Env }>();

const DEFAULT_TENANT = "default";

type Row = Record<string, unknown>;

// ── 行投影（dbjson.py:row_to_dict 直译）──────────────────────────────────────
// Python 侧 asyncpg 把 jsonb 返回成 str 需手动 loads；postgres.js 通常已解码成对象，
// 这里两种形态都兼容（字符串才解析），与 Python「非 JSON 字符串原样保留」同口径。
const JSONB_COLS: Record<string, readonly string[]> = {
  lead_candidates: ["fit_reasons", "raw", "spec_normalized"],
  leadgen_runs: ["config"],
  research_products: ["spec_normalized"],
  research_runs: ["config"],
  market_ports: ["suitable_cargo", "suitable_shipping_modes", "connected_corridors", "major_carriers"],
};

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** BIGINT 主键：postgres.js 返回 string，Python asyncpg 返回 int。 */
const INT_ID_RE = /^-?[0-9]+$/;

/**
 * 行 → API 形状：注册过的 jsonb 列解码 + 时间戳 isoformat（对齐 FastAPI 编码器）。
 * 主键 id 归一成 number（BIGINT 在 postgres.js 下是 string，见 http.ts:num 的注释）；
 * 其余 *_id 列**保持原样** —— 有些是 Text 列（如 lead_candidates.owner_id 存 "7"），
 * Python 侧同样是字符串，不能一律数字化。
 */
function rowOut(row: Row, table?: string): Row {
  const cols = table ? JSONB_COLS[table] ?? [] : [];
  const out: Row = {};
  for (const [key, value] of Object.entries(row)) {
    if (cols.includes(key) && typeof value === "string") {
      out[key] = safeJson(value);
    } else if (key === "id" && typeof value === "string" && INT_ID_RE.test(value)) {
      out[key] = Number(value);
    } else {
      out[key] = pyIso(value);
    }
  }
  return out;
}

function rowsOut(rows: Row[], table?: string): Row[] {
  return rows.map((row) => rowOut(row, table));
}

// ── 订阅闸门（chain.py:234-250 逐字直译）────────────────────────────────────
const SUB_CODES: Record<string, string[]> = {
  leadgen: ["leadgen_starter", "leadgen_pro", "full_chain"],
  outreach: ["outreach_starter", "outreach_pro", "full_chain"],
  intel: ["intel_trade_starter", "intel_full", "full_chain"],
  research: ["intel_research_starter", "intel_full", "full_chain"],
};

/** 工位订阅闸门：未开通 → 404（不暴露工位存在性，与 Python 同语义）。 */
async function requireSub(sql: Db, workstation: string): Promise<void> {
  const codes = SUB_CODES[workstation] ?? [];
  const rows = await sql.unsafe(
    "SELECT 1 AS ok FROM tenant_subscriptions"
    + " WHERE tenant_id=$1 AND code = ANY($2) AND active=true LIMIT 1",
    [DEFAULT_TENANT, codes],
  );
  if (rows.length === 0) {
    throw httpError(404, {
      error: "subscription_required", code: "SUBSCRIPTION_REQUIRED",
      workstation, codes,
    });
  }
}

// ── 配置指纹（Python hashlib.sha256(repr(sorted(cfg.items()))).hexdigest()[:32]）──
async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  let hex = "";
  for (const byte of new Uint8Array(digest)) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

/** 手工 place_id：manual-<sha256(company_name)[:16]>（chain.py:1376）。 */
async function manualPlaceId(companyName: string): Promise<string> {
  return "manual-" + (await sha256Hex(companyName)).slice(0, 16);
}

/** pick 动作的 config 指纹原文（Python repr(sorted(dict.items()))，逐字对齐）。 */
function pickConfigRepr(sourceRef: number | null): string {
  return "[('action', 'pick'), ('source_ref', " + (sourceRef === null ? "None" : String(sourceRef)) + ")]";
}

/** from_leadgen 动作的 config 指纹原文（lead_ids 已排序）。 */
function fromLeadgenConfigRepr(leadIds: number[]): string {
  return "[('action', 'from_leadgen'), ('lead_ids', [" + [...leadIds].sort((a, b) => a - b).join(", ") + "])]";
}

// ── 内核透传（引擎端点；禁止在门面重写引擎逻辑）──────────────────────────────
// 实现统一在 src/proxy.ts:forwardKernelRequest（单份；本文件不再复制）。
type AppEnv = { Bindings: Env };

// ── 复用的入参 schema（查询参数无 pydantic 真源，按 Python Query(...) 约束手写）──
const pageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(20),
});

/** 查询参数压平（c.req.queries() 给的是 string[]；FastAPI 单值参数取首个值）。 */
function queries(c: Context<AppEnv>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, values] of Object.entries(c.req.queries())) {
    const first = values[0];
    if (first !== undefined) out[key] = first;
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════════════════
// leadgen（chain.py:761-1064）
// ══════════════════════════════════════════════════════════════════════════════

/** 区域字典（chain.py:761-769，数据常量逐字镜像）。 */
const REGIONS = [
  { code: "US-TX", name: "Texas, USA" },
  { code: "US-CA", name: "California, USA" },
  { code: "US-FL", name: "Florida, USA" },
  { code: "US-NY", name: "New York, USA" },
  { code: "CA-ON", name: "Ontario, Canada" },
  { code: "AU-NSW", name: "NSW, Australia" },
  { code: "GB-ENG", name: "England, UK" },
  { code: "DE-NW", name: "NRW, Germany" },
  { code: "FR-IDF", name: "Île-de-France, France" },
  { code: "AE-DU", name: "Dubai, UAE" },
  { code: "SA-RD", name: "Riyadh, Saudi Arabia" },
  { code: "ZA-GP", name: "Gauteng, South Africa" },
  { code: "BR-SP", name: "São Paulo, Brazil" },
  { code: "MX-CMX", name: "CDMX, Mexico" },
];

// GET /api/v1/leadgen/regions（chain.py:973-975）
app.get("/api/v1/leadgen/regions", (c) => respond(c, async () => {
  await requireUser(c);
  return c.json({ items: REGIONS.map((region) => region.code), regions: REGIONS });
}));

// POST /api/v1/leadgen/validate（chain.py:978-983）→ 透传：run_ai_task(config_validation)
app.post("/api/v1/leadgen/validate", (c) => respond(c, async () => {
  await requireUser(c);
  return forwardKernelRequest(c);
}));

// POST /api/v1/leadgen/runs（chain.py:1018-1021）→ 透传：_run_pipeline（抓取 + AI 打分）
app.post("/api/v1/leadgen/runs", (c) => respond(c, async () => {
  await requireUser(c);
  return forwardKernelRequest(c);
}));

// POST /api/v1/leadgen/runs/from-csv（chain.py:1024-1030）→ 透传：同上（CSV 源）
app.post("/api/v1/leadgen/runs/from-csv", (c) => respond(c, async () => {
  await requireUser(c);
  return forwardKernelRequest(c);
}));

// GET /api/v1/leadgen/runs（chain.py:1033-1047）
app.get("/api/v1/leadgen/runs", (c) => respond(c, async () => {
  await requireUser(c);
  const query = parseQuery(pageQuery, queries(c));
  const page = query.page ?? 1;
  const pageSize = query.page_size ?? 20;
  const payload = await withDb(getEnv(c), async (sql: Db) => {
    await requireSub(sql, "leadgen");
    const totalRows = await sql.unsafe(
      "SELECT COUNT(*) AS n FROM leadgen_runs WHERE tenant_id=$1", [DEFAULT_TENANT]);
    const rows = await sql.unsafe(
      "SELECT id, config, config_hash, status, leads_found, leads_kept,"
      + " error, started_at, finished_at, created_by, created_at"
      + " FROM leadgen_runs WHERE tenant_id=$1"
      + " ORDER BY id DESC LIMIT $2 OFFSET $3",
      [DEFAULT_TENANT, pageSize, (page - 1) * pageSize],
    );
    return {
      items: rowsOut(rows as Row[], "leadgen_runs"),
      total: num0(totalRows[0]?.n),
      page,
      page_size: pageSize,
    };
  });
  return c.json(payload);
}));

// GET /api/v1/leadgen/runs/{run_id}（chain.py:1050-1064）
const idParam = (name: string) => z.object({ [name]: z.coerce.number().int() });

app.get("/api/v1/leadgen/runs/:run_id", (c) => respond(c, async () => {
  await requireUser(c);
  const { run_id: runId } = parseQuery(idParam("run_id"), c.req.param(), "path");
  const payload = await withDb(getEnv(c), async (sql: Db) => {
    await requireSub(sql, "leadgen");
    const runs = await sql.unsafe(
      "SELECT * FROM leadgen_runs WHERE id=$1 AND tenant_id=$2", [runId, DEFAULT_TENANT]);
    const run = runs[0] as Row | undefined;
    if (!run) {
      throw httpError(404, { error: "not_found", code: "RUN_NOT_FOUND" });
    }
    const leads = await sql.unsafe(
      "SELECT id, place_id, company_name, country, city, fit_score, created_at"
      + " FROM lead_candidates WHERE leadgen_run_id=$1 ORDER BY fit_score DESC NULLS LAST",
      [runId],
    );
    return { ...rowOut(run, "leadgen_runs"), leads: rowsOut(leads as Row[]) };
  });
  return c.json(payload);
}));

// ══════════════════════════════════════════════════════════════════════════════
// leads（chain.py:1335-1580）
// ══════════════════════════════════════════════════════════════════════════════

/** chain.py:_row_to_lead —— raw 一律剔除；需求/空白指数由内核链路提供（透传端点）。 */
function rowToLead(row: Row): Row {
  const data = rowOut(row, "lead_candidates");
  delete data.raw;
  data.demand_index = null;
  data.blank_index = null;
  return data;
}

// POST /api/v1/leads（chain.py:1370-1399，201）
app.post("/api/v1/leads", (c) => respond(c, async () => {
  const user = await requireUser(c);
  const body = await parseBody(c, chain_LeadCreate);
  const payload = await withDb(getEnv(c), async (sql: Db) => {
    await requireSub(sql, "leadgen");
    const placeId = body.place_id || (await manualPlaceId(body.company_name));
    const existing = await sql.unsafe(
      "SELECT id FROM lead_candidates WHERE tenant_id=$1 AND place_id=$2",
      [DEFAULT_TENANT, placeId],
    );
    if (existing.length > 0) {
      throw httpError(409, { error: "conflict", code: "DUPLICATE_PLACE" });
    }
    const rows = await sql.unsafe(
      "INSERT INTO lead_candidates"
      + " (tenant_id, place_id, company_name, country, region, city, address,"
      + "  phone, website, email, industry, source, opening_line,"
      + "  shop_type, product_name, product_name_cn, product_image_url,"
      + "  spec_raw, link_url, can_supply, supply_notes, crawl_status,"
      + "  owner_id, owner_scope)"
      + " VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'manual',$12,"
      + "         $13,$14,$15,$16,$17,$18,$19,$20,'no_website',$21,'tenant')"
      + " RETURNING *",
      [DEFAULT_TENANT, placeId, body.company_name, body.country, body.region,
        body.city, body.address, body.phone, body.website, body.email,
        body.industry, body.opening_line, body.shop_type, body.product_name,
        body.product_name_cn, body.product_image_url, body.spec_raw, body.link_url,
        body.can_supply, body.supply_notes, String(user.id)],
    );
    return rowToLead(rows[0] as Row);
  });
  return c.json(payload, 201);
}));

// GET /api/v1/leads（chain.py:1402-1434）→ 透传：_lead_indices（需求/空白指数）
app.get("/api/v1/leads", (c) => respond(c, async () => {
  await requireUser(c);
  return forwardKernelRequest(c);
}));

// POST /api/v1/leads/scan-replied（chain.py:1437-1489）→ 透传：客户/询盘落库 + 编号规则
app.post("/api/v1/leads/scan-replied", (c) => respond(c, async () => {
  await requireUser(c);
  return forwardKernelRequest(c);
}));

// POST /api/v1/leads/crawl-batch（chain.py:2079-2111）→ 透传：_crawl_one（抓取 + 产品提取）
app.post("/api/v1/leads/crawl-batch", (c) => respond(c, async () => {
  await requireUser(c);
  return forwardKernelRequest(c);
}));

// GET /api/v1/leads/{lead_id}（chain.py:1489-1511）→ 透传：_lead_indices
app.get("/api/v1/leads/:lead_id", (c) => respond(c, async () => {
  await requireUser(c);
  return forwardKernelRequest(c);
}));

// POST /api/v1/leads/{lead_id}/crawl（chain.py:2054-2070）→ 透传：_crawl_one
app.post("/api/v1/leads/:lead_id/crawl", (c) => respond(c, async () => {
  await requireUser(c);
  return forwardKernelRequest(c);
}));

/** chain.py:_LEAD_PATCHABLE（可写列白名单，顺序即 Python 元组顺序）。 */
const LEAD_PATCHABLE = [
  "company_name", "email", "website", "phone", "industry",
  "fit_score", "opening_line", "owner_scope",
  "shop_type", "product_name", "product_name_cn",
  "product_image_url", "spec_raw", "link_url",
  "can_supply", "supply_notes",
];

// PATCH /api/v1/leads/{lead_id}（chain.py:1542-1579）
app.patch("/api/v1/leads/:lead_id", (c) => respond(c, async () => {
  await requireUser(c);
  const { lead_id: leadId } = parseQuery(idParam("lead_id"), c.req.param(), "path");
  const body = await parseBody(c, chain_LeadPatch);
  const fields = Object.fromEntries(
    Object.entries(body as Row).filter(([, value]) => value !== null && value !== undefined),
  ) as Record<string, unknown>;

  const payload = await withDb(getEnv(c), async (sql: Db) => {
    await requireSub(sql, "leadgen");
    const existing = await sql.unsafe(
      "SELECT * FROM lead_candidates WHERE id=$1 AND tenant_id=$2", [leadId, DEFAULT_TENANT]);
    const lead = existing[0] as Row | undefined;
    if (!lead) {
      throw httpError(404, { error: "not_found", code: "LEAD_NOT_FOUND" });
    }
    const sets: string[] = [];
    const params: unknown[] = [DEFAULT_TENANT, leadId];
    for (const key of LEAD_PATCHABLE) {
      if (key in fields) {
        params.push(fields[key]);
        sets.push(key + " = $" + String(params.length));
      }
    }
    if (fields.notes_raw !== null && fields.notes_raw !== undefined) {
      let rawValue = lead.raw;
      if (typeof rawValue === "string") {
        const parsed = safeJson(rawValue);
        rawValue = typeof parsed === "object" && parsed !== null ? parsed : {};
      }
      const base = (rawValue ?? {}) as Row;
      const merged = { ...base, ...(fields.notes_raw as Row) };
      params.push(JSON.stringify(merged));
      sets.push("raw = $" + String(params.length));
    }
    if (sets.length > 0) {
      await sql.unsafe(
        "UPDATE lead_candidates SET " + sets.join(", ") + ", updated_at=NOW()"
        + " WHERE tenant_id=$1 AND id=$2",
        params,
      );
    }
    const updated = await sql.unsafe(
      "SELECT * FROM lead_candidates WHERE id=$1 AND tenant_id=$2", [leadId, DEFAULT_TENANT]);
    return rowToLead(updated[0] as Row);
  });
  return c.json(payload);
}));

// ══════════════════════════════════════════════════════════════════════════════
// research（chain.py:2121-2433）
// ══════════════════════════════════════════════════════════════════════════════

/** 调研品类字典（chain.py:2121-2125，数据常量逐字镜像）。 */
const RESEARCH_CATEGORIES = [
  "chain_link_fence", "welded_mesh", "gabion", "temporary_fence",
  "security_fence", "farm_fence", "razor_wire", "hinge_joint_fence",
  "accessories", "other",
];

/** chain.py:_PICK_FIELDS（从线索挑选时回填的字段，顺序即 Python 元组顺序）。 */
const PICK_FIELDS = [
  "product_name", "product_name_cn", "product_image_url", "spec_raw",
  "spec_normalized", "country", "region", "city",
  "shop_name", "shop_type", "address", "phone", "email", "website",
  "link_url", "can_supply", "supply_notes", "source",
];

/** chain.py:ResearchPatch 字段顺序（model_fields 顺序，PATCH 的 UPDATE 列序）。 */
const RESEARCH_PATCH_FIELDS = [
  "product_name", "product_name_cn", "product_image_url", "spec_raw",
  "spec_normalized", "product_category", "country", "region", "city",
  "shop_name", "shop_type", "address", "phone", "email", "website",
  "link_url", "price_local", "price_currency", "market_note", "can_supply",
  "supply_notes", "research_status",
];

/** chain.py:_row_to_research */
function rowToResearch(row: Row): Row {
  return rowOut(row, "research_products");
}

/** chain.py:_insert_research（列由调用方白名单给出，值全部走位置参数）。 */
async function insertResearch(sql: Db, data: Row, ownerId: string): Promise<Row> {
  const cols = Object.keys(data);
  const placeholders = cols.map((_col, index) => "$" + String(index + 2));
  const values = cols.map((col) => {
    const value = data[col];
    // postgres.js 不接受 undefined 参数；Python 侧缺失列等价于 NULL
    if (value === undefined) return null;
    if (col === "spec_normalized" && value !== null) {
      return JSON.stringify(value);
    }
    return value;
  });
  const rows = await sql.unsafe(
    "INSERT INTO research_products"
    + " (tenant_id, " + cols.join(", ") + ", owner_id, owner_scope)"
    + " VALUES ($1, " + placeholders.join(", ") + ", $" + String(cols.length + 2) + ", 'tenant')"
    + " RETURNING *",
    [DEFAULT_TENANT, ...values, ownerId],
  );
  return rowToResearch(rows[0] as Row);
}

// GET /api/v1/research/categories（chain.py:2182-2184）
app.get("/api/v1/research/categories", (c) => respond(c, async () => {
  await requireUser(c);
  return c.json({ items: RESEARCH_CATEGORIES });
}));

// GET /api/v1/research/products（chain.py:2187-2226）
const researchListQuery = z.object({
  country: z.string().nullish(),
  city: z.string().nullish(),
  product_category: z.string().nullish(),
  can_supply: z.string().nullish(),
  research_status: z.string().nullish(),
  search: z.string().nullish(),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(200).default(20),
});

app.get("/api/v1/research/products", (c) => respond(c, async () => {
  await requireUser(c);
  const query = parseQuery(researchListQuery, queries(c));
  const page = query.page ?? 1;
  const pageSize = query.page_size ?? 20;
  const where: string[] = ["tenant_id = $1"];
  const params: unknown[] = [DEFAULT_TENANT];
  for (const [col, value] of [
    ["country", query.country], ["city", query.city],
    ["product_category", query.product_category], ["research_status", query.research_status],
  ] as [string, string | null | undefined][]) {
    if (value) {
      params.push(value);
      where.push(col + " = $" + String(params.length));
    }
  }
  if (query.can_supply === "true") where.push("can_supply IS TRUE");
  else if (query.can_supply === "false") where.push("can_supply IS FALSE");
  else if (query.can_supply === "unknown") where.push("can_supply IS NULL");
  if (query.search) {
    params.push("%" + query.search + "%");
    const marker = "$" + String(params.length);
    where.push("(product_name ILIKE " + marker + " OR product_name_cn ILIKE " + marker
      + " OR shop_name ILIKE " + marker + ")");
  }
  const whereSql = where.join(" AND ");

  const payload = await withDb(getEnv(c), async (sql: Db) => {
    await requireSub(sql, "research");
    const totalRows = await sql.unsafe(
      "SELECT COUNT(*) AS n FROM research_products WHERE " + whereSql, params);
    const rows = await sql.unsafe(
      "SELECT * FROM research_products WHERE " + whereSql
      + " ORDER BY id DESC LIMIT $" + String(params.length + 1)
      + " OFFSET $" + String(params.length + 2),
      [...params, pageSize, (page - 1) * pageSize],
    );
    return {
      items: (rows as Row[]).map(rowToResearch),
      total: num0(totalRows[0]?.n),
      page,
      page_size: pageSize,
    };
  });
  return c.json(payload);
}));

// GET /api/v1/research/stats（chain.py:2229-2251）
app.get("/api/v1/research/stats", (c) => respond(c, async () => {
  await requireUser(c);
  const payload = await withDb(getEnv(c), async (sql: Db) => {
    await requireSub(sql, "research");
    const byCountry = await sql.unsafe(
      "SELECT country, COUNT(*) AS total,"
      + " COUNT(*) FILTER (WHERE can_supply IS TRUE) AS can_supply"
      + " FROM research_products WHERE tenant_id=$1 AND country IS NOT NULL"
      + " GROUP BY country ORDER BY total DESC LIMIT 50", [DEFAULT_TENANT]);
    const byCategory = await sql.unsafe(
      "SELECT COALESCE(product_category, 'unclassified') AS product_category,"
      + " COUNT(*) AS total"
      + " FROM research_products WHERE tenant_id=$1"
      + " GROUP BY 1 ORDER BY total DESC", [DEFAULT_TENANT]);
    const totalRows = await sql.unsafe(
      "SELECT COUNT(*) AS n FROM research_products WHERE tenant_id=$1", [DEFAULT_TENANT]);
    const supplyRows = await sql.unsafe(
      "SELECT COUNT(*) AS n FROM research_products"
      + " WHERE tenant_id=$1 AND can_supply IS TRUE", [DEFAULT_TENANT]);
    return {
      total: num0(totalRows[0]?.n),
      can_supply_yes: num0(supplyRows[0]?.n),
      by_country: (byCountry as Row[]).map((row) => ({
        ...row,
        total: num0(row.total),
        can_supply: num0(row.can_supply),
      })),
      by_category: (byCategory as Row[]).map((row) => ({
        ...row,
        total: num0(row.total),
      })),
    };
  });
  return c.json(payload);
}));

// POST /api/v1/research/products（chain.py:2254-2298，201）
app.post("/api/v1/research/products", (c) => respond(c, async () => {
  const user = await requireUser(c);
  const body = await parseBody(c, chain_ResearchCreate);
  const payload = await withDb(getEnv(c), async (sql: Db) => {
    await requireSub(sql, "research");
    const data = Object.fromEntries(
      Object.entries(body as Row).filter(([, value]) => value !== null && value !== undefined),
    ) as Row;
    const sourceRef = (data.source_ref as number | undefined) ?? null;
    delete data.source_ref;
    if (sourceRef !== null) {
      const existing = await sql.unsafe(
        "SELECT id FROM research_products WHERE tenant_id=$1 AND source_ref=$2",
        [DEFAULT_TENANT, sourceRef]);
      const duplicate = existing[0] as Row | undefined;
      if (duplicate) {
        throw httpError(409, {
          error: "conflict", code: "ALREADY_PICKED", research_id: num(duplicate.id),
        });
      }
      const leads = await sql.unsafe(
        "SELECT * FROM lead_candidates WHERE id=$1 AND tenant_id=$2", [sourceRef, DEFAULT_TENANT]);
      const lead = leads[0] as Row | undefined;
      if (!lead) {
        throw httpError(404, { error: "not_found", code: "LEAD_NOT_FOUND" });
      }
      for (const field of PICK_FIELDS) {
        if ((data[field] === undefined || data[field] === null) && lead[field] !== null && lead[field] !== undefined) {
          data[field] = lead[field];
        }
      }
      if (data.shop_name === undefined) {
        data.shop_name = lead.company_name ?? null;
      }
      data.source_ref = sourceRef;
      if (!data.source) {
        data.source = lead.source ?? null;
      }
    }
    const row = await insertResearch(sql, data, String(user.id));
    const configHash = (await sha256Hex(pickConfigRepr(sourceRef))).slice(0, 32);
    await sql.unsafe(
      "INSERT INTO research_runs"
      + " (tenant_id, config, config_hash, status, leads_scanned,"
      + "  products_found, products_kept, started_at, finished_at, created_by)"
      + " VALUES ($1,$2,$3,'succeeded',$4,1,1,NOW(),NOW(),$5)"
      + " ON CONFLICT (tenant_id, config_hash) DO NOTHING",
      [DEFAULT_TENANT, JSON.stringify({ action: "pick", source_ref: sourceRef }),
        configHash, sourceRef === null ? 0 : 1, String(user.id)]);
    return row;
  });
  return c.json(payload, 201);
}));

// PATCH /api/v1/research/products/{research_id}（chain.py:2326-2356）
app.patch("/api/v1/research/products/:research_id", (c) => respond(c, async () => {
  await requireUser(c);
  const { research_id: researchId } = parseQuery(idParam("research_id"), c.req.param(), "path");
  const body = await parseBody(c, chain_ResearchPatch);
  const fields = Object.fromEntries(
    Object.entries(body as Row).filter(([, value]) => value !== null && value !== undefined),
  ) as Row;
  const payload = await withDb(getEnv(c), async (sql: Db) => {
    await requireSub(sql, "research");
    const existing = await sql.unsafe(
      "SELECT * FROM research_products WHERE id=$1 AND tenant_id=$2",
      [researchId, DEFAULT_TENANT]);
    if (existing.length === 0) {
      throw httpError(404, { error: "not_found", code: "RESEARCH_NOT_FOUND" });
    }
    const sets: string[] = [];
    const params: unknown[] = [DEFAULT_TENANT, researchId];
    for (const key of RESEARCH_PATCH_FIELDS) {
      if (key in fields) {
        const value = key === "spec_normalized" && fields[key] !== null
          ? JSON.stringify(fields[key])
          : fields[key];
        params.push(value);
        sets.push(key + " = $" + String(params.length));
      }
    }
    if (sets.length > 0) {
      await sql.unsafe(
        "UPDATE research_products SET " + sets.join(", ") + ", updated_at=NOW()"
        + " WHERE tenant_id=$1 AND id=$2",
        params,
      );
    }
    const updated = await sql.unsafe(
      "SELECT * FROM research_products WHERE id=$1 AND tenant_id=$2",
      [researchId, DEFAULT_TENANT]);
    return rowToResearch(updated[0] as Row);
  });
  return c.json(payload);
}));

// DELETE /api/v1/research/products/{research_id}（chain.py:2359-2371）
app.delete("/api/v1/research/products/:research_id", (c) => respond(c, async () => {
  await requireUser(c);
  const { research_id: researchId } = parseQuery(idParam("research_id"), c.req.param(), "path");
  const payload = await withDb(getEnv(c), async (sql: Db) => {
    await requireSub(sql, "research");
    const rows = await sql.unsafe(
      "DELETE FROM research_products WHERE tenant_id=$1 AND id=$2 RETURNING id",
      [DEFAULT_TENANT, researchId]);
    const deleted = rows[0] as Row | undefined;
    if (!deleted) {
      throw httpError(404, { error: "not_found", code: "RESEARCH_NOT_FOUND" });
    }
    return { deleted: num(deleted.id) };
  });
  return c.json(payload);
}));

// POST /api/v1/research/from-leadgen（chain.py:2378-2417，201）
app.post("/api/v1/research/from-leadgen", (c) => respond(c, async () => {
  const user = await requireUser(c);
  const body = await parseBody(c, chain_PickFromLeadgen);
  if (body.lead_ids.length === 0) {
    throw httpError(422, { error: "validation", code: "EMPTY_SELECTION" });
  }
  const payload = await withDb(getEnv(c), async (sql: Db) => {
    await requireSub(sql, "research");
    const leads = await sql.unsafe(
      "SELECT * FROM lead_candidates WHERE tenant_id=$1 AND id = ANY($2)",
      [DEFAULT_TENANT, body.lead_ids]);
    const created: Row[] = [];
    let skipped = 0;
    for (const lead of leads as Row[]) {
      const duplicate = await sql.unsafe(
        "SELECT id FROM research_products WHERE tenant_id=$1 AND source_ref=$2",
        [DEFAULT_TENANT, lead.id]);
      if (duplicate.length > 0) {
        skipped += 1;
        continue;
      }
      const data: Row = {};
      for (const field of PICK_FIELDS) {
        if (lead[field] !== null && lead[field] !== undefined) {
          data[field] = lead[field];
        }
      }
      data.shop_name = lead.company_name ?? null;
      data.source_ref = lead.id;
      created.push(await insertResearch(sql, data, String(user.id)));
    }
    const sortedIds = [...body.lead_ids].sort((a, b) => a - b);
    const configHash = (await sha256Hex(fromLeadgenConfigRepr(body.lead_ids))).slice(0, 32);
    await sql.unsafe(
      "INSERT INTO research_runs"
      + " (tenant_id, config, config_hash, status, leads_scanned,"
      + "  products_found, products_kept, started_at, finished_at, created_by)"
      + " VALUES ($1,$2,$3,'succeeded',$4,$5,$6,NOW(),NOW(),$7)"
      + " ON CONFLICT (tenant_id, config_hash) DO NOTHING",
      [DEFAULT_TENANT, JSON.stringify({ action: "from_leadgen", lead_ids: sortedIds }),
        configHash, leads.length, leads.length, created.length, String(user.id)]);
    return { scanned: leads.length, created: created.length, skipped, items: created };
  });
  return c.json(payload, 201);
}));

// GET /api/v1/research/runs（chain.py:2420-2433）
app.get("/api/v1/research/runs", (c) => respond(c, async () => {
  await requireUser(c);
  const query = parseQuery(pageQuery, queries(c));
  const page = query.page ?? 1;
  const pageSize = query.page_size ?? 20;
  const payload = await withDb(getEnv(c), async (sql: Db) => {
    await requireSub(sql, "research");
    const totalRows = await sql.unsafe(
      "SELECT COUNT(*) AS n FROM research_runs WHERE tenant_id=$1", [DEFAULT_TENANT]);
    const rows = await sql.unsafe(
      "SELECT * FROM research_runs WHERE tenant_id=$1 ORDER BY id DESC LIMIT $2 OFFSET $3",
      [DEFAULT_TENANT, pageSize, (page - 1) * pageSize]);
    return {
      items: rowsOut(rows as Row[], "research_runs"),
      total: num0(totalRows[0]?.n),
      page,
      page_size: pageSize,
    };
  });
  return c.json(payload);
}));

// ══════════════════════════════════════════════════════════════════════════════
// intel（main.py:946-1120）
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/v1/intel/shipments（main.py:947-978）
const shipmentListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(20),
  shipper: z.string().nullish(),
  consignee: z.string().nullish(),
  dest_country: z.string().nullish(),
  hs_code: z.string().nullish(),
});

app.get("/api/v1/intel/shipments", (c) => respond(c, async () => {
  await requireUser(c);
  const query = parseQuery(shipmentListQuery, queries(c));
  const page = query.page ?? 1;
  const pageSize = query.page_size ?? 20;
  const where: string[] = ["tenant_id = $1"];
  const params: unknown[] = [DEFAULT_TENANT];
  for (const [col, value] of [
    ["shipper", query.shipper], ["consignee", query.consignee],
    ["dest_country", query.dest_country],
  ] as [string, string | null | undefined][]) {
    if (value) {
      params.push("%" + value + "%");
      where.push(col + " ILIKE $" + String(params.length));
    }
  }
  if (query.hs_code) {
    params.push(query.hs_code);
    where.push("hs_code = $" + String(params.length));
  }
  const whereSql = where.join(" AND ");

  const payload = await withDb(getEnv(c), async (sql: Db) => {
    const totalRows = await sql.unsafe(
      "SELECT COUNT(*) AS n FROM intel_shipments WHERE " + whereSql, params);
    const rows = await sql.unsafe(
      "SELECT * FROM intel_shipments WHERE " + whereSql
      + " ORDER BY created_at DESC LIMIT $" + String(params.length + 1)
      + " OFFSET $" + String(params.length + 2),
      [...params, pageSize, (page - 1) * pageSize]);
    return {
      items: rowsOut(rows as Row[]),
      total: num0(totalRows[0]?.n),
      page,
      page_size: pageSize,
    };
  });
  return c.json(payload);
}));

// GET /api/v1/intel/shipments/{shipment_id}（main.py:981-990）
app.get("/api/v1/intel/shipments/:shipment_id", (c) => respond(c, async () => {
  await requireUser(c);
  const { shipment_id: shipmentId } = parseQuery(idParam("shipment_id"), c.req.param(), "path");
  const payload = await withDb(getEnv(c), async (sql: Db) => {
    const rows = await sql.unsafe(
      "SELECT * FROM intel_shipments WHERE id=$1 AND tenant_id=$2", [shipmentId, DEFAULT_TENANT]);
    const row = rows[0] as Row | undefined;
    if (!row) {
      // 对齐 Python：detail 是字符串（不是对象信封）
      throw httpError(404, "Shipment not found");
    }
    return rowOut(row);
  });
  return c.json(payload);
}));

// POST /api/v1/intel/shipments（main.py:993-1005，201）
app.post("/api/v1/intel/shipments", (c) => respond(c, async () => {
  const user = await requireUser(c);
  const body = await parseBody(c, main_ShipmentCreate);
  const data = Object.fromEntries(
    Object.entries(body as Row).filter(([, value]) => value !== null && value !== undefined),
  ) as Row;
  const cols = Object.keys(data);
  const placeholders = cols.map((_col, index) => "$" + String(index + 3));
  const payload = await withDb(getEnv(c), async (sql: Db) => {
    const rows = await sql.unsafe(
      "INSERT INTO intel_shipments (tenant_id, created_by, " + cols.join(", ") + ")"
      + " VALUES ($1, $2, " + placeholders.join(", ") + ") RETURNING *",
      [DEFAULT_TENANT, String(user.id), ...cols.map((col) => data[col])]);
    return rowOut(rows[0] as Row);
  });
  return c.json(payload, 201);
}));

/** main.py:1016-1028 的列名映射（中英文表头 → 列名）。 */
const CSV_COL_MAP: Record<string, string> = {
  shipper: "shipper", 发货人: "shipper", exporter: "shipper",
  consignee: "consignee", 收货人: "consignee", importer: "consignee",
  product_desc: "product_desc", 产品描述: "product_desc", 产品: "product_desc", goods: "product_desc",
  ship_date: "ship_date", 日期: "ship_date", date: "ship_date",
  dest_country: "dest_country", 目的国: "dest_country", destination: "dest_country",
  origin_country: "origin_country", 原产国: "origin_country",
  hs_code: "hs_code", hs编码: "hs_code",
  qty: "qty", 数量: "qty",
  qty_unit: "qty_unit", 单位: "qty_unit",
  carrier: "carrier", 承运人: "carrier",
  bl_no: "bl_no", 提单号: "bl_no",
};

/** 最小 RFC4180 解析（对齐 Python csv.DictReader 的引号/转义语义）。 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index] as string;
    if (inQuotes) {
      if (ch === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// POST /api/v1/intel/import/csv（main.py:1008-1058）
app.post("/api/v1/intel/import/csv", (c) => respond(c, async () => {
  const user = await requireUser(c);
  let form: Record<string, unknown>;
  try {
    form = (await c.req.parseBody()) as Record<string, unknown>;
  } catch {
    throw httpError(422, [
      { type: "missing", loc: ["body", "file"], msg: "Field required", input: null },
    ]);
  }
  const file = form.file;
  if (!(file instanceof File)) {
    throw httpError(422, [
      { type: "missing", loc: ["body", "file"], msg: "Field required", input: null },
    ]);
  }
  const filename = file.name || "upload.csv";
  const text = (await file.text()).replace(/^\uFEFF/, "");
  const table = parseCsv(text);
  const header = table[0] ?? [];
  const dataRows = table.slice(1);

  let inserted = 0;
  let processed = 0;
  const errors: { row: number; error: string }[] = [];

  const payload = await withDb(getEnv(c), async (sql: Db) => {
    for (let index = 0; index < dataRows.length; index += 1) {
      const cells = dataRows[index] as string[];
      processed += 1;
      const csvRow = index + 2;
      try {
        const mapped: Row = {};
        for (let col = 0; col < header.length; col += 1) {
          const rawKey = header[col] ?? "";
          const rawValue = cells[col] ?? "";
          if (!rawKey || !rawValue) continue;
          const target = CSV_COL_MAP[rawKey.trim().toLowerCase()] ?? CSV_COL_MAP[rawKey.trim()];
          if (target) mapped[target] = rawValue.trim();
        }
        if (!("shipper" in mapped) || !("consignee" in mapped) || !("product_desc" in mapped)) {
          errors.push({ row: csvRow, error: "缺少必填字段 (shipper/consignee/product_desc)" });
          continue;
        }
        const cols = Object.keys(mapped);
        const placeholders = cols.map((_col, position) => "$" + String(position + 4));
        await sql.unsafe(
          "INSERT INTO intel_shipments"
          + " (tenant_id, created_by, source_channel, source_ref, is_verified, " + cols.join(", ") + ")"
          + " VALUES ($1, $2, 'manual_csv', $3, false, " + placeholders.join(", ") + ")",
          [DEFAULT_TENANT, String(user.id), filename, ...cols.map((col) => mapped[col])]);
        inserted += 1;
      } catch (err) {
        errors.push({ row: csvRow, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return {
      status: "success",
      processed,
      inserted,
      errors: errors.length,
      error_details: errors.slice(0, 10),
    };
  });
  return c.json(payload);
}));

// GET /api/v1/intel/trade-stats（main.py:1061-1082）
const tradeStatsQuery = z.object({
  hs_code: z.string().nullish(),
  partner_country: z.string().nullish(),
  limit: z.coerce.number().int().max(500).default(100),
});

app.get("/api/v1/intel/trade-stats", (c) => respond(c, async () => {
  await requireUser(c);
  const query = parseQuery(tradeStatsQuery, queries(c));
  const where: string[] = ["tenant_id = $1"];
  const params: unknown[] = [DEFAULT_TENANT];
  if (query.hs_code) {
    params.push(query.hs_code);
    where.push("hs_code = $" + String(params.length));
  }
  if (query.partner_country) {
    params.push("%" + query.partner_country + "%");
    where.push("partner_country ILIKE $" + String(params.length));
  }
  const payload = await withDb(getEnv(c), async (sql: Db) => {
    const rows = await sql.unsafe(
      "SELECT * FROM intel_trade_stats WHERE " + where.join(" AND ")
      + " ORDER BY period DESC LIMIT $" + String(params.length + 1),
      [...params, query.limit ?? 100]);
    return rowsOut(rows as Row[]);
  });
  return c.json(payload);
}));

// GET /api/v1/intel/adapter-runs（main.py:1085-1103）
const adapterRunsQuery = z.object({
  status: z.string().nullish(),
  limit: z.coerce.number().int().max(200).default(50),
});

app.get("/api/v1/intel/adapter-runs", (c) => respond(c, async () => {
  await requireUser(c);
  const query = parseQuery(adapterRunsQuery, queries(c));
  const where: string[] = ["tenant_id = $1"];
  const params: unknown[] = [DEFAULT_TENANT];
  if (query.status) {
    params.push(query.status);
    where.push("status = $" + String(params.length));
  }
  const payload = await withDb(getEnv(c), async (sql: Db) => {
    const rows = await sql.unsafe(
      "SELECT * FROM intel_adapter_runs WHERE " + where.join(" AND ")
      + " ORDER BY started_at DESC LIMIT $" + String(params.length + 1),
      [...params, query.limit ?? 50]);
    return rowsOut(rows as Row[]);
  });
  return c.json(payload);
}));

// GET /api/v1/intel/channels（main.py:1106-1120）
app.get("/api/v1/intel/channels", (c) => respond(c, async () => {
  await requireUser(c);
  const payload = await withDb(getEnv(c), async (sql: Db) => {
    const rows = await sql.unsafe(
      "SELECT * FROM intel_data_channels WHERE tenant_id=$1 ORDER BY tier, name",
      [DEFAULT_TENANT]);
    const channels = rowsOut(rows as Row[]);
    return {
      free_channels: channels.filter((channel) => channel.tier === "free"),
      paid_channels: channels
        .filter((channel) => channel.tier === "paid")
        .map((channel) => ({
          ...channel,
          message: channel.is_enabled ? "已开通" : "未开通",
        })),
    };
  });
  return c.json(payload);
}));

// ══════════════════════════════════════════════════════════════════════════════
// market（main.py:1962-2168）
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/v1/market/regions（main.py:1745-1752）
app.get("/api/v1/market/regions", (c) => respond(c, async () => {
  await requireUser(c);
  const payload = await withDb(getEnv(c), async (sql: Db) => {
    const rows = await sql.unsafe(
      "SELECT DISTINCT region_code FROM market_region_products"
      + " WHERE tenant_id=$1 ORDER BY region_code", [DEFAULT_TENANT]);
    return (rows as Row[]).map((row) => row.region_code);
  });
  return c.json(payload);
}));

// GET /api/v1/market/regions/{region_code}/products（main.py:1755-1774）
app.get("/api/v1/market/regions/:region_code/products", (c) => respond(c, async () => {
  await requireUser(c);
  const regionCode = c.req.param("region_code");
  const payload = await withDb(getEnv(c), async (sql: Db) => {
    const rows = await sql.unsafe(
      "SELECT mrp.*, mrps.spec_key, mrps.spec_value, mrps.unit, mrps.frequency_rank"
      + " FROM market_region_products mrp"
      + " LEFT JOIN market_region_product_specs mrps ON mrps.market_product_id = mrp.id"
      + " WHERE mrp.tenant_id=$1 AND mrp.region_code=$2"
      + " ORDER BY mrp.popularity_rank NULLS LAST",
      [DEFAULT_TENANT, regionCode.toUpperCase()]);
    const products = new Map<unknown, Row>();
    for (const row of rows as Row[]) {
      const id = row.id;
      if (!products.has(id)) {
        const product = rowOut(row);
        product.specs = [];
        products.set(id, product);
      }
      if (row.spec_key) {
        (products.get(id) as Row & { specs: Row[] }).specs.push({
          key: row.spec_key, value: row.spec_value, unit: row.unit, rank: row.frequency_rank,
        });
      }
    }
    return [...products.values()];
  });
  return c.json(payload);
}));

// GET /api/v1/market/name-lookup（main.py:1995-2012）
const nameLookupQuery = z.object({
  q: z.string().min(1),
  region_code: z.string().nullish(),
});

app.get("/api/v1/market/name-lookup", (c) => respond(c, async () => {
  await requireUser(c);
  const query = parseQuery(nameLookupQuery, queries(c));
  const where: string[] = [
    "tenant_id = $1",
    "(local_name ILIKE $2 OR EXISTS (SELECT 1 FROM jsonb_array_elements_text("
    + "COALESCE(alt_names,'[]'::jsonb)) t WHERE t ILIKE $2))",
  ];
  const params: unknown[] = [DEFAULT_TENANT, "%" + query.q + "%"];
  if (query.region_code) {
    params.push(query.region_code.toUpperCase());
    where.push("region_code = $" + String(params.length));
  }
  const payload = await withDb(getEnv(c), async (sql: Db) => {
    const rows = await sql.unsafe(
      "SELECT * FROM market_product_name_mappings WHERE " + where.join(" AND ")
      + " ORDER BY is_verified DESC, created_at DESC LIMIT 50", params);
    return rowsOut(rows as Row[]);
  });
  return c.json(payload);
}));

// POST /api/v1/market/name-mappings（main.py:2015-2028，201）
app.post("/api/v1/market/name-mappings", (c) => respond(c, async () => {
  await requireUser(c);
  const body = await parseBody(c, main_NameMappingCreate);
  const payload = await withDb(getEnv(c), async (sql: Db) => {
    const rows = await sql.unsafe(
      "INSERT INTO market_product_name_mappings"
      + " (tenant_id, category_id, region_code, lang, local_name, alt_names, hs_code,"
      + "  source, confidence, is_verified)"
      + " VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10) RETURNING *",
      [DEFAULT_TENANT, body.category_id, body.region_code.toUpperCase(), body.lang,
        body.local_name, JSON.stringify(body.alt_names ?? []), body.hs_code,
        body.source, body.confidence, body.is_verified]);
    return rowOut(rows[0] as Row);
  });
  return c.json(payload, 201);
}));

// GET /api/v1/market/name-mappings（main.py:2030-2069，C36 #19 分页 + 筛选）
// page>=1、page_size 1..100（默认 20）；q = local_name/alt_names ILIKE；
// region_code 大写归一、lang 精确；排序与 name-lookup 同口径。
const nameMappingsQuery = pageQuery.extend({
  q: z.string().nullish(),
  region_code: z.string().nullish(),
  lang: z.string().nullish(),
});

app.get("/api/v1/market/name-mappings", (c) => respond(c, async () => {
  await requireUser(c);
  const query = parseQuery(nameMappingsQuery, queries(c));
  const where: string[] = ["tenant_id = $1"];
  const params: unknown[] = [DEFAULT_TENANT];
  if (query.q) {
    params.push("%" + query.q + "%");
    where.push(
      "(local_name ILIKE $" + String(params.length)
      + " OR EXISTS (SELECT 1 FROM jsonb_array_elements_text("
      + "COALESCE(alt_names,'[]'::jsonb)) t WHERE t ILIKE $" + String(params.length) + "))",
    );
  }
  if (query.region_code) {
    params.push(query.region_code.toUpperCase());
    where.push("region_code = $" + String(params.length));
  }
  if (query.lang) {
    params.push(query.lang);
    where.push("lang = $" + String(params.length));
  }
  const whereSql = where.join(" AND ");
  const limitParam = params.length + 1;
  const payload = await withDb(getEnv(c), async (sql: Db) => {
    const totalRows = await sql.unsafe(
      "SELECT COUNT(*) AS count FROM market_product_name_mappings WHERE " + whereSql, params);
    const total = num0((totalRows[0] as Row | undefined)?.count);
    const rows = await sql.unsafe(
      "SELECT * FROM market_product_name_mappings WHERE " + whereSql
      + " ORDER BY is_verified DESC, created_at DESC LIMIT $" + String(limitParam)
      + " OFFSET $" + String(limitParam + 1),
      [...params, query.page_size, (query.page - 1) * query.page_size]);
    return {
      items: rowsOut(rows as Row[]),
      total,
      page: query.page,
      page_size: query.page_size,
    };
  });
  return c.json(payload);
}));

/** main.py:NameMappingPatch 的列序（PATCH 的 UPDATE 列序，与 Python 白名单一致）。 */
const NAME_MAPPING_PATCH_FIELDS = [
  "category_id", "region_code", "lang", "local_name", "alt_names",
  "hs_code", "source", "confidence", "is_verified",
] as const;

/** postgres.js 唯一约束冲突（23505）；测试桩可能只提供 duplicate key 文案。 */
function isUniqueViolation(err: unknown): boolean {
  if ((err as { code?: unknown } | null)?.code === "23505") return true;
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("uq_market_name_mappings") || message.includes("duplicate key");
}

// PATCH /api/v1/market/name-mappings/{mapping_id}（main.py:2072-2118）
// 只更新显式出现的字段（pydantic model_fields_set 语义：rawBody 键集 ∩ 白名单）；
// 空 body → 422 "No fields to update"；不存在 → 404；唯一键冲突 → 409。
app.patch("/api/v1/market/name-mappings/:mapping_id", (c) => respond(c, async () => {
  await requireUser(c);
  const { mapping_id: mappingId } = parseQuery(idParam("mapping_id"), c.req.param(), "path");
  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    throw httpError(422, [
      { type: "json_invalid", loc: ["body"], msg: "Invalid JSON", input: null },
    ]);
  }
  await parseBody(c, main_NameMappingPatch); // zod 校验（pydantic 生成，禁止手写）
  const incoming = (rawBody ?? {}) as Row;
  const provided = NAME_MAPPING_PATCH_FIELDS.filter((key) => key in incoming);
  if (provided.length === 0) {
    throw httpError(422, "No fields to update");
  }
  const params: unknown[] = [DEFAULT_TENANT, mappingId];
  const sets: string[] = [];
  for (const key of provided) {
    const value = incoming[key];
    if (key === "region_code" && value !== null) {
      params.push(String(value).toUpperCase());
      sets.push("region_code = $" + String(params.length));
    } else if (key === "alt_names") {
      params.push(JSON.stringify(value ?? []));
      sets.push("alt_names = $" + String(params.length) + "::jsonb");
    } else {
      params.push(value);
      sets.push(key + " = $" + String(params.length));
    }
  }
  const payload = await withDb(getEnv(c), async (sql: Db) => {
    let rows: Row[];
    try {
      rows = await sql.unsafe(
        "UPDATE market_product_name_mappings SET " + sets.join(", ") + ", updated_at = NOW()"
        + " WHERE tenant_id=$1 AND id=$2 RETURNING *",
        params) as Row[];
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw httpError(409, { error: "conflict", code: "NAME_MAPPING_EXISTS" });
      }
      throw err;
    }
    const row = rows[0];
    if (!row) {
      throw httpError(404, { error: "not_found", code: "NAME_MAPPING_NOT_FOUND" });
    }
    return rowOut(row);
  });
  return c.json(payload);
}));

// DELETE /api/v1/market/name-mappings/{mapping_id}（main.py:2121-2136，204）
app.delete("/api/v1/market/name-mappings/:mapping_id", (c) => respond(c, async () => {
  await requireUser(c);
  const { mapping_id: mappingId } = parseQuery(idParam("mapping_id"), c.req.param(), "path");
  await withDb(getEnv(c), async (sql: Db) => {
    const rows = await sql.unsafe(
      "DELETE FROM market_product_name_mappings WHERE id=$1 AND tenant_id=$2 RETURNING id",
      [mappingId, DEFAULT_TENANT]);
    if (rows.length === 0) {
      throw httpError(404, { error: "not_found", code: "NAME_MAPPING_NOT_FOUND" });
    }
  });
  return c.body(null, 204);
}));

// GET /api/v1/market/usages（main.py:2139-2145）
app.get("/api/v1/market/usages", (c) => respond(c, async () => {
  await requireUser(c);
  const payload = await withDb(getEnv(c), async (sql: Db) => {
    const rows = await sql.unsafe(
      "SELECT * FROM market_product_usages WHERE tenant_id=$1 ORDER BY usage_code",
      [DEFAULT_TENANT]);
    return rowsOut(rows as Row[]);
  });
  return c.json(payload);
}));

// GET /api/v1/market/ports（main.py:1822-1841）
const portsQuery = z.object({
  country_code: z.string().nullish(),
  port_type: z.string().nullish(),
});

app.get("/api/v1/market/ports", (c) => respond(c, async () => {
  await requireUser(c);
  const query = parseQuery(portsQuery, queries(c));
  const where: string[] = ["tenant_id = $1"];
  const params: unknown[] = [DEFAULT_TENANT];
  if (query.country_code) {
    params.push(query.country_code.toUpperCase());
    where.push("country_code = $" + String(params.length));
  }
  if (query.port_type) {
    params.push(query.port_type);
    where.push("port_type = $" + String(params.length));
  }
  const payload = await withDb(getEnv(c), async (sql: Db) => {
    const rows = await sql.unsafe(
      "SELECT * FROM market_ports WHERE " + where.join(" AND ")
      + " ORDER BY country_code, name_en", params);
    return rowsOut(rows as Row[]);
  });
  return c.json(payload);
}));

export default app;
