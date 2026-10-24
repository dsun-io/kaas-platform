/**
 * P2 引擎切片：引擎端点改「TS 供数 → Python 纯算 → 门面原样回放」。
 *
 * 设计 = docs/P2_COUPLING_ENGINE_2026-10-24.md §6（契约）/ §8（首个切片）；
 * 灰度 = AUTH_DB_SPLIT（默认 off，见 src/boot-flag.ts）。
 *
 * 本文件覆盖同族只读切片：
 * - POST /api/v1/export-quote/calculate      → /internal/engine/quote/calculate（首个切片）
 * - POST /api/v1/export-quote/verify         → /internal/engine/quote/verify
 * - GET  /api/v1/export-quote/products/{key}/formulas → /internal/engine/quote/formulas
 * - GET  /api/v1/export-quote/products/{key}/spec     → /internal/engine/quote/spec
 * - POST /api/v1/export-quote/products/{key}/explain  → /internal/engine/quote/explain
 * - GET  /api/v1/trade-docs/{doc_id}/render-data      → /internal/engine/trade-docs/render-data
 * - GET  /api/v1/quotes（列表） / /quotes/{quote_id}（详情） → /internal/engine/quotes/{list|detail}
 * 八条共用**同一份**供数契约与回放逻辑；差异只在「查哪些 dataset + request 段形状」。
 *
 * 真源（SQL 谓词 / 排序 / 绑定参数**逐条直译**，禁止顺手"优化"）：
 * - backend/worker/src/quote_api.py  _effective_product_raw 的 tenant_products 查询
 * - backend/worker/src/quote_api.py  _pricing_key_items 的 customer_cost_items 查询
 * 供数契约（哪些列、什么类型、为什么 ORDER BY 有语义）见 docs §6.3。
 *
 * 边界（ADR-008 铁纪律）：
 * - 本文件只做「取数 + 协议转换 + 内部令牌」；**没有任何算价/权限判定**（引擎与角色
 *   闸门都在 Python 内核，算法零改动）。verify 的管理员判定**不在门面**：内核用内部
 *   令牌里的角色快照调同一份 _require_internal_admin，403 原样回放；
 * - 开关 off / 路由不在白名单 / 请求体无法供数（非 JSON 对象或缺 product_key）⇒
 *   原样透传（forwardKernelRequest）—— 行为与今天逐字一致，这是**一键回退路径**；
 * - 后端错误由内核以 {status, body} 信封返回，门面按 status 原样回放（4xx 信封逐字不变）。
 */
import { Hono, type Context } from "hono";

import { DIRECT_ROUTE_IDS, useDirectRoute } from "../boot-flag";
import { withDb, type Db } from "../db";
import { getEnv, requireSecret, type Env } from "../env";
import { directDb } from "../hot-read";
import { num, num0, pyIso, respond } from "../http";
import { fetchKernelWithRetry, KERNEL_BASE, planKernelRetry } from "../kernel";
import {
  forwardKernelRequest,
  kernelUnavailableEnvelope,
  KERNEL_UNAVAILABLE_RETRY_AFTER_SECONDS,
  mintEngineJwt,
} from "../proxy";
import { isAdminRole } from "../rules";
import { requireUser, type CurrentUser } from "../session";

const DEFAULT_TENANT = "default";
/** 内核 RPC 路径（与 backend/worker/src/engine_api.py 的注册路径逐字一致）。 */
export const ENGINE_QUOTE_CALCULATE_RPC = "/api/v1/internal/engine/quote/calculate";
export const ENGINE_QUOTE_VERIFY_RPC = "/api/v1/internal/engine/quote/verify";
export const ENGINE_QUOTE_FORMULAS_RPC = "/api/v1/internal/engine/quote/formulas";
export const ENGINE_QUOTE_SPEC_RPC = "/api/v1/internal/engine/quote/spec";
export const ENGINE_QUOTE_EXPLAIN_RPC = "/api/v1/internal/engine/quote/explain";
/** 第三个切片：单证渲染数据装配链（7 张表，GET /trade-docs/{doc_id}/render-data）。 */
export const ENGINE_TRADE_DOCS_RENDER_DATA_RPC =
  "/api/v1/internal/engine/trade-docs/render-data";
/** 第四批：报价单列表 / 详情（控制台高频读，纯投影）。 */
export const ENGINE_QUOTES_LIST_RPC = "/api/v1/internal/engine/quotes/list";
export const ENGINE_QUOTES_DETAIL_RPC = "/api/v1/internal/engine/quotes/detail";

/**
 * 同族只读切片的路由 id（AUTH_DB_SPLIT_ROUTES 白名单条目，口径 <域>.<端点>）。
 * ⚠️ boot-flag.ts 的 DIRECT_ROUTE_IDS 由另一批次维护（本批不改该文件）——
 * useDirectRoute 只消费字符串，因此用同一命名口径的本地常量，语义完全一致。
 */
export const ENGINE_ROUTE_IDS = {
  verify: "export-quote.verify",
  formulas: "export-quote.formulas",
  spec: "export-quote.spec",
  explain: "export-quote.explain",
  renderData: "trade-docs.render-data",
  quotesList: "quotes.list",
  quotesDetail: "quotes.detail",
} as const;

/** 与 Python quote_api._PRICING_SEPARATOR 一致：定价数据 spec_hash 的「产品前缀」分隔符。 */
const PRICING_SEPARATOR = ":";

type Row = Record<string, unknown>;

/**
 * tenant_products 查询（quote_api.py _effective_product_raw 逐字直译）。
 * 列只有 spec/override/team_id —— 门面不解释它们，原样供数。
 */
export const TENANT_PRODUCTS_SQL =
  "SELECT spec, override, team_id FROM tenant_products"
  + " WHERE tenant_id=$1 AND product_key=$2 AND is_active";

/**
 * customer_cost_items 查询（quote_api.py _pricing_key_items 逐字直译）。
 * ⚠️ ORDER BY id DESC 有语义（「最新在前、先到先得」）：内核按行序去重，不能省。
 * ⚠️ left(spec_hash, length($2))=$2 不能用 LIKE：产品 key 里有下划线（field_fence），
 *    LIKE 会把下划线当通配符（真源注释同款警告）。
 */
export const CUSTOMER_COST_ITEMS_SQL =
  "SELECT id, customer_id, product_spec_json, spec_hash, amount, unit,"
  + " effective_from, source, notes, created_at"
  + " FROM customer_cost_items"
  + " WHERE tenant_id=$1 AND left(spec_hash, length($2))=$2 AND status='active'"
  + " AND customer_id=$3 ORDER BY id DESC";

/** Python _tenant_of(user)：users 行没有 tenant_id 列 ⇒ 恒 "default"。 */
function tenantOf(): string {
  return DEFAULT_TENANT;
}

/**
 * Python _customer_of(user)：customer_code || customer_id || tenant。
 * 当前 users 表没有这两列（真源注释：线上回退到租户），因此实际恒 "default"；
 * 仍按同一表达式实现，将来加列时两端一起生效。
 */
function customerOf(user: CurrentUser): string {
  const code = user.customer_code;
  const cid = user.customer_id;
  return String(code || (cid ? String(cid) : "") || tenantOf());
}

/**
 * tenant_products 行 → 供数行（契约 §6.3 类型口径）：
 * - spec/override 是 JSONB ⇒ postgres.js 已解码为对象，原样传（Python 侧不再 decode）；
 * - team_id 是 BIGINT ⇒ postgres.js 给 string，必须归一为 number（内核按 null 判历史行）。
 */
function tenantProductRow(row: Row): Row {
  return {
    spec: row.spec ?? null,
    override: row.override ?? null,
    team_id: row.team_id === null || row.team_id === undefined ? null : num(row.team_id),
  };
}

/**
 * customer_cost_items 行 → 供数行：
 * id/amount 归一为 number；时间戳按 Python isoformat 口径（+00:00）。
 * product_spec_json 是 JSONB ⇒ 已解码对象，原样传。
 */
function costItemRow(row: Row): Row {
  return {
    id: num(row.id),
    customer_id: row.customer_id ?? null,
    product_spec_json: row.product_spec_json ?? null,
    spec_hash: row.spec_hash ?? null,
    amount: row.amount === null || row.amount === undefined ? null : Number(row.amount),
    unit: row.unit ?? null,
    effective_from: pyIso(row.effective_from) ?? null,
    source: row.source ?? null,
    notes: row.notes ?? null,
    created_at: pyIso(row.created_at) ?? null,
  };
}

function isRecord(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 供数信封：契约 §6.3 的 datasets（每个 dataset 只出现一次）。 */
interface QuoteDatasets {
  tenant_products: Row[];
  customer_cost_items: Row[];
}

interface SupplyOptions {
  /** 是否查客户定价数据（旧 handler 只在需要时查；缺省查）。 */
  withCostItems?: boolean;
  /** 定价数据的 customer_id 谓词（旧 SQL 的 $3；缺省 = 当前客户 _customer_of）。 */
  costCustomerId?: string | null;
}

/**
 * 供数（**唯一 DB 访问点**）：谓词/排序与 Python 真源逐字一致。
 *
 * 两条 SQL 放在**同一个** withDb 里（与旧路径的连接复用口径一致）；
 * 旧路径对同一份定价数据可能查两次（客户自建档位 + 成本表），契约要求每个
 * dataset 只出现一次，内核按同一份行复用（两次查询之间无写，语义等价）。
 */
async function supplyQuoteDatasets(
  env: Env,
  user: CurrentUser,
  productKey: string,
  options: SupplyOptions = {},
): Promise<QuoteDatasets> {
  const withCostItems = options.withCostItems !== false;
  const tenant = tenantOf();
  const cid = options.costCustomerId || customerOf(user);
  return withDb(env, async (sql: Db) => {
    const tenantRows = (await sql.unsafe(
      TENANT_PRODUCTS_SQL,
      [tenant, productKey] as never[],
    )) as unknown as Row[];
    let costRows: Row[] = [];
    if (withCostItems) {
      costRows = (await sql.unsafe(
        CUSTOMER_COST_ITEMS_SQL,
        [tenant, productKey + PRICING_SEPARATOR, cid] as never[],
      )) as unknown as Row[];
    }
    return {
      tenant_products: tenantRows.map(tenantProductRow),
      customer_cost_items: costRows.map(costItemRow),
    };
  });
}

/** 内部令牌的角色快照（§6.2：判定依据必须由签名保护，不能来自 payload）。 */
function engineActorOf(user: CurrentUser) {
  return {
    id: user.id,
    tenantId: tenantOf(),
    teamId: user.team_id,
    role: user.role,
    accountType: user.account_type,
    isTenantAdmin: user.is_tenant_admin === true,
  };
}

/** payload.actor（§6.3）：与签发令牌的身份**同一份快照**，内核只做交叉核对。 */
function actorPayloadOf(user: CurrentUser): Row {
  return {
    id: user.id,
    tenant_id: tenantOf(),
    team_id: user.team_id,
    role: user.role,
    account_type: user.account_type,
    is_tenant_admin: user.is_tenant_admin === true,
  };
}

/**
 * 调用内核 RPC 并**原样回放**：status < 500 ⇒ 回放 body + 该状态码；
 * status >= 500 ⇒ 按 proxy 同口径归一到 kernel_error；不可达 ⇒ 502 kernel_unavailable。
 *
 * 与透传共用 kernel.ts 的重试策略（body 是字符串 ⇒ 可重放；只读引擎调用虽 POST
 * 但语义幂等，本期仍保持保守的「至多 1 次」重试策略，见契约 §6.1）。
 */
async function engineQuoteRpc(
  c: Context<{ Bindings: Env }>,
  rpcPath: string,
  jwt: string,
  payload: string,
): Promise<Response> {
  const env = getEnv(c);
  const url = new URL(rpcPath, KERNEL_BASE);
  const plan = planKernelRetry("POST", true);
  const result = await fetchKernelWithRetry(env.KERNEL, plan, () =>
    new Request(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + jwt,
      },
      body: payload,
    }),
  );

  if (!result.response) {
    console.error(
      "[engine] kernel_unavailable path=" + rpcPath
      + " attempts=" + String(result.attempts)
      + " elapsed_ms=" + String(result.elapsedMs)
      + " last_error=" + String(result.lastError),
    );
    return c.json(kernelUnavailableEnvelope(result), 502, {
      "Retry-After": String(KERNEL_UNAVAILABLE_RETRY_AFTER_SECONDS),
    });
  }

  const upstream = result.response;
  if (upstream.status >= 500) {
    // 与 proxy 同口径：内核 5xx 归一为 kernel_error（不把内部异常串甩给用户）
    const text = await upstream.text();
    return c.json(
      { error: "kernel_error", message: text.slice(0, 500), status: upstream.status },
      upstream.status as 500,
    );
  }

  // ── 4xx 原样回放（与 proxy 同口径）────────────────────────────────────
  // 内核的**工位订阅闸门是全局中间件**，它在 handler 之前就返回 404
  // {error:"not_found",code:"WORKSTATION_NOT_SUBSCRIBED",...} —— 形状不是 RPC 信封。
  // 这类"内核对已鉴权身份的裁决"必须逐字回放给用户（否则会变成 502 信封格式错误）。
  // 判据：非 2xx 一律按「原样透传」处理，与 /api 透传路径行为一致。
  if (upstream.status !== 200) {
    const text = await upstream.text();
    const status = upstream.status;
    try {
      return c.json(JSON.parse(text) as never, status as never);
    } catch {
      return c.json(
        { error: "kernel_error", message: "engine rpc non-JSON body (status " + String(status) + "): " + text.slice(0, 200), status },
        status as never,
      );
    }
  }

  let envelope: unknown;
  try {
    envelope = await upstream.json();
  } catch {
    // 诊断增强（2026-10-24）：非 JSON 响应必须能看出「谁、什么状态码、什么内容」，
    // 否则只能猜（本次先被误判为资产层 SPA 回退）。只回传前 200 字符，且控制台留全量。
    const text = await upstream.text().catch(() => "");
    const head = text.slice(0, 200);
    console.error(
      "[engine] rpc non-JSON status=" + String(upstream.status) + " path=" + rpcPath
      + " body_head=" + head,
    );
    return c.json(
      {
        error: "kernel_error",
        message: "engine rpc returned non-JSON body (status " + String(upstream.status) + "): " + head,
        status: 502,
      },
      502,
    );
  }
  if (!isRecord(envelope) || typeof envelope.status !== "number" || !("body" in envelope)) {
    return c.json(
      { error: "kernel_error", message: "engine rpc envelope invalid", status: 502 },
      502,
    );
  }
  const status = envelope.status;
  if (status >= 500) {
    // 契约上内核不该把业务错误包成 5xx（它自己的 5xx 已在上游分支处理）；仍防御一次
    return c.json(
      { error: "kernel_error", message: "engine rpc business status " + String(status), status },
      502,
    );
  }
  return c.json(envelope.body as never, status as never);
}

/**
 * POST 类切片的骨架（calculate / verify）：读请求体 → 供数 → 内部令牌 → RPC → 回放。
 *
 * 不校验请求体：模型校验仍在内核同一份 pydantic（保证 422 信封逐字一致）；
 * 这里只读 product_key 以便取数，取不到就退回旧透传由内核裁决。
 */
async function postQuoteSlice(
  c: Context<{ Bindings: Env }>,
  user: CurrentUser,
  rpcPath: string,
): Promise<Response> {
  const env = getEnv(c);
  const secret = requireSecret(env, "JWT_SECRET");

  let body: unknown;
  try {
    // ⚠️ 必须从 clone 读：fallback 要原样透传（forwardKernelRequest 还会重放 body），
    // 直接 c.req.json() 会把请求流消费掉 ⇒ 旧路径 503 "body disturbed or locked"。
    body = await c.req.raw.clone().json();
  } catch {
    // 非法 JSON：旧路径（内核 FastAPI）出 422 json_invalid；门面不自拼第二份错误体
    return forwardKernelRequest(c);
  }
  if (!isRecord(body) || typeof body.product_key !== "string" || body.product_key === "") {
    return forwardKernelRequest(c);
  }

  const datasets = await supplyQuoteDatasets(env, user, body.product_key);
  const jwt = await mintEngineJwt(engineActorOf(user), secret);
  return engineQuoteRpc(
    c,
    rpcPath,
    jwt,
    JSON.stringify({ request: body, actor: actorPayloadOf(user), datasets }),
  );
}

/**
 * POST /api/v1/export-quote/calculate 的「供数 + RPC」实现（开关 on 时）。
 */
export async function calculateWithKernel(
  c: Context<{ Bindings: Env }>,
  user: CurrentUser,
): Promise<Response> {
  return postQuoteSlice(c, user, ENGINE_QUOTE_CALCULATE_RPC);
}

/**
 * POST /api/v1/export-quote/verify 的「供数 + RPC」实现（开关 on 时）。
 *
 * 与 calculate **同一份供数**（旧路径 verify 也是「有效产品定义 + 成本表」）；
 * 管理员角色判定在**内核**（内部令牌角色快照 → 同一份 _require_internal_admin），
 * 门面不做第二份判定 ⇒ 403 与旧路径逐字相同。
 */
export async function verifyWithKernel(
  c: Context<{ Bindings: Env }>,
  user: CurrentUser,
): Promise<Response> {
  return postQuoteSlice(c, user, ENGINE_QUOTE_VERIFY_RPC);
}

/**
 * GET 类切片的骨架（formulas / spec）：路径参数 + 供数 → 内部令牌 → RPC → 回放。
 * request 段 = {product_key, query?}（GET 没有请求体；query 原始字符串原样透传，
 * 解析/校验在内核同一份 pydantic 口径里）。
 */
async function getQuoteSlice(
  c: Context<{ Bindings: Env }>,
  user: CurrentUser,
  rpcPath: string,
  request: Row,
  supply: SupplyOptions,
): Promise<Response> {
  const env = getEnv(c);
  const secret = requireSecret(env, "JWT_SECRET");
  const productKey = c.req.param("product_key") ?? "";
  const datasets = await supplyQuoteDatasets(env, user, productKey, supply);
  const jwt = await mintEngineJwt(engineActorOf(user), secret);
  return engineQuoteRpc(
    c,
    rpcPath,
    jwt,
    JSON.stringify({ request, actor: actorPayloadOf(user), datasets }),
  );
}

/**
 * formulas 的 query 取值 → 供数决策：旧 handler 只在 with_customer_options 为真时
 * 查客户定价数据。这里按旧口径**宽松**判断（显式 false 系列才算 false），非法值
 * 不在这里报错 —— 内核用同一份 pydantic 口径报 422，门面不写第二份校验。
 * 多查一份数据对内核无害（with_customer_options=false 时内核忽略该 dataset）。
 */
function queryBoolTruthy(raw: string | null): boolean {
  if (raw === null) return true; // 旧端点默认值 with_customer_options=True
  return !/^(0|false|f|no|n|off)$/i.test(raw.trim());
}

/**
 * GET /api/v1/export-quote/products/{product_key}/formulas 的「供数 + RPC」实现。
 *
 * 供数决策与旧 handler 逐条对应：
 * - 产品定义：tenant_products（团队谓词在 SQL 里，与旧路径同一条）；
 * - 客户自建档位：with_customer_options=True 时查 customer_cost_items，customer_id
 *   只对管理员生效（Python _can_see_all = rules.ts isAdminRole 同一把尺），否则
 *   回落到当前客户（_customer_of）。
 */
export async function formulasWithKernel(
  c: Context<{ Bindings: Env }>,
  user: CurrentUser,
): Promise<Response> {
  const productKey = c.req.param("product_key") ?? "";
  const query: Row = {
    with_columns: c.req.query("with_columns") ?? null,
    with_customer_options: c.req.query("with_customer_options") ?? null,
    customer_id: c.req.query("customer_id") ?? null,
  };
  const withCustomerOptions = queryBoolTruthy(
    query.with_customer_options === null ? null : String(query.with_customer_options),
  );
  const rawCustomerId = query.customer_id === null ? null : String(query.customer_id);
  const costCustomerId = rawCustomerId && isAdminRole(user.role) ? rawCustomerId : null;
  return getQuoteSlice(
    c,
    user,
    ENGINE_QUOTE_FORMULAS_RPC,
    { product_key: productKey, query },
    { withCostItems: withCustomerOptions, costCustomerId },
  );
}

/**
 * GET /api/v1/export-quote/products/{product_key}/spec 的「供数 + RPC」实现。
 * 旧 handler = _effective_product（租户行 + 客户自建档位）⇒ 两个 dataset 都要。
 */
export async function specWithKernel(
  c: Context<{ Bindings: Env }>,
  user: CurrentUser,
): Promise<Response> {
  const productKey = c.req.param("product_key") ?? "";
  return getQuoteSlice(
    c,
    user,
    ENGINE_QUOTE_SPEC_RPC,
    { product_key: productKey },
    {},
  );
}

/**
 * POST /api/v1/export-quote/products/{product_key}/explain 的「供数 + RPC」实现。
 *
 * 供数决策与旧 handler 逐条对应（_product_or_404_tenant）：
 * - spec_override 分支**完全不读库**（草稿定义代替注册表）⇒ 不供数；
 * - 否则**只**读 tenant_products，**不查**客户定价数据（explain 不并入客户档位）。
 */
export async function explainWithKernel(
  c: Context<{ Bindings: Env }>,
  user: CurrentUser,
): Promise<Response> {
  const env = getEnv(c);
  const secret = requireSecret(env, "JWT_SECRET");
  const productKey = c.req.param("product_key") ?? "";

  let body: unknown;
  try {
    body = await c.req.raw.clone().json();
  } catch {
    return forwardKernelRequest(c);
  }
  if (!isRecord(body)) {
    return forwardKernelRequest(c);
  }
  const useDraft = body.spec_override !== undefined && body.spec_override !== null;
  const datasets: QuoteDatasets = useDraft
    ? { tenant_products: [], customer_cost_items: [] }
    : await supplyQuoteDatasets(env, user, productKey, { withCostItems: false });
  const jwt = await mintEngineJwt(engineActorOf(user), secret);
  return engineQuoteRpc(
    c,
    ENGINE_QUOTE_EXPLAIN_RPC,
    jwt,
    JSON.stringify({
      request: { product_key: productKey, body },
      actor: actorPayloadOf(user),
      datasets,
    }),
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// 第三个切片：GET /api/v1/trade-docs/{doc_id}/render-data（7 张表的装配链）
// ══════════════════════════════════════════════════════════════════════════════
// 设计 = docs/P2_COUPLING_ENGINE_2026-10-24.md §6.3 / §9 第 2 项；内核入口
// POST /api/v1/internal/engine/trade-docs/render-data（engine_api.py）。
//
// 与 quotes 同族切片的差异（**契约**，由 golden fixture 的 facade 段锁定）：
// - 装配链是「读一步、按结果再决定读什么」（P2 §7.2 的 C 类形态）⇒ 门面按
//   main.py._render_dataset_plan 的**最小集合**供数；条件只依赖**数据形状**
//   （customer_id 是否整数、有没有照片引用），业务判定（with_seal / company_stamp /
//   product_key_of / 团队可见性）全部留在内核同一份纯装配里；
// - product_profiles 下发**整表**（租户内一行/产品），由内核按 product_key_of 选行
//   —— 门面不复制 product_key_of 判定；
// - tenant_company_seals 恒下发 1 行（是否使用由内核 with_seal/company_stamp 判定）；
// - 图片/公章是**短期签名直链**：host 由门面从用户请求带进 payload.request.request_context，
//   内核按白名单校验后用 OriginalHost 签名（否则链接会指向内核 host）。
//   无 JWT_SECRET 时内核明确 503（已登记边界：生产/测试都有 secret）。
// - 时间戳列用 to_char 生成 Python isoformat 口径（微秒 + +00:00）：postgres.js 的
//   JS Date 只有毫秒，直接下发会在真实数据下把 doc.updated_at 等字段静默截断。
// - ⚠️ 微秒为 0 时 Python isoformat **省略小数部分**（2026-10-24T03:04:05+00:00），
//   而 to_char 的 'US' 恒输出 .000000（docs §8.9 真库核对抓到的 parity 缺口）⇒
//   时间戳片段必须**条件式**，见 tsIsoSql()（唯一一处格式化契约）。

/**
 * 时间戳列 → Python `datetime.isoformat()` 口径文本（**唯一一处**格式化契约）。
 *
 * 两条真实口径（docs §8.9）：
 * - 微秒非 0：`2026-10-24T03:04:05.123456+00:00`（6 位小数）；
 * - 微秒为 0：`2026-10-24T03:04:05+00:00`（**无**小数；Python isoformat 省略）。
 * 所以不能直接 `to_char(... 'US')`（恒 6 位）—— 先判 US 再选格式，统一拼 +00:00。
 */
export function tsIsoSql(col: string): string {
  const utc = col + " AT TIME ZONE 'UTC'";
  return "CASE WHEN to_char(" + utc + ", 'US') = '000000'"
    + " THEN to_char(" + utc + ", 'YYYY-MM-DD\"T\"HH24:MI:SS')"
    + " ELSE to_char(" + utc + ", 'YYYY-MM-DD\"T\"HH24:MI:SS.US')"
    + " END || '+00:00' AS " + col;
}

/** trade_docs 行（列清单与 SELECT 逐字对应；BIGINT/NUMERIC 归一，见契约 §6.3）。 */
export const TRADE_DOCS_RENDER_SQL =
  "SELECT id, tenant_id, doc_no, doc_type, order_id, customer_id, quote_id,"
  + " status, currency, total_amount, " + tsIsoSql("issued_at")
  + ", issued_by, raw_payload, owner_id, owner_scope, team_id, with_seal, "
  + tsIsoSql("created_at") + ", " + tsIsoSql("updated_at")
  + " FROM trade_docs WHERE tenant_id=$1 AND id=$2";

export const TENANT_PROFILE_RENDER_SQL =
  "SELECT * FROM tenant_company_profile WHERE tenant_id=$1";

export const CUSTOMERS_RENDER_SQL =
  "SELECT id, name, address FROM customers WHERE tenant_id=$1 AND id=$2";

export const CUST_CONTACTS_RENDER_SQL =
  "SELECT name, phone, email FROM cust_contacts"
  + " WHERE tenant_id=$1 AND customer_id=$2 ORDER BY is_primary DESC, id LIMIT 1";

/** 默认公章：**不下发 png_bytes**（字节列不进 JSON；签名直链可用时不需要）。 */
export const DEFAULT_SEAL_RENDER_SQL =
  "SELECT id, mime FROM tenant_company_seals"
  + " WHERE tenant_id=$1 AND is_default ORDER BY id LIMIT 1";

/** 产品档案：**整表**下发（旧路径按 key 查；哪一行参与由内核 product_key_of 决定）。 */
export const PRODUCT_PROFILES_RENDER_SQL =
  "SELECT product_key, info, team_id FROM product_profiles WHERE tenant_id=$1";

/**
 * 产品图文件行：按 id **批量**（旧路径逐张查）。
 * 列不含 content（字节）；多下发 id（旧路径 id 在谓词里，供数路径要按 id 对回引用）。
 * 团队谓词与 ws_files._team_scope 同一把尺（见 renderFileTeamScope）。
 */
export const FILE_OBJECTS_RENDER_SQL =
  "SELECT id, name, content_type, file_name, object_key, storage, team_id"
  + " FROM file_objects WHERE tenant_id=$1 AND id = ANY($2) AND is_current";

/** Python int() 的可转口径（BIGINT 经 postgres.js 是 string）。 */
function intOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

/**
 * doc.raw_payload.custom.product_photos 里**可解析的 file_id**（供数用，允许超集）。
 *
 * 内核仍用 kaas_common.files.is_file_ref 做最终判定：这里只把「像 id 的」都带上
 * （含带 image/src 的条目），多给无害、少给会让内核缺行。
 */
function photoFileIds(docRow: Row | undefined): number[] {
  const payload = isRecord(docRow?.raw_payload) ? docRow.raw_payload : {};
  const custom = isRecord(payload.custom) ? payload.custom : {};
  const photos = Array.isArray(custom.product_photos) ? custom.product_photos : [];
  const ids = new Set<number>();
  for (const entry of photos) {
    if (!isRecord(entry)) continue;
    const id = intOrNull(entry.file_id);
    if (id !== null && id > 0) ids.add(id);
  }
  return [...ids];
}

/**
 * 产品图文件行的团队谓词（逐行镜像 ws_files._team_scope(user, 3)）。
 *
 * - 管理员 ⇒ 不加谓词（含历史 team_id IS NULL 行）；
 * - 有团队 ⇒ AND team_id=$3；
 * - **无团队 ⇒ 不下发**：render-data 对无团队客户一律 404（D3，内核 _require_doc_visible
 *   判定），照片行不会被用到。**不能**在这里抛 403 —— 那是列表端点的 NO_TEAM 口径，
 *   会在内核 404 之前改变状态码。
 */
function renderFileTeamScope(user: CurrentUser): {
  frag: string;
  extra: unknown[];
  skip: boolean;
} {
  if (isAdminRole(user.role)) return { frag: "", extra: [], skip: false };
  if (user.team_id === null || user.team_id === undefined) {
    return { frag: "", extra: [], skip: true };
  }
  return { frag: " AND team_id=$3", extra: [user.team_id], skip: false };
}

/** trade_docs 行 → dataset 行（BIGINT/NUMERIC 归一；时间戳已是 Python 口径文本）。 */
function tradeDocRenderRow(row: Row): Row {
  const boolOrNull = (value: unknown): boolean | null => {
    if (value === null || value === undefined) return null;
    return value === true || value === "t" || value === "true";
  };
  const numberOrNull = (value: unknown): number | null => {
    if (value === null || value === undefined) return null;
    return Number(value);
  };
  return {
    id: num(row.id),
    tenant_id: row.tenant_id ?? null,
    doc_no: row.doc_no ?? null,
    doc_type: row.doc_type ?? null,
    order_id: num(row.order_id),
    customer_id: num(row.customer_id),
    quote_id: num(row.quote_id),
    status: row.status ?? null,
    currency: row.currency ?? null,
    total_amount: numberOrNull(row.total_amount),
    issued_at: row.issued_at ?? null,
    issued_by: row.issued_by ?? null,
    raw_payload: row.raw_payload ?? null,
    owner_id: row.owner_id ?? null,
    owner_scope: row.owner_scope ?? null,
    team_id: num(row.team_id),
    with_seal: boolOrNull(row.with_seal),
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
  };
}

/** 供数契约（§6.3 + 本切片 facade 段）：7 个 dataset，每个只出现一次。 */
interface RenderDataDatasets {
  trade_docs: Row[];
  tenant_company_profile: Row[];
  customers: Row[];
  cust_contacts: Row[];
  tenant_company_seals: Row[];
  product_profiles: Row[];
  file_objects: Row[];
}

/**
 * render-data 供数（**唯一 DB 访问点**）：7 个 dataset，条件只依赖**数据形状**。
 *
 * 顺序与旧路径一致（单证 → 企业主体 → 客户/联系人 → 产品图 → 默认章 → 产品档案），
 * 便于与 kernel 侧的「旧路径 SQL 不变」断言对照；判定一律留在内核。
 */
async function supplyRenderDatasets(
  env: Env,
  user: CurrentUser,
  docId: number,
): Promise<RenderDataDatasets> {
  const tenant = tenantOf();
  return withDb(env, async (sql: Db) => {
    const docRows = (await sql.unsafe(
      TRADE_DOCS_RENDER_SQL,
      [tenant, docId] as never[],
    )) as unknown as Row[];
    const docRow = docRows[0];
    const profileRows = (await sql.unsafe(
      TENANT_PROFILE_RENDER_SQL,
      [tenant] as never[],
    )) as unknown as Row[];

    let customerRows: Row[] = [];
    let contactRows: Row[] = [];
    const customerId = docRow ? intOrNull(docRow.customer_id) : null;
    if (customerId !== null) {
      customerRows = (await sql.unsafe(
        CUSTOMERS_RENDER_SQL,
        [tenant, customerId] as never[],
      )) as unknown as Row[];
      contactRows = (await sql.unsafe(
        CUST_CONTACTS_RENDER_SQL,
        [tenant, customerId] as never[],
      )) as unknown as Row[];
    }

    let fileRows: Row[] = [];
    const fileIds = docRow ? photoFileIds(docRow) : [];
    const scope = renderFileTeamScope(user);
    if (fileIds.length > 0 && !scope.skip) {
      fileRows = (await sql.unsafe(
        FILE_OBJECTS_RENDER_SQL + scope.frag,
        [tenant, fileIds, ...scope.extra] as never[],
      )) as unknown as Row[];
    }

    const sealRows = (await sql.unsafe(
      DEFAULT_SEAL_RENDER_SQL,
      [tenant] as never[],
    )) as unknown as Row[];
    const productRows = (await sql.unsafe(
      PRODUCT_PROFILES_RENDER_SQL,
      [tenant] as never[],
    )) as unknown as Row[];

    return {
      trade_docs: docRows.map(tradeDocRenderRow),
      // tenant_company_profile：只取文本字段（卖方/银行/默认条款），数值列类型不影响响应
      tenant_company_profile: profileRows.map((row) => ({ ...row })),
      customers: customerRows.map((row) => ({
        id: num(row.id),
        name: row.name ?? null,
        address: row.address ?? null,
      })),
      cust_contacts: contactRows.map((row) => ({
        name: row.name ?? null,
        phone: row.phone ?? null,
        email: row.email ?? null,
      })),
      tenant_company_seals: sealRows.map((row) => ({
        id: num(row.id),
        mime: row.mime ?? null,
      })),
      product_profiles: productRows.map((row) => ({
        product_key: row.product_key ?? null,
        info: row.info ?? null,
        team_id: num(row.team_id),
      })),
      file_objects: fileRows.map((row) => ({
        id: num(row.id),
        name: row.name ?? null,
        content_type: row.content_type ?? null,
        file_name: row.file_name ?? null,
        object_key: row.object_key ?? null,
        storage: row.storage ?? null,
        team_id: num(row.team_id),
      })),
    };
  });
}

/**
 * GET /api/v1/trade-docs/{doc_id}/render-data 的「供数 + RPC」实现（开关 on 时）。
 *
 * 门禁全在**内核**（_require_doc_visible：单证不存在/无团队/不可见一律 404 DOC_NOT_FOUND）——
 * 门面不自建第二份可见性判定；未授权请求确实会先多读若干行（响应仍是 404，已登记）。
 */
export async function renderDataWithKernel(
  c: Context<{ Bindings: Env }>,
  user: CurrentUser,
): Promise<Response> {
  const env = getEnv(c);
  const secret = requireSecret(env, "JWT_SECRET");
  const docId = intOrNull(c.req.param("doc_id") ?? "");
  if (docId === null) {
    // 非整数 doc_id：旧路径（FastAPI path 参数）会 422，交给旧路径裁决（不自拼错误体）
    return forwardKernelRequest(c);
  }
  const datasets = await supplyRenderDatasets(env, user, docId);
  const jwt = await mintEngineJwt(engineActorOf(user), secret);
  const url = new URL(c.req.url);
  const requestContext = {
    host: c.req.header("host") ?? url.host,
    x_forwarded_proto: (c.req.header("x-forwarded-proto") ?? url.protocol.replace(":", "")).toLowerCase(),
  };
  return engineQuoteRpc(
    c,
    ENGINE_TRADE_DOCS_RENDER_DATA_RPC,
    jwt,
    JSON.stringify({
      request: { doc_id: docId, request_context: requestContext },
      actor: actorPayloadOf(user),
      datasets,
    }),
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// 第四批切片：GET /api/v1/quotes（列表）+ GET /api/v1/quotes/{quote_id}（详情）
// ══════════════════════════════════════════════════════════════════════════════
// 设计 = docs/P2_COUPLING_ENGINE_2026-10-24.md §6（契约）/ §8（切片范式）；内核入口
// POST /api/v1/internal/engine/quotes/{list,detail}（engine_api.py）。
//
// 真源（SQL 谓词/排序/分页**逐字直译**，禁止顺手优化）：
// - quote_api.py:2023 list_quote_orders / :2454 get_quote_order
// - quote_api.py:_scope_sql（可见性谓词；纯函数真源 = kaas_common.workstation.scope.can_view）
// 与旧路径的**有意差异**（fixture.facade 锁定，语义等价）：
// - quote_orders 用**显式列**而非 SELECT *：BIGINT/NUMERIC 归一成 number；时间戳用
//   tsIsoSql 条件式（零微秒无小数，docs §8.9）；DATE 列用 to_char(col,'YYYY-MM-DD')
//   （Python date.isoformat 口径）。postgres.js 的 JS Date 只有毫秒、DATE 会给午夜时间串，
//   直接透传都会与内核序列化口径不一致；
// - COUNT(*) 加 AS count（dataset 需要一个列名）；
// - 行数 GROUP BY / 两条锁定查询的谓词与旧路径逐字一致（列表：ANY 批量；详情：C 类形态
//   —— trade_docs 有行就不再查 orders，门面按同一条件取数）；
// - 可见性谓词下推（门面按 _scope_sql 直译）**并且**内核用共享 can_view 再判一次
//   （防御纵深：门面漏滤不会变成越权，见 quote_api._quote_row_visible）。

/** Python date.isoformat() 口径（DATE 列：无时间、无时区）。 */
export function dateIsoSql(col: string): string {
  return "to_char(" + col + ", 'YYYY-MM-DD') AS " + col;
}

/** quote_orders 显式列清单（与表结构一致；时间戳/日期按 Python isoformat 口径转文本）。 */
export const QUOTE_ORDER_COLUMNS =
  "id, tenant_id, quote_no, customer_id, customer_name, inquiry_id, status, currency,"
  + " total_amount, " + tsIsoSql("valid_until") + ", notes, fx_rate, " + dateIsoSql("fx_rate_date")
  + ", tax_archive_id, tax_archive_code, tax_archive_name, tax_snapshot, incoterm, payment_terms,"
  + " port_of_loading, port_of_destination, shipping_marks, country_of_origin, destination_country,"
  + " destination_region, carrier, " + dateIsoSql("freight_valid_from")
  + ", " + dateIsoSql("freight_valid_to")
  + ", created_by, owner_id, owner_scope, team_id, " + tsIsoSql("created_at")
  + ", " + tsIsoSql("updated_at");

/** quote_order_items 显式列清单（行项详情用）。 */
export const QUOTE_ITEM_COLUMNS =
  "id, tenant_id, quote_order_id, sku_id, product_name, spec_snapshot, qty, qty_unit,"
  + " unit_price, currency, line_amount, sort_order, policy_override, price_source,"
  + " cost_override, price_override, weight_override, volume_override, image_url,"
  + " cost_breakdown, " + tsIsoSql("created_at");

/** 列表总行数（旧路径 SELECT COUNT(*)；门面多给列名以便下发 dataset）。 */
export function quoteOrdersCountSql(cond: string): string {
  return "SELECT COUNT(*) AS count FROM quote_orders WHERE " + cond;
}

/** 列表当前页（排序/分页与旧路径逐字一致；condParamCount = WHERE 参数个数）。 */
export function quoteOrdersListSql(cond: string, condParamCount: number): string {
  return "SELECT " + QUOTE_ORDER_COLUMNS + " FROM quote_orders WHERE " + cond
    + " ORDER BY created_at DESC, id DESC LIMIT $" + String(condParamCount + 1)
    + " OFFSET $" + String(condParamCount + 2);
}

/** 详情单头（可见性谓词由 quoteScopeCond 拼进 cond）。 */
export function quoteOrdersDetailSql(cond: string): string {
  return "SELECT " + QUOTE_ORDER_COLUMNS + " FROM quote_orders WHERE " + cond;
}

/** 列表行数（一次 GROUP BY，不做 N+1；与 quote_api._item_count_map 逐字同义）。 */
export const QUOTE_ITEM_COUNTS_SQL = "SELECT quote_order_id, COUNT(*) AS n FROM quote_order_items"
  + " WHERE tenant_id=$1 AND quote_order_id = ANY($2::bigint[]) GROUP BY quote_order_id";

/** 详情行项（与 quote_api._items_of 逐字同义）。 */
export const QUOTE_ORDERS_ITEMS_DETAIL_SQL = "SELECT " + QUOTE_ITEM_COLUMNS
  + " FROM quote_order_items WHERE tenant_id=$1 AND quote_order_id=$2 ORDER BY sort_order, id";

/** 列表：下游单证锁定（非 quotation 的单证）。 */
export const TRADE_DOCS_LOCKED_LIST_SQL = "SELECT DISTINCT quote_id FROM trade_docs"
  + " WHERE tenant_id=$1 AND quote_id = ANY($2::bigint[]) AND doc_type <> 'quotation'";

/** 列表：下游订单锁定。 */
export const ORDERS_LOCKED_LIST_SQL = "SELECT DISTINCT quote_id FROM orders"
  + " WHERE tenant_id=$1 AND quote_id = ANY($2::bigint[])";

/** 详情：下游单证锁定（旧路径 SELECT 1，这里给列名以便下发 dataset）。 */
export const TRADE_DOCS_LOCK_DETAIL_SQL = "SELECT 1 AS locked FROM trade_docs"
  + " WHERE tenant_id=$1 AND quote_id=$2 AND doc_type <> 'quotation' LIMIT 1";

/** 详情：下游订单锁定（**只在上一查无行时**才发，同旧路径）。 */
export const ORDERS_LOCK_DETAIL_SQL = "SELECT 1 AS locked FROM orders"
  + " WHERE tenant_id=$1 AND quote_id=$2 LIMIT 1";

/**
 * query 原始字符串 → 宽松整数（**只用于拼 SQL 参数**）。
 *
 * 校验（422 int_parsing / ge / le）一律在内核用同一份 pydantic 做 —— 门面不写第二份判定；
 * 非法值在这里退化成 null/默认值，内核随后 422 ⇒ 用户看到的响应与旧路径逐字一致。
 */
function lenientInt(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const text = raw.trim();
  if (!/^[+-]?\d+$/.test(text)) return null;
  return Number(text);
}

/** 可见性谓词（quote_api._scope_sql 逐字直译）：管理员不加；否则 owner/tenant共享/本团队。 */
function quoteScopeCond(user: CurrentUser, params: unknown[]): string {
  if (isAdminRole(user.role)) return "";
  params.push(String(user.id));
  let cond = "(owner_id = $" + String(params.length) + " OR owner_scope = 'tenant'";
  if (user.team_id !== null && user.team_id !== undefined) {
    params.push(user.team_id);
    cond += " OR team_id = $" + String(params.length);
  }
  return " AND " + cond + ")";
}

interface QuoteListFilter {
  cond: string;
  params: unknown[];
  page: number;
  pageSize: number;
}

/** 列表筛选/分页 → 与旧 handler **同一 SQL 谓词、同一参数顺序**（status → customer → inquiry）。 */
function quoteListFilter(user: CurrentUser, query: Record<string, string | null>): QuoteListFilter {
  const where = ["tenant_id = $1"];
  const params: unknown[] = [tenantOf()];
  const status = query.status ?? "";
  if (status) {
    params.push(status);
    where.push("status = $" + String(params.length));
  }
  const customerId = lenientInt(query.customer_id);
  if (customerId) {
    params.push(customerId);
    where.push("customer_id = $" + String(params.length));
  }
  const inquiryId = lenientInt(query.inquiry_id);
  if (inquiryId !== null) {
    params.push(inquiryId);
    where.push("inquiry_id = $" + String(params.length));
  }
  const cond = where.join(" AND ") + quoteScopeCond(user, params);
  const page = Math.max(1, lenientInt(query.page) ?? 1);
  const pageSize = Math.min(200, Math.max(1, lenientInt(query.page_size) ?? 20));
  return { cond, params, page, pageSize };
}

/** quote_orders 行 → dataset 行（BIGINT/NUMERIC 归一；时间戳/日期已是 Python 口径文本）。 */
export function quoteOrderDatasetRow(row: Row): Row {
  const numberOrNull = (value: unknown): number | null =>
    value === null || value === undefined ? null : Number(value);
  return {
    id: num(row.id),
    tenant_id: row.tenant_id ?? null,
    quote_no: row.quote_no ?? null,
    customer_id: num(row.customer_id),
    customer_name: row.customer_name ?? null,
    inquiry_id: num(row.inquiry_id),
    status: row.status ?? null,
    currency: row.currency ?? null,
    total_amount: numberOrNull(row.total_amount),
    valid_until: row.valid_until ?? null,
    notes: row.notes ?? null,
    fx_rate: numberOrNull(row.fx_rate),
    fx_rate_date: row.fx_rate_date ?? null,
    tax_archive_id: num(row.tax_archive_id),
    tax_archive_code: row.tax_archive_code ?? null,
    tax_archive_name: row.tax_archive_name ?? null,
    tax_snapshot: row.tax_snapshot ?? null,
    incoterm: row.incoterm ?? null,
    payment_terms: row.payment_terms ?? null,
    port_of_loading: row.port_of_loading ?? null,
    port_of_destination: row.port_of_destination ?? null,
    shipping_marks: row.shipping_marks ?? null,
    country_of_origin: row.country_of_origin ?? null,
    destination_country: row.destination_country ?? null,
    destination_region: row.destination_region ?? null,
    carrier: row.carrier ?? null,
    freight_valid_from: row.freight_valid_from ?? null,
    freight_valid_to: row.freight_valid_to ?? null,
    created_by: row.created_by ?? null,
    owner_id: row.owner_id ?? null,
    owner_scope: row.owner_scope ?? null,
    team_id: num(row.team_id),
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
  };
}

/** quote_order_items 行 → dataset 行。 */
export function quoteItemDatasetRow(row: Row): Row {
  const numberOrNull = (value: unknown): number | null =>
    value === null || value === undefined ? null : Number(value);
  return {
    id: num(row.id),
    tenant_id: row.tenant_id ?? null,
    quote_order_id: num(row.quote_order_id),
    sku_id: num(row.sku_id),
    product_name: row.product_name ?? null,
    spec_snapshot: row.spec_snapshot ?? null,
    qty: numberOrNull(row.qty),
    qty_unit: row.qty_unit ?? null,
    unit_price: numberOrNull(row.unit_price),
    currency: row.currency ?? null,
    line_amount: numberOrNull(row.line_amount),
    sort_order: num(row.sort_order),
    policy_override: row.policy_override ?? null,
    price_source: row.price_source ?? null,
    cost_override: numberOrNull(row.cost_override),
    price_override: numberOrNull(row.price_override),
    weight_override: numberOrNull(row.weight_override),
    volume_override: numberOrNull(row.volume_override),
    image_url: row.image_url ?? null,
    cost_breakdown: row.cost_breakdown ?? null,
    created_at: row.created_at ?? null,
  };
}

/** 列表供数（**唯一 DB 访问点**）：COUNT → 当前页 → 行数 → 两条锁定查询（后三步仅 ids 非空）。 */
async function supplyQuoteList(
  env: Env,
  user: CurrentUser,
  query: Record<string, string | null>,
): Promise<Row> {
  const filter = quoteListFilter(user, query);
  const tenant = tenantOf();
  return withDb(env, async (sql: Db) => {
    const totalRows = (await sql.unsafe(
      quoteOrdersCountSql(filter.cond),
      filter.params as never[],
    )) as unknown as Row[];
    const rows = (await sql.unsafe(
      quoteOrdersListSql(filter.cond, filter.params.length),
      [...filter.params, filter.pageSize, (filter.page - 1) * filter.pageSize] as never[],
    )) as unknown as Row[];
    const ids = rows.map((row) => Number(row.id));
    let countRows: Row[] = [];
    let tradeRows: Row[] = [];
    let orderRows: Row[] = [];
    if (ids.length > 0) {
      countRows = (await sql.unsafe(QUOTE_ITEM_COUNTS_SQL, [tenant, ids] as never[])) as unknown as Row[];
      tradeRows = (await sql.unsafe(
        TRADE_DOCS_LOCKED_LIST_SQL, [tenant, ids] as never[])) as unknown as Row[];
      orderRows = (await sql.unsafe(
        ORDERS_LOCKED_LIST_SQL, [tenant, ids] as never[])) as unknown as Row[];
    }
    return {
      quote_orders_total: totalRows.map((row) => ({ count: num0(row.count) })),
      quote_orders: rows.map(quoteOrderDatasetRow),
      quote_order_item_counts: countRows.map((row) => ({
        quote_order_id: num(row.quote_order_id),
        n: num0(row.n),
      })),
      trade_docs_locked: tradeRows.map((row) => ({ quote_id: num(row.quote_id) })),
      orders_locked: orderRows.map((row) => ({ quote_id: num(row.quote_id) })),
    };
  });
}

/** 详情供数：单头 → 行项 → 锁定两查（同旧路径 C 类形态：第一查有行就不再查第二查）。 */
async function supplyQuoteDetail(
  env: Env,
  user: CurrentUser,
  quoteId: number,
): Promise<Row> {
  const tenant = tenantOf();
  const condParams: unknown[] = [tenant, quoteId];
  const cond = "tenant_id = $1 AND id = $2" + quoteScopeCond(user, condParams);
  return withDb(env, async (sql: Db) => {
    const rows = (await sql.unsafe(
      quoteOrdersDetailSql(cond), condParams as never[])) as unknown as Row[];
    let items: Row[] = [];
    let tradeLocked: Row[] = [];
    let orderLocked: Row[] = [];
    if (rows.length > 0) {
      items = (await sql.unsafe(
        QUOTE_ORDERS_ITEMS_DETAIL_SQL, [tenant, quoteId] as never[])) as unknown as Row[];
      tradeLocked = (await sql.unsafe(
        TRADE_DOCS_LOCK_DETAIL_SQL, [tenant, quoteId] as never[])) as unknown as Row[];
      if (tradeLocked.length === 0) {
        orderLocked = (await sql.unsafe(
          ORDERS_LOCK_DETAIL_SQL, [tenant, quoteId] as never[])) as unknown as Row[];
      }
    }
    return {
      quote_orders: rows.map(quoteOrderDatasetRow),
      quote_order_items: items.map(quoteItemDatasetRow),
      trade_docs_locked: tradeLocked,
      orders_locked: orderLocked,
    };
  });
}

/** GET /api/v1/quotes 的「供数 + RPC」实现（开关 on 时）。 */
export async function quoteListWithKernel(
  c: Context<{ Bindings: Env }>,
  user: CurrentUser,
): Promise<Response> {
  const env = getEnv(c);
  const secret = requireSecret(env, "JWT_SECRET");
  const query: Record<string, string | null> = {
    status: c.req.query("status") ?? null,
    customer_id: c.req.query("customer_id") ?? null,
    inquiry_id: c.req.query("inquiry_id") ?? null,
    page: c.req.query("page") ?? null,
    page_size: c.req.query("page_size") ?? null,
  };
  const datasets = await supplyQuoteList(env, user, query);
  const jwt = await mintEngineJwt(engineActorOf(user), secret);
  return engineQuoteRpc(
    c,
    ENGINE_QUOTES_LIST_RPC,
    jwt,
    JSON.stringify({ request: { query }, actor: actorPayloadOf(user), datasets }),
  );
}

/** GET /api/v1/quotes/{quote_id} 的「供数 + RPC」实现（开关 on 时）。 */
export async function quoteDetailWithKernel(
  c: Context<{ Bindings: Env }>,
  user: CurrentUser,
): Promise<Response> {
  const env = getEnv(c);
  const secret = requireSecret(env, "JWT_SECRET");
  const quoteId = intOrNull(c.req.param("quote_id") ?? "");
  if (quoteId === null) {
    // 非整数 quote_id：旧路径（FastAPI path 参数）会 422 —— 交给旧路径裁决，不自拼错误体
    return forwardKernelRequest(c);
  }
  const datasets = await supplyQuoteDetail(env, user, quoteId);
  const jwt = await mintEngineJwt(engineActorOf(user), secret);
  return engineQuoteRpc(
    c,
    ENGINE_QUOTES_DETAIL_RPC,
    jwt,
    JSON.stringify({ request: { quote_id: quoteId }, actor: actorPayloadOf(user), datasets }),
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// 路由注册（由 src/index.ts 挂载；必须在 /api/v1/export-quote 透传 mount **之前**）
// ══════════════════════════════════════════════════════════════════════════════

const app = new Hono<{ Bindings: Env }>();

app.post("/api/v1/export-quote/calculate", (c) => {
  // 开关判定**先于鉴权**：off / 白名单未命中 ⇒ 直接走透传（与今天逐字一致：
  // 仍是 proxy 的「JWT 有则验、缺失交内核裁决」，**不额外查 users 表**）——
  // 这是「一键回退行为完全不变」的关键，也让本路由的旧路径与其它透传端点同一份实现。
  if (!useDirectRoute(getEnv(c), DIRECT_ROUTE_IDS.exportQuoteCalculate)) {
    return forwardKernelRequest(c);
  }
  return respond(c, async () => {
    // 新路径：先鉴权（401 不打到 DB/内核）
    const user = await requireUser(c);
    // TS 供数失败（DB 不可用）→ 503 db_unavailable（与 P0 热读同一分类，设计 §5.4）
    return directDb(c, () => calculateWithKernel(c, user));
  });
});

app.post("/api/v1/export-quote/verify", (c) => {
  if (!useDirectRoute(getEnv(c), ENGINE_ROUTE_IDS.verify)) {
    return forwardKernelRequest(c);
  }
  return respond(c, async () => {
    const user = await requireUser(c);
    return directDb(c, () => verifyWithKernel(c, user));
  });
});

app.get("/api/v1/export-quote/products/:product_key/formulas", (c) => {
  if (!useDirectRoute(getEnv(c), ENGINE_ROUTE_IDS.formulas)) {
    return forwardKernelRequest(c);
  }
  return respond(c, async () => {
    const user = await requireUser(c);
    return directDb(c, () => formulasWithKernel(c, user));
  });
});

app.get("/api/v1/export-quote/products/:product_key/spec", (c) => {
  if (!useDirectRoute(getEnv(c), ENGINE_ROUTE_IDS.spec)) {
    return forwardKernelRequest(c);
  }
  return respond(c, async () => {
    const user = await requireUser(c);
    return directDb(c, () => specWithKernel(c, user));
  });
});

app.get("/api/v1/trade-docs/:doc_id/render-data", (c) => {
  if (!useDirectRoute(getEnv(c), ENGINE_ROUTE_IDS.renderData)) {
    return forwardKernelRequest(c);
  }
  return respond(c, async () => {
    const user = await requireUser(c);
    return directDb(c, () => renderDataWithKernel(c, user));
  });
});

app.post("/api/v1/export-quote/products/:product_key/explain", (c) => {
  if (!useDirectRoute(getEnv(c), ENGINE_ROUTE_IDS.explain)) {
    return forwardKernelRequest(c);
  }
  return respond(c, async () => {
    const user = await requireUser(c);
    return directDb(c, () => explainWithKernel(c, user));
  });
});

app.get("/api/v1/quotes", (c) => {
  if (!useDirectRoute(getEnv(c), ENGINE_ROUTE_IDS.quotesList)) {
    return forwardKernelRequest(c);
  }
  return respond(c, async () => {
    const user = await requireUser(c);
    return directDb(c, () => quoteListWithKernel(c, user));
  });
});

app.get("/api/v1/quotes/:quote_id", (c) => {
  if (!useDirectRoute(getEnv(c), ENGINE_ROUTE_IDS.quotesDetail)) {
    return forwardKernelRequest(c);
  }
  return respond(c, async () => {
    const user = await requireUser(c);
    return directDb(c, () => quoteDetailWithKernel(c, user));
  });
});

export default app;
