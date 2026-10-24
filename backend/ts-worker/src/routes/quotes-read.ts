/*
 * P3 批次A（扩权）· quotes / tax 域**只读**端点门面直连（AUTH_DB_SPLIT=on 时启用）。
 *
 * 背景：index.ts 里 quotations / tax-archives / product-tax-rates 三个前缀还是
 * createProxyApp 整段透传（= 每条 GET 都要等 Python 内核冷启动）。这三条列表读是
 * P2 文档 §3/§5.2 标注「TS-DB（无 Python 计算）」且**源码核对为纯 SQL**的部分。
 *
 * 真源逐条直译（SQL 文本、参数顺序、排序、投影键一律照抄，禁止顺手优化）：
 * - GET /api/v1/quotations        backend/worker/src/main.py:2504-2543 list_quotations_api
 * - GET /api/v1/tax-archives      backend/worker/src/tax_archives.py:202-215 list_tax_archives
 * - GET /api/v1/product-tax-rates backend/worker/src/tax_archives.py:372-383 list_product_tax_rates
 * 列类型真源 = orchestrator/app/db/{models,tax_models}.py（决定 date vs timestamptz、Numeric、JSONB）。
 *
 * 有意**不迁**（核对源码后判定，不是漏掉）：
 * - GET /api/v1/pricing-data（main.py:2655）：**不是纯 SQL** —— 先 quote_api._require_engine()，
 *   再 get_product / extend_product / _load_option_extensions / describe_pricing_key /
 *   _matrix_rows / _pricing_history / _pricing_reference（产品注册表 + 客户档位扩展 + 历史
 *   回退 = Python 计算与引擎状态）。搬来就是第二份业务规则（ADR-008 铁纪律禁止）⇒ 保留内核。
 * - GET /api/v1/clause-templates、GET /api/v1/fx-rates/latest：P2 文档 §9 已登记「GET 也写库」
 *   （懒种子 INSERT / 回填 UPDATE），语义归属未定 ⇒ 本轮不动。
 * - GET /api/v1/quotations/{id}：内核**没有**这条路由（只有列表；详情走 /quotes 域）⇒ 不造端点。
 *
 * 开关语义（与 P0 同一套 boot-flag）：
 * - off（默认）⇒ **原样 forwardKernelRequest**，与 index.ts 的 createProxyApp 是同一句、
 *   逐字不变（连 respond() 包装都不加，保证字节级一致）；
 * - on ⇒ requireUser + 门面直连 Hyperdrive。
 * 判定次序：**先看开关**（纯 var 读，不触 DB/内核）⇒ 命中才鉴权；未命中直接走原透传。
 */
import { Hono, type Context } from "hono";
import { z } from "zod";

import { DIRECT_ROUTE_IDS, useDirectRoute } from "../boot-flag";
import { withDb, type Db } from "../db";
import { getEnv, type Env } from "../env";
import { directDb } from "../hot-read";
import { httpError, num0, num, parseQuery, pyIso, respond } from "../http";
import { forwardKernelRequest } from "../proxy";
import { isAdminRole } from "../rules";
import { requireUser, type CurrentUser } from "../session";

const DEFAULT_TENANT = "default";

/** 行别名（只按列名读取）。 */
type Row = Record<string, unknown>;

/* Numeric → float（Python 侧 `float(...)` / FastAPI 的 decimal_encoder 都是数）。 */
function asFloat(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return Number(value);
}

/* DATE 列（tax_archives.effective_from/to）→ 'YYYY-MM-DD'：Python 侧是 `date`，
 * `.isoformat()` 只出日期（**不是** timestamptz 的含时间串）。 */
function pyDate(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return value;
}

/* JSONB 列防御性解码（asyncpg 在 Workers 里可能给字符串；解析失败按空处理，
 * 与 backend/worker/src/dbjson.py 同口径：不抛 500）。 */
function jsonObject(value: unknown): unknown {
  let raw = value;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw || "null");
    } catch {
      raw = null;
    }
  }
  return raw ? raw : {};
}

/** FastAPI `Query(False)` 的 bool 解析（pydantic v2 的接受集；非法值 422，不静默当 false）。 */
const TRUE_WORDS = new Set(["1", "true", "t", "yes", "y", "on"]);
const FALSE_WORDS = new Set(["0", "false", "f", "no", "n", "off"]);
function parseBoolQuery(field: string, raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const text = raw.trim().toLowerCase();
  if (TRUE_WORDS.has(text)) return true;
  if (FALSE_WORDS.has(text)) return false;
  throw httpError(422, [{
    type: "bool_parsing", loc: ["query", field],
    msg: "Input should be a valid boolean", input: raw,
  }]);
}

// ── GET /api/v1/quotations（main.py:2504-2543）────────────────────────────────

const quotationListQuery = z.object({
  // ⚠️ 内核签名里三个筛选都是 Optional[str]（不是 int）：照抄，门面不擅自转数字
  customer_id: z.string().optional(),
  product_category: z.string().optional(),
  spec_hash: z.string().optional(),
  // FastAPI 的 int：空串/非整数 → 422（不是静默 coerce 成 0）
  limit: z.string().regex(/^-?\d+$/, "Input should be a valid integer").transform(Number).optional(),
});

/* main.py:2541-2543 的行投影：id 转**字符串**（BigInteger → str），金额 Numeric → 数，
 * 时间 → isoformat；product_spec 是 JSONB（已解码对象）。键序与 SELECT 列顺序一致。 */
function quotationOut(row: Row): Row {
  return {
    id: row.id === null || row.id === undefined ? null : String(row.id),
    customer_id: row.customer_id ?? null,
    product_category: row.product_category ?? null,
    product_spec: row.product_spec ?? null,
    spec_hash: row.spec_hash ?? null,
    unit_price: asFloat(row.unit_price),
    currency: row.currency ?? null,
    unit: row.unit ?? null,
    discount: asFloat(row.discount),
    min_quantity: row.min_quantity === undefined ? null : row.min_quantity,
    source: row.source ?? null,
    notes: row.notes ?? null,
    effective_from: pyIso(row.effective_from ?? null),
    created_at: pyIso(row.created_at ?? null),
  };
}

/* GET /api/v1/quotations —— 旧报价事实表台账（只读）。 */
export async function listQuotationsDirect(
  c: Context,
  _user: CurrentUser,
): Promise<Response> {
  const query = parseQuery(quotationListQuery, c.req.query());
  const where: string[] = ["tenant_id = $1"];
  const params: unknown[] = [DEFAULT_TENANT];
  let idx = 2;
  const filters: Array<[string, string | undefined]> = [
    ["customer_id", query.customer_id],
    ["product_category", query.product_category],
    ["spec_hash", query.spec_hash],
  ];
  for (const [col, val] of filters) {
    if (val) {
      where.push(col + " = $" + String(idx));
      params.push(val);
      idx += 1;
    }
  }
  const w = where.join(" AND ");
  const lim = Math.max(1, Math.min(query.limit ?? 100, 500));
  const payload = await withDb(getEnv(c), async (sql: Db) => {
    const items = (await sql.unsafe(
      "SELECT id, customer_id, product_category, product_spec, spec_hash, unit_price,"
      + " currency, unit, discount, min_quantity, source, notes, effective_from, created_at"
      + " FROM quotations WHERE " + w
      + " ORDER BY effective_from DESC LIMIT " + String(lim),
      params as never[],
    )) as unknown as Row[];
    const totalRows = (await sql.unsafe(
      "SELECT COUNT(*) FROM quotations WHERE " + w,
      params as never[],
    )) as unknown as Row[];
    return { items: items.map(quotationOut), total: num0(totalRows[0]?.count) };
  });
  return c.json(payload);
}

// ── GET /api/v1/tax-archives（tax_archives.py:202-215）───────────────────────

/* tax_archives.py:101-118 `_row_out`：10 键；tax_values 是 JSONB（缺省 {}）。
 * 导出给 tax-rates-write.ts 写路径复用（同一份投影，避免 GET/POST/PATCH 三处各写一份）。 */
export function taxArchiveOut(row: Row): Row {
  return {
    id: num(row.id),
    code: row.code ?? null,
    name: row.name ?? null,
    effective_from: pyDate(row.effective_from ?? null),
    effective_to: pyDate(row.effective_to ?? null),
    tax_values: jsonObject(row.tax_values ?? null),
    source: row.source ?? null,
    status: row.status ?? null,
    created_at: pyIso(row.created_at ?? null),
    updated_at: pyIso(row.updated_at ?? null),
  };
}

/* GET /api/v1/tax-archives —— tax_archives.py:134-144 `_where` 逐字：tenant + 本团队 +
 * （非 include_inactive 或非管理员 ⇒ status='active'）。排序 effective_from DESC NULLS LAST。 */
export async function listTaxArchivesDirect(
  c: Context,
  user: CurrentUser,
): Promise<Response> {
  const includeInactive = parseBoolQuery(
    "include_inactive",
    c.req.query("include_inactive"),
  );
  const where: string[] = ["tenant_id = $1"];
  const params: unknown[] = [DEFAULT_TENANT];
  if (user.team_id !== null && user.team_id !== undefined) {
    params.push(user.team_id);
    where.push("team_id = $" + String(params.length));
  }
  if (!includeInactive || !isAdminRole(user.role)) where.push("status = 'active'");
  const w = where.join(" AND ");
  const payload = await withDb(getEnv(c), async (sql: Db) => {
    const rows = (await sql.unsafe(
      "SELECT * FROM tax_archives WHERE " + w
      + " ORDER BY effective_from DESC NULLS LAST, updated_at DESC",
      params as never[],
    )) as unknown as Row[];
    return { items: rows.map(taxArchiveOut), total: rows.length };
  });
  return c.json(payload);
}

// ── GET /api/v1/product-tax-rates（tax_archives.py:372-383）──────────────────

/* tax_archives.py:331-344 `_product_tax_out`：7 键；两档税率 `float(...)` 显式转数。 */
function productTaxRateOut(row: Row): Row {
  return {
    id: num(row.id),
    product_key: row.product_key ?? null,
    input_vat_rate: asFloat(row.input_vat_rate),
    rebate_rate: asFloat(row.rebate_rate),
    status: row.status ?? null,
    created_at: pyIso(row.created_at ?? null),
    updated_at: pyIso(row.updated_at ?? null),
  };
}

/* GET /api/v1/product-tax-rates —— tax_archives.py:347-354 `_product_tax_where` 逐字
 * （tenant + status='active' + 本团队），排序 product_key ASC。 */
export async function listProductTaxRatesDirect(
  c: Context,
  user: CurrentUser,
): Promise<Response> {
  const where: string[] = ["tenant_id = $1", "status = 'active'"];
  const params: unknown[] = [DEFAULT_TENANT];
  if (user.team_id !== null && user.team_id !== undefined) {
    params.push(user.team_id);
    where.push("team_id = $" + String(params.length));
  }
  const w = where.join(" AND ");
  const payload = await withDb(getEnv(c), async (sql: Db) => {
    const rows = (await sql.unsafe(
      "SELECT * FROM product_tax_rates WHERE " + w + " ORDER BY product_key ASC",
      params as never[],
    )) as unknown as Row[];
    return { items: rows.map(productTaxRateOut), total: rows.length };
  });
  return c.json(payload);
}

// ══════════════════════════════════════════════════════════════════════════════
// 路由注册（由 src/index.ts 挂载在三条 createProxyApp 透传 mount **之前**）：
// 每请求判定灰度开关；off 时是**原样** forwardKernelRequest（与 createProxyApp 同一句）。
// ══════════════════════════════════════════════════════════════════════════════

const app = new Hono<{ Bindings: Env }>();

app.get("/api/v1/quotations", (c) => {
  if (useDirectRoute(getEnv(c), DIRECT_ROUTE_IDS.quotationsList)) {
    return respond(c, async () => {
      const user = await requireUser(c);
      return directDb(c, () => listQuotationsDirect(c, user));
    });
  }
  return forwardKernelRequest(c);
});

app.get("/api/v1/tax-archives", (c) => {
  if (useDirectRoute(getEnv(c), DIRECT_ROUTE_IDS.taxArchivesList)) {
    return respond(c, async () => {
      const user = await requireUser(c);
      return directDb(c, () => listTaxArchivesDirect(c, user));
    });
  }
  return forwardKernelRequest(c);
});

app.get("/api/v1/product-tax-rates", (c) => {
  if (useDirectRoute(getEnv(c), DIRECT_ROUTE_IDS.productTaxRatesList)) {
    return respond(c, async () => {
      const user = await requireUser(c);
      return directDb(c, () => listProductTaxRatesDirect(c, user));
    });
  }
  return forwardKernelRequest(c);
});

export default app;
