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

// GET /api/v1/external-docs —— 外部单证列表（order_id/doc_type 可选筛选，LIMIT 作末参）。
// 注意内核口径：order_id 用 `is not None`（**0 也算筛**），doc_type 用真值判断（空串不算）。
// limit 是 Query(50, ge=1, le=500) ⇒ 越界 422（不是夹取）。
export async function listExternalDocsDirect(
  c: Context,
  _user: CurrentUser,
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
  let cond = "";
  const params: unknown[] = [];
  if (query.order_id !== undefined) {
    cond += " AND order_id=$1";
    params.push(query.order_id);
  }
  if (query.doc_type) {
    cond += " AND doc_type=$" + String(params.length + 1);
    params.push(query.doc_type);
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

export default app;
