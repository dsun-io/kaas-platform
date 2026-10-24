/**
 * P2 首个端到端切片：引擎端点改「TS 供数 → Python 纯算 → 门面原样回放」。
 *
 * 设计 = docs/P2_COUPLING_ENGINE_2026-10-24.md §6（契约）/ §8（选型与验收）；
 * 灰度 = AUTH_DB_SPLIT（默认 off，见 src/boot-flag.ts）。
 *
 * 真源（SQL 谓词 / 排序 / 绑定参数**逐条直译**，禁止顺手"优化"）：
 * - backend/worker/src/quote_api.py  _effective_product_raw 的 tenant_products 查询
 * - backend/worker/src/quote_api.py  _pricing_key_items 的 customer_cost_items 查询
 * 供数契约（哪些列、什么类型、为什么 ORDER BY 有语义）见 docs §6.3。
 *
 * 边界（ADR-008 铁纪律）：
 * - 本文件只做「取数 + 协议转换 + 内部令牌」；**没有任何算价逻辑**（引擎在 Python 内核，
 *   算法零改动）；
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
import { requireUser, type CurrentUser } from "../session";

const DEFAULT_TENANT = "default";
/** 内核 RPC 路径（与 backend/worker/src/engine_api.py 的注册路径逐字一致）。 */
export const ENGINE_QUOTE_CALCULATE_RPC = "/internal/engine/quote/calculate";
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

/**
 * POST /api/v1/export-quote/calculate 的「供数 + RPC」实现（开关 on 时）。
 *
 * 不校验请求体：模型校验仍在内核同一份 pydantic（保证 422 信封逐字一致）；
 * 这里只读 product_key 以便取数，取不到就退回旧透传由内核裁决。
 */
export async function calculateWithKernel(
  c: Context<{ Bindings: Env }>,
  user: CurrentUser,
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
  const productKey = body.product_key;

  // ── 供数（唯一 DB 访问点；谓词/排序与 Python 真源逐字一致）──
  const tenant = tenantOf();
  const datasets = await withDb(env, async (sql: Db) => {
    const tenantRows = (await sql.unsafe(
      TENANT_PRODUCTS_SQL,
      [tenant, productKey] as never[],
    )) as unknown as Row[];
    const costRows = (await sql.unsafe(
      CUSTOMER_COST_ITEMS_SQL,
      [tenant, productKey + PRICING_SEPARATOR, customerOf(user)] as never[],
    )) as unknown as Row[];
    return {
      tenant_products: tenantRows.map(tenantProductRow),
      customer_cost_items: costRows.map(costItemRow),
    };
  });

  // ── 内部令牌（与 mintInternalJwt 同一口径 + 角色快照 + kaas_internal claim）──
  const jwt = await mintEngineJwt(
    {
      id: user.id,
      tenantId: tenant,
      teamId: user.team_id,
      role: user.role,
      accountType: user.account_type,
      isTenantAdmin: user.is_tenant_admin === true,
    },
    secret,
  );

  const payload = JSON.stringify({
    request: body,
    actor: {
      id: user.id,
      tenant_id: tenant,
      team_id: user.team_id,
      role: user.role,
      account_type: user.account_type,
      is_tenant_admin: user.is_tenant_admin === true,
    },
    datasets,
  });

  // ── 调用内核纯算（与透传共用 kernel.ts 的重试策略；body 是字符串 ⇒ 可重放）──
  const url = new URL(ENGINE_QUOTE_CALCULATE_RPC, KERNEL_BASE);
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
      "[engine] kernel_unavailable path=" + ENGINE_QUOTE_CALCULATE_RPC
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

  let envelope: unknown;
  try {
    envelope = await upstream.json();
  } catch {
    // 诊断增强（2026-10-24）：非 JSON 响应必须能看出「谁、什么状态码、什么内容」，
    // 否则只能猜（本次先被误判为资产层 SPA 回退）。只回传前 200 字符，且控制台留全量。
    const text = await upstream.text().catch(() => "");
    const head = text.slice(0, 200);
    console.error(
      "[engine] rpc non-JSON status=" + String(upstream.status) + " path=" + ENGINE_QUOTE_CALCULATE_RPC
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

export default app;
