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
 * 五条共用**同一份**供数契约与回放逻辑；差异只在「查哪些 dataset + request 段形状」。
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
import { num, pyIso, respond } from "../http";
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

app.post("/api/v1/export-quote/products/:product_key/explain", (c) => {
  if (!useDirectRoute(getEnv(c), ENGINE_ROUTE_IDS.explain)) {
    return forwardKernelRequest(c);
  }
  return respond(c, async () => {
    const user = await requireUser(c);
    return directDb(c, () => explainWithKernel(c, user));
  });
});

export default app;
