/**
 * KaaS TS 门面 · API token 路径 → scope 映射（W5 M3）。
 *
 * 设计 = docs/W5_MCP_REST_DESIGN_2026-10-21.md §2/§4：
 * - 同一个 `Authorization: Bearer` 头：`kaas_oat_` 前缀走 API token，其余一律原样透传（JWT 零改动）；
 * - 业务路由按「method + path 前缀」声明所需 scope；**未命中任何规则 = 拒绝**（403 SCOPE_NOT_DECLARED），
 *   不做“没写规则就默认放行”——否则新增路由会静默绕过 token 授权。
 *
 * 边界（ADR-008）：
 * - 本文件只做**鉴权元数据映射**，不含业务规则；scope 白名单唯一真源仍是 tokens.ts:API_TOKEN_SCOPES。
 * - 规则是**有序**的：更具体的前缀（export-quote/calculate*、intel/shipments）必须排在泛前缀之前。
 * - 管理端点 /api/v1/api-tokens 显式跳过本中间件（保持 JWT-only，且不查 token 表，防自举提权）。
 */
import type { Context, MiddlewareHandler } from "hono";

import { resolveApiTokenActor, type ApiTokenActor, type AppEnv } from "./actor";
import { ApiError } from "./http";
import { API_TOKEN_PREFIX, API_TOKEN_SCOPES, hasScope } from "./tokens";

export type ScopeMethod = "GET" | "HEAD" | "OPTIONS" | "POST" | "PUT" | "PATCH" | "DELETE" | "*";

/** 一条有序规则：method 匹配 + path 前缀命中 → 需要 scope。 */
export interface ScopeRule {
  method: ScopeMethod;
  /**
   * 路径前缀：
   * - 普通前缀按**路径段**匹配（`/api/v1/customers` 命中 `/api/v1/customers/123`，不命中 `.../customersX`）；
   * - 以 `*` 结尾表示原始字符串前缀（`/api/v1/export-quote/calculate*` 同时命中 calculate / calculate-internal）。
   */
  prefix: string;
  scope: string;
}

export interface ScopeDecision {
  scope: string;
  rule: ScopeRule;
}

// ── 规则表（顺序即优先级）─────────────────────────────────────────────────

const rules: ScopeRule[] = [];

function rule(method: ScopeMethod, prefix: string, scope: string): void {
  rules.push({ method, prefix, scope });
}

/** 读方法 → read scope；写方法 → write scope（同一前缀成对声明）。 */
function readWrite(prefix: string, read: string, write: string): void {
  rule("GET", prefix, read);
  rule("HEAD", prefix, read);
  rule("OPTIONS", prefix, read);
  rule("POST", prefix, write);
  rule("PUT", prefix, write);
  rule("PATCH", prefix, write);
  rule("DELETE", prefix, write);
}

/** 只允许读方法（白名单没有对应 write scope 的域用它；写请求落入“未命中 = 拒绝”）。 */
function readOnly(prefix: string, read: string): void {
  rule("GET", prefix, read);
  rule("HEAD", prefix, read);
  rule("OPTIONS", prefix, read);
}

// ① 报价计算/核验：更具体的路径先于 /api/v1/export-quote 泛前缀。
//    quotes_calculate / quotes_verify 两个 MCP tool 也走这里（透传 KERNEL）。
rule("POST", "/api/v1/export-quote/calculate*", "quotes:calc");
rule("POST", "/api/v1/export-quote/verify", "quotes:calc");
rule("POST", "/api/v1/export-quote/import/calculate*", "quotes:calc");
rule("POST", "/api/v1/export-quote/import/preview", "quotes:calc");
// export-quote 其余端点：读产品/条款模板用 quotes:read；写/解释/导入用 quotes:calc。
readWrite("/api/v1/export-quote", "quotes:read", "quotes:calc");

// ② 报价单本体（/quotes 与 /quotations 是两套历史路径，同域）。
//    白名单只有 quotes:read / quotes:calc（无 quotes:write）：写操作按“算价能力”要求 quotes:calc。
readWrite("/api/v1/quotes", "quotes:read", "quotes:calc");
readWrite("/api/v1/quotations", "quotes:read", "quotes:calc");

// ③ 单证 / 文件
readWrite("/api/v1/trade-docs", "trade_docs:read", "trade_docs:write");
readWrite("/api/v1/files", "files:read", "files:write");
readWrite("/api/v1/file-objects", "files:read", "files:write");

// ④ 客户 / 询盘
readWrite("/api/v1/customers", "customers:read", "customers:write");
readWrite("/api/v1/customer", "customers:read", "customers:write");
readWrite("/api/v1/inquiries", "inquiries:read", "inquiries:write");
// capabilities 是客户域的附属资源（main.py:3080-3222）
readWrite("/api/v1/capabilities", "customers:read", "customers:write");
readWrite("/api/v1/capability-customers", "customers:read", "customers:write");

// ⑤ 订单域（订单 / 收款 / 实际成本 / 付款计划 / 订单发货）
// 任务口径：orders/shipments 同属订单域 → orders:*；
// 白名单里的 shipments:read/write 暂未映射（留给未来独立发货域，避免现在发明第二套语义）。
readWrite("/api/v1/orders", "orders:read", "orders:write");
readWrite("/api/v1/shipments", "orders:read", "orders:write");
readWrite("/api/v1/receivables", "orders:read", "orders:write");
readWrite("/api/v1/actual-costs", "orders:read", "orders:write");
readWrite("/api/v1/payment-schedules", "orders:read", "orders:write");

// ⑥ 获客 / 研究 / 情报 / 市场（market 数据归 intel 域）
readWrite("/api/v1/leadgen", "leadgen:read", "leadgen:write");
readWrite("/api/v1/leads", "leadgen:read", "leadgen:write");
readWrite("/api/v1/research", "research:read", "research:write");
// 白名单只有 intel:read（无 intel:write）：情报/市场域对 token 只读；写请求不命中规则 → 403。
readOnly("/api/v1/intel", "intel:read");
readOnly("/api/v1/market", "intel:read");

// ⑦ 外联
readWrite("/api/v1/outreach", "outreach:read", "outreach:write");

// ⑧ 审批中心 / 站内通知（M1-e，ws_approvals.py）
// 业务语义都在「已确认订单明细变更审批」链路上（模块 docstring：通知只做审批相关），
// 复用 orders:*，不发明第二套 scope（白名单唯一真源 = tokens.ts:API_TOKEN_SCOPES）。
readWrite("/api/v1/approvals", "orders:read", "orders:write");
readWrite("/api/v1/notifications", "orders:read", "orders:write");
// 指定审批人（/api/v1/team/approvers）**故意不声明**：团队管理配置只走 UI 会话（JWT），
// API token 请求按「未命中 = 拒绝」回 403 SCOPE_NOT_DECLARED —— 不拿 orders:write 越权放大。

// ⑨ dashboard（看板聚合，P0-A A3 起含 /dashboard/receivables）
// 只读域：聚合口径本身在内核（funnel/receivable_summary），没有可写端点。
// 白名单里没有 dashboard:read，且看板数据主体是订单/应收 ⇒ 复用 orders:read
// （与审批中心复用 orders:* 同一理由：不发明第二套 scope）。
// 注意：写方法不命中任何规则 ⇒ 403 SCOPE_NOT_DECLARED（readOnly 只声明读方法）。
readOnly("/api/v1/dashboard", "orders:read");

/** 有序规则表（只读导出，供文档/测试核对）。 */
export const SCOPE_RULES: readonly ScopeRule[] = rules;

const KNOWN_SCOPES: ReadonlySet<string> = new Set(API_TOKEN_SCOPES);

/** 规则里出现白名单外 scope 是编程错误（测试锁死；运行期不静默放行）。 */
export function isValidScopeRule(rule: ScopeRule): boolean {
  return KNOWN_SCOPES.has(rule.scope);
}

function pathMatches(path: string, prefix: string): boolean {
  if (prefix.endsWith("*")) {
    return path.startsWith(prefix.slice(0, -1));
  }
  return path === prefix || path.startsWith(prefix + "/");
}

/**
 * 解析某请求所需的 scope。
 * @returns 命中的第一条规则；未命中返回 null（调用方必须拒绝）。
 */
export function resolveRequiredScope(method: string, path: string): ScopeDecision | null {
  const upper = method.toUpperCase() as ScopeMethod;
  // 防御：把 query/hash 去掉（Hono c.req.path 本来就没有，但纯函数要可独立测）。
  const cleanPath = path.split(/[?#]/)[0] ?? path;
  for (const candidate of rules) {
    if (candidate.method !== "*" && candidate.method !== upper) continue;
    if (pathMatches(cleanPath, candidate.prefix)) {
      return { scope: candidate.scope, rule: candidate };
    }
  }
  return null;
}

function isTokenManagementPath(path: string): boolean {
  return path === "/api/v1/api-tokens" || path.startsWith("/api/v1/api-tokens/");
}

function forbidden(c: Context<AppEnv>, message: string): Response {
  return c.json(
    {
      detail: {
        error: "forbidden",
        code: "SCOPE_NOT_DECLARED",
        message,
      },
    },
    403,
  );
}

/**
 * 全局 API token scope 中间件（挂在 index.ts 业务路由前）。
 *
 * - 只拦截 `Bearer kaas_oat_...`；其他 Authorization（JWT/缺失）**原样 next()**；
 * - token 无效/撤销/过期 → 401（复用 resolveApiTokenActor 的现有信封）；
 * - 通过 scope 校验 → c.set("apiTokenActor", actor)，后续代理/路由复用同一身份；
 * - 管理端点 /api/v1/api-tokens 跳过（JWT-only；不查 token 表）。
 */
export const apiTokenScopeMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  // 全局注册（app.use("*")）以避开 OpenAPI/route-surface 把中间件误认成透传 mount；
  // 本闸门只处理 /api/*，/mcp、/health、/docs 等非 REST 路径原样放行。
  if (!c.req.path.startsWith("/api/")) {
    await next();
    return;
  }
  const authorization = c.req.header("Authorization") ?? "";
  if (!authorization.startsWith(`Bearer ${API_TOKEN_PREFIX}`)) {
    await next();
    return;
  }
  if (isTokenManagementPath(c.req.path)) {
    // 防自举提权：管理面只认 JWT，且不在 token 表里查这个 kaas_oat_ 凭据。
    await next();
    return;
  }

  let actor: ApiTokenActor | null;
  try {
    actor = await resolveApiTokenActor(c);
  } catch (err) {
    if (err instanceof ApiError) {
      return c.json(err.body, err.status as never);
    }
    throw err;
  }
  if (!actor) {
    // 前缀分支已由 resolveApiTokenActor 保证：理论上不可达；保守放行给后续鉴权。
    await next();
    return;
  }

  const decision = resolveRequiredScope(c.req.method, c.req.path);
  if (!decision) {
    return forbidden(c, `API token scope not declared for ${c.req.method} ${c.req.path}`);
  }
  if (!hasScope(actor, decision.scope)) {
    return forbidden(c, `API token lacks required scope: ${decision.scope}`);
  }

  c.set("apiTokenActor", actor);
  await next();
};
