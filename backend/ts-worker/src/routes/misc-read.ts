/*
 * P3 批次A（下一批只读）· fx-rates / external-docs / trade-docs 附件 三条只读 GET 门面直连。
 *
 * 本文件**只**注册这三条 GET；接线（index.ts 的 mount + boot-flag 的 route id）由 Lead 统一做，
 * 因此 route id 在本文件里用**字符串字面量**（\`fx-rates.list\` 等），不依赖 boot-flag 的常量表。
 *
 * 真源逐条直译（SQL 文本/参数顺序/排序/投影键一律照抄，禁止顺手优化）：
 * - GET /api/v1/fx-rates              backend/worker/src/ws_extras.py:163-177 list_fx_rates
 * - GET /api/v1/external-docs        backend/worker/src/ws_extras.py:363-390 list_external_docs
 * - GET /api/v1/trade-docs/{id}/files backend/worker/src/ws_files.py:642-659 list_doc_files
 * 列类型真源 = orchestrator/app/db/{workstation_models,external_docs}.py + ws_files.py:_META_COLS。
 *
 * 有意**不迁**（核对源码后判定，不是漏掉）：
 * - /fx-rates/latest（ws_extras.py:180）：GET 也会回填 fx_rates（外部源拉取 + INSERT/UPDATE）⇒ 不是只读。
 * - /clause-templates（ws_clause_templates.py）：GET 有懒种子 INSERT。
 * - /pricing-data（main.py:2655）：依赖 quote_api 引擎链（产品注册表 + 客户档位扩展），已归引擎切片类。
 * - /trade-docs/{id}/receipts（ws_docs_hardening.py:1048）：需 _doc_404 文档可见性判定 + kaas_common
 *   decimal_text 金额格式化口径 ⇒ 不是纯 SQL；/doc-set（:1217）更要 extract_facts + 触发条件求值（Python 计算）。
 *
 * 开关语义（与 quotes-read.ts / P0 同一套）：
 * - off（默认）⇒ **原样 forwardKernelRequest**（与 createProxyApp 同一句，不加 respond 包装）；
 * - on ⇒ 先判开关（纯 var 读）⇒ requireUser + 门面直连 Hyperdrive。
 * 工作位闸门不在本文件做（Lead 的门面闸门中间件统一覆盖）。
 */
import { Hono, type Context } from "hono";
import { z } from "zod";

import { useDirectRoute } from "../boot-flag";
import { withDb, type Db } from "../db";
import { getEnv, type Env } from "../env";
import { directDb } from "../hot-read";
import { bool, httpError, num, num0, parseQuery, pyIso, respond } from "../http";
import { forwardKernelRequest } from "../proxy";
import { isAdminRole } from "../rules";
import { requireUser, type CurrentUser } from "../session";
import { META_COLS, rowToFile, teamScope } from "./files";

const DEFAULT_TENANT = "default";

/** 行别名（只按列名读取）。 */
type Row = Record<string, unknown>;

// ── 共享小助手（与 quotes-read.ts 同口径）────────────────────────────────────

// Numeric → number：Python 侧 float(...) / FastAPI 的 decimal_encoder 都是数。
function asFloat(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return Number(value);
}

// DATE 列 → 'YYYY-MM-DD'（Python 侧是 date，.isoformat() 只出日期，不是 timestamptz）。
function pyDate(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return value;
}

// FastAPI 的 int 查询参数：空串/非整数 → 422（不静默 coerce 成 0）。
const INT_QUERY = z.string().regex(/^-?\d+$/, "Input should be a valid integer").transform(Number);

// ── GET /api/v1/fx-rates（ws_extras.py:163-177）──────────────────────────────

const fxListQuery = z.object({
  base_currency: z.string().optional(),
  quote_currency: z.string().optional(),
  limit: INT_QUERY.optional(),
});

// 内核 list_fx_rates 的响应是**裸数组**（不是 {items,total}），6 键逐字投影：
// rate → float、rate_date → date.isoformat()（只出日期）、is_stale → bool。
function fxRateOut(row: Row): Row {
  return {
    base_currency: row.base_currency ?? null,
    quote_currency: row.quote_currency ?? null,
    rate: asFloat(row.rate),
    rate_date: pyDate(row.rate_date ?? null),
    source: row.source ?? null,
    is_stale: bool(row.is_stale),
  };
}

// GET /api/v1/fx-rates —— 汇率历史（按 rate_date 倒序，limit 夹取 [1,365] 后作 $3 传参）。
export async function listFxRatesDirect(
  c: Context,
  _user: CurrentUser,
): Promise<Response> {
  const query = parseQuery(fxListQuery, c.req.query());
  const base = query.base_currency ?? "USD";
  const quote = query.quote_currency ?? "CNY";
  const limit = Math.min(Math.max(query.limit ?? 30, 1), 365);
  const rows = (await withDb(getEnv(c), (sql: Db) =>
    sql.unsafe(
      "SELECT * FROM fx_rates WHERE base_currency=$1 AND quote_currency=$2"
      + " ORDER BY rate_date DESC LIMIT $3",
      [base, quote, limit] as never[],
    ))) as unknown as Row[];
  return c.json(rows.map(fxRateOut));
}

// ── GET /api/v1/external-docs（ws_extras.py:363-390）─────────────────────────

const externalDocsQuery = z.object({
  order_id: INT_QUERY.optional(),
  doc_type: z.string().optional(),
  limit: INT_QUERY.optional(),
});

// 内核 list_external_docs 的响应同样是**裸数组**，13 键投影；file_size 显式 float(...)、
// created_at 用 isoformat（timestamptz）。
function externalDocOut(row: Row): Row {
  return {
    id: num(row.id),
    doc_type: row.doc_type ?? null,
    file_name: row.file_name ?? null,
    content_type: row.content_type ?? null,
    file_size: asFloat(row.file_size),
    order_id: num(row.order_id),
    quote_order_id: num(row.quote_order_id),
    inquiry_id: num(row.inquiry_id),
    customer_id: row.customer_id ?? null,
    status: row.status ?? null,
    notes: row.notes ?? null,
    uploaded_by: row.uploaded_by ?? null,
    created_at: pyIso(row.created_at ?? null),
  };
}

// 外部单证的行级可见性谓词 —— backend/worker/src/ws_extras.py:_external_doc_scope 的**逐字镜像**。
// 表 external_doc_uploads 没有 team_id 列（orchestrator/app/db/external_docs.py），本轮不做迁移，
// 因此团队隔离用保守代理：管理员放行；否则 uploaded_by = 我 或 挂载对象（order/quote/inquiry）
// 属本团队；无团队的非管理员只剩 uploaded_by 一条（未挂载/非本人上传的件不可见）。
function externalDocScope(
  user: CurrentUser,
  nextIndex: number,
  tenantIndex = 1,
): { frag: string; extra: unknown[] } {
  if (isAdminRole(user.role)) return { frag: "", extra: [] };
  const extra: unknown[] = [String(user.id)];
  let frag = " AND (uploaded_by = $" + String(nextIndex) + "::text";
  let idx = nextIndex;
  if (user.team_id !== null && user.team_id !== undefined) {
    for (const [col, table] of [
      ["order_id", "orders"],
      ["quote_order_id", "quote_orders"],
      ["inquiry_id", "cust_inquiries"],
    ] as const) {
      idx += 1;
      extra.push(user.team_id);
      frag += " OR " + col + " IN (SELECT id FROM " + table
        + " WHERE tenant_id = $" + String(tenantIndex) + " AND team_id = $" + String(idx) + ")";
    }
  }
  return { frag: frag + ")", extra };
}

// GET /api/v1/external-docs —— 外部单证列表（order_id/doc_type 可选筛选，LIMIT 作末参）。
// 注意内核口径：order_id 用 `is not None`（**0 也算筛**），doc_type 用真值判断（空串不算）。
// limit 是 Query(50, ge=1, le=500) ⇒ 越界 422（不是夹取）。
export async function listExternalDocsDirect(
  c: Context,
  user: CurrentUser,
): Promise<Response> {
  const query = parseQuery(externalDocsQuery, c.req.query());
  const limit = query.limit ?? 50;
  if (limit < 1 || limit > 500) {
    throw httpError(422, [{
      type: limit < 1 ? "greater_than_equal" : "less_than_equal",
      loc: ["query", "limit"],
      msg: limit < 1 ? "Input should be greater than or equal to 1" : "Input should be less than or equal to 500",
      input: String(limit),
    }]);
  }
  // 恒加 tenant_id（本轮之前**连租户都不过滤**）+ 行级可见性谓词（与内核同一把尺）
  let cond = " AND tenant_id=$1";
  const params: unknown[] = [DEFAULT_TENANT];
  const scope = externalDocScope(user, params.length + 1);
  cond += scope.frag;
  params.push(...scope.extra);
  if (query.order_id !== undefined) {
    params.push(query.order_id);
    cond += " AND order_id=$" + String(params.length);
  }
  if (query.doc_type) {
    params.push(query.doc_type);
    cond += " AND doc_type=$" + String(params.length);
  }
  const rows = (await withDb(getEnv(c), (sql: Db) =>
    sql.unsafe(
      "SELECT id, doc_type, file_name, content_type, file_size, order_id,"
      + " quote_order_id, inquiry_id, customer_id, status, notes, uploaded_by, created_at"
      + " FROM external_doc_uploads WHERE 1=1" + cond
      + " ORDER BY created_at DESC LIMIT $" + String(params.length + 1),
      [...params, limit] as never[],
    ))) as unknown as Row[];
  return c.json(rows.map(externalDocOut));
}

// ── GET /api/v1/trade-docs/{doc_id}/files（ws_files.py:642-659）──────────────

const docFilesParam = z.object({ doc_id: INT_QUERY });

// ws_files.py:132-136 _FILE_COLS_F = 同一份 _META_COLS 的 f. 前缀版（逐字对齐，不手抄第二份列集）。
const FILE_COLS_F = META_COLS.split(", ").map((col) => "f." + col).join(", ");

// GET /api/v1/trade-docs/{doc_id}/files —— 单证挂接的文件（链接 + 文件元数据）。
// 团队隔离用**硬**尺（_team_scope，ws_files.py:79）：非管理员无团队 ⇒ 403 NO_TEAM。
export async function listDocFilesDirect(
  c: Context,
  user: CurrentUser,
): Promise<Response> {
  const { doc_id: docId } = parseQuery(docFilesParam, c.req.param(), "path");
  // ws_files.py:650 的 _team_scope(user, 3, col="f.team_id")：参数已占 2 个 ⇒ 谓词从 $3 起
  const scope = teamScope(user, 3, "f.team_id");
  const rows = (await withDb(getEnv(c), (sql: Db) =>
    sql.unsafe(
      "SELECT t.id AS link_id, t.role AS link_role, t.caption AS link_caption,"
      + " t.sort_order AS link_sort_order, " + FILE_COLS_F
      + " FROM trade_doc_files t JOIN file_objects f ON f.id = t.file_id"
      + " WHERE t.tenant_id=$1 AND t.trade_doc_id=$2" + scope.frag
      + " ORDER BY t.sort_order, t.id",
      [DEFAULT_TENANT, docId, ...scope.extra] as never[],
    ))) as unknown as Row[];
  const items = rows.map((row) => {
    // 与 Python 一致：先把 link_* 别名剔掉，再走 _row_to_file 投影
    const file = Object.fromEntries(
      Object.entries(row).filter(([key]) => !key.startsWith("link_")),
    );
    const item = rowToFile(file);
    item.link_id = num0(row.link_id);
    item.role = row.link_role ?? null;
    item.caption = row.link_caption ?? null;
    item.sort_order = num0(row.link_sort_order);
    return item;
  });
  return c.json({ items });
}

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/v1/events（main.py:3292-3328）—— 事件审计列表（平台运营专用）
//
// 闸门 = main._require_platform_ops（internal + 管理员），与 6 个 /api/v1/admin/* 同口径。
// 分页参数是**普通 int**（非 Query 约束）⇒ 非整数 422；越界在 handler 内钳位：
// page=max(page,1)、page_size=min(max(page_size,1),100)。筛选 event_type 为真值判断。
// ══════════════════════════════════════════════════════════════════════════════

/** main.py:173-187 _require_platform_ops：internal 账号 + 管理员角色。 */
function requirePlatformOps(user: CurrentUser): void {
  if (user.account_type !== "internal" || !isAdminRole(user.role)) {
    throw httpError(403, { error: "forbidden", message: "Platform operator required" });
  }
}

const eventsQuery = z.object({
  page: INT_QUERY.optional(),
  page_size: INT_QUERY.optional(),
  event_type: z.string().optional(),
});

/**
 * events 表的列（DDL 顺序 = f82ac951b473_intel_workstation_v1.py:139-151）。
 * `payload` 显式取 ::text：内核 _row_to_dict(row) **未登记** events 的 jsonb 解码，
 * asyncpg 返回的是 jsonb 文本串 ⇒ 响应里 payload 就是字符串。这里取同一份文本以保持
 * 两侧形状逐字一致（详见交付说明：前端按对象读 payload 是既有缺陷，修复应在内核一处）。
 */
const EVENTS_COLS = "id, schema_version, tenant_id, event_type, event_source,"
  + " actor_id, session_id, payload::text AS payload, trace_id, sampled, created_at";

export async function listEventsDirect(
  c: Context,
  user: CurrentUser,
): Promise<Response> {
  requirePlatformOps(user);
  const query = parseQuery(eventsQuery, c.req.query());
  const page = Math.max(query.page ?? 1, 1);
  const pageSize = Math.min(Math.max(query.page_size ?? 20, 1), 100);
  const where: string[] = ["tenant_id = $1"];
  const params: unknown[] = [DEFAULT_TENANT];
  if (query.event_type) {
    params.push(query.event_type);
    where.push("event_type = $" + String(params.length));
  }
  const whereSql = where.join(" AND ");
  const limitIndex = params.length + 1;
  const offsetIndex = params.length + 2;
  const payload = await withDb(getEnv(c), async (sql: Db) => {
    const totalRows = (await sql.unsafe(
      "SELECT count(*) FROM events WHERE " + whereSql,
      params as never[],
    )) as unknown as Row[];
    const rows = (await sql.unsafe(
      "SELECT " + EVENTS_COLS + " FROM events WHERE " + whereSql
      + " ORDER BY id DESC LIMIT $" + String(limitIndex)
      + " OFFSET $" + String(offsetIndex),
      [...params, pageSize, (page - 1) * pageSize] as never[],
    )) as unknown as Row[];
    return { totalRows, rows };
  });
  return c.json({
    items: payload.rows.map((row) => ({
      id: num(row.id),
      schema_version: num0(row.schema_version),
      tenant_id: row.tenant_id ?? null,
      event_type: row.event_type ?? null,
      event_source: row.event_source ?? null,
      actor_id: row.actor_id ?? null,
      session_id: row.session_id ?? null,
      payload: row.payload ?? null,
      trace_id: row.trace_id ?? null,
      sampled: bool(row.sampled),
      created_at: pyIso(row.created_at ?? null),
    })),
    total: num0(payload.totalRows[0]?.count),
    page,
    page_size: pageSize,
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// 单证内容级版本（ws_docs_ext.py:625-687）—— 纯 SQL 只读
//
// 可见性收口 = doc_payload.get_doc_or_404(db, request, doc_id, user)（doc_payload.py:183-215）：
// 先按 tenant+id 取单证（404 DOC_NOT_FOUND），再按团队/owner 可见性过滤（不可见同样 404，
// 不泄露存在性）；internal 账号或管理员免过滤。
// ══════════════════════════════════════════════════════════════════════════════

const contentVersionsParam = z.object({ doc_id: INT_QUERY });
const contentVersionParam = z.object({ doc_id: INT_QUERY, version_no: INT_QUERY });

/** doc_payload.py:183-215 get_doc_or_404 的团队/owner 可见性（逐字镜像）。 */
async function loadDocOr404(
  env: Env,
  user: CurrentUser,
  docId: number,
): Promise<Row> {
  const rows = (await withDb(env, (sql: Db) => sql.unsafe(
    "SELECT * FROM trade_docs WHERE tenant_id=$1 AND id=$2",
    [DEFAULT_TENANT, docId] as never[],
  ))) as unknown as Row[];
  const row = rows[0];
  if (!row) {
    throw httpError(404, { error: "not_found", code: "DOC_NOT_FOUND" });
  }
  const privileged = user.account_type === "internal" || isAdminRole(user.role);
  if (!privileged) {
    const rowTeam = row.team_id;
    const viewerTeam = user.team_id;
    const sameTeam = rowTeam !== null && rowTeam !== undefined
      && viewerTeam !== null && viewerTeam !== undefined
      && String(rowTeam) === String(viewerTeam);
    const visible = row.owner_scope === "tenant"
      || (row.owner_id !== null && row.owner_id !== undefined
        && String(row.owner_id) === String(user.id))
      || sameTeam;
    if (viewerTeam === null || viewerTeam === undefined || !visible) {
      throw httpError(404, { error: "not_found", code: "DOC_NOT_FOUND" });
    }
  }
  return row;
}

/** ws_docs_ext.py:612-622 _decode_payload：字符串尝试 json.loads，非 dict 一律 {}。 */
export function decodeTradeDocPayload(raw: unknown): Row {
  if (typeof raw === "string") {
    try {
      const loaded: unknown = JSON.parse(raw);
      return typeof loaded === "object" && loaded !== null && !Array.isArray(loaded)
        ? (loaded as Row) : {};
    } catch {
      return {};
    }
  }
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) return raw as Row;
  return {};
}

export async function listContentVersionsDirect(
  c: Context,
  user: CurrentUser,
): Promise<Response> {
  const { doc_id: docId } = parseQuery(contentVersionsParam, c.req.param(), "path");
  const doc = await loadDocOr404(getEnv(c), user, docId);
  const rows = (await withDb(getEnv(c), (sql: Db) => sql.unsafe(
    "SELECT v.version_no, v.change_source, v.actor_id, v.note, v.created_at,"
    + " COALESCE(("
    + "   SELECT jsonb_agg(k ORDER BY k)"
    + "     FROM (SELECT jsonb_object_keys("
    + "       COALESCE(v.raw_payload->'custom', '{}'::jsonb)) AS k) AS keys"
    + " ), '[]'::jsonb)::text AS custom_keys"
    + " FROM trade_doc_content_versions v"
    + " WHERE v.tenant_id=$1 AND v.trade_doc_id=$2"
    + " ORDER BY v.version_no DESC",
    [DEFAULT_TENANT, doc.id] as never[],
  ))) as unknown as Row[];
  const items = rows.map((row) => ({
    version_no: num0(row.version_no),
    change_source: row.change_source ?? null,
    actor_id: row.actor_id ?? null,
    note: row.note ?? null,
    created_at: pyIso(row.created_at ?? null),
    // 内核 `r.get("custom_keys") or []`：jsonb_agg 文本串恒为真 ⇒ 原样返回字符串
    // （dbjson 未登记该计算列，asyncpg 返回文本；此处同样取 ::text 保持形状一致）
    custom_keys: row.custom_keys ? row.custom_keys : [],
  }));
  return c.json({ doc_id: num(doc.id), total: items.length, items });
}

export async function getContentVersionDirect(
  c: Context,
  user: CurrentUser,
): Promise<Response> {
  const params = parseQuery(contentVersionParam, c.req.param(), "path");
  const doc = await loadDocOr404(getEnv(c), user, params.doc_id);
  const rows = (await withDb(getEnv(c), (sql: Db) => sql.unsafe(
    "SELECT version_no, raw_payload, change_source, actor_id, note, created_at"
    + " FROM trade_doc_content_versions"
    + " WHERE tenant_id=$1 AND trade_doc_id=$2 AND version_no=$3",
    [DEFAULT_TENANT, doc.id, params.version_no] as never[],
  ))) as unknown as Row[];
  const row = rows[0];
  if (!row) {
    throw httpError(404, {
      error: "not_found", code: "VERSION_NOT_FOUND",
      detail: "内容版本 v" + String(params.version_no) + " 不存在",
    });
  }
  return c.json({
    version_no: num0(row.version_no),
    change_source: row.change_source ?? null,
    actor_id: row.actor_id ?? null,
    note: row.note ?? null,
    created_at: pyIso(row.created_at ?? null),
    raw_payload: decodeTradeDocPayload(row.raw_payload),
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// 路由注册（由 src/index.ts 挂载在对应 createProxyApp 透传 mount **之前**）：
// 每请求判定灰度开关；off 时是**原样** forwardKernelRequest（与 createProxyApp 同一句）。
// ══════════════════════════════════════════════════════════════════════════════

const app = new Hono<{ Bindings: Env }>();

app.get("/api/v1/fx-rates", (c) => {
  if (useDirectRoute(getEnv(c), "fx-rates.list")) {
    return respond(c, async () => {
      const user = await requireUser(c);
      return directDb(c, () => listFxRatesDirect(c, user));
    });
  }
  return forwardKernelRequest(c);
});

app.get("/api/v1/external-docs", (c) => {
  if (useDirectRoute(getEnv(c), "external-docs.list")) {
    return respond(c, async () => {
      const user = await requireUser(c);
      return directDb(c, () => listExternalDocsDirect(c, user));
    });
  }
  return forwardKernelRequest(c);
});

app.get("/api/v1/trade-docs/:doc_id/files", (c) => {
  if (useDirectRoute(getEnv(c), "trade-docs.files")) {
    return respond(c, async () => {
      const user = await requireUser(c);
      return directDb(c, () => listDocFilesDirect(c, user));
    });
  }
  return forwardKernelRequest(c);
});

app.get("/api/v1/events", (c) => {
  if (useDirectRoute(getEnv(c), "events.list")) {
    return respond(c, async () => {
      const user = await requireUser(c);
      return directDb(c, () => listEventsDirect(c, user));
    });
  }
  return forwardKernelRequest(c);
});

app.get("/api/v1/trade-docs/:doc_id/content-versions", (c) => {
  if (useDirectRoute(getEnv(c), "trade-docs.content-versions.list")) {
    return respond(c, async () => {
      const user = await requireUser(c);
      return directDb(c, () => listContentVersionsDirect(c, user));
    });
  }
  return forwardKernelRequest(c);
});

app.get("/api/v1/trade-docs/:doc_id/content-versions/:version_no", (c) => {
  if (useDirectRoute(getEnv(c), "trade-docs.content-versions.get")) {
    return respond(c, async () => {
      const user = await requireUser(c);
      return directDb(c, () => getContentVersionDirect(c, user));
    });
  }
  return forwardKernelRequest(c);
});

export default app;
