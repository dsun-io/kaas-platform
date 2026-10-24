/**
 * 门面·工位订阅闸门（2026-10-24，P3 放量前置）。
 *
 * 为什么门面也要有这一层
 * ----------------------------------------------------------------
 * 工位闸门原先只存在于**内核**（backend/worker/src/ws_workstations.py 的全局中间件）。
 * 但 P0/P3 把若干端点改成**门面直连 Hyperdrive** —— 这些请求根本不进内核 ⇒ 内核闸门覆盖不到，
 * 一旦放量就等于**绕过商业限制**（2026-10-24 P2 灰度实测踩到过，见 docs/P2_COUPLING_ENGINE_2026-10-24.md §8.5.2 / §8.7）。
 *
 * 单一真源（铁律）
 * ----------------------------------------------------------------
 * 路径映射与放行白名单必须与 backend/kaas_common/workstation/subscriptions.py 的
 * WORKSTATION_PATHS / ALWAYS_ALLOWED_PREFIXES **逐条一致**，由 scripts/check-workstation-map.py
 * 在机器上比对（漂移即红）。改任何一侧都必须同时改另一侧。
 *
 * 语义对齐（与内核逐条相同）
 * ----------------------------------------------------------------
 * · 只管 /api/*；不属于任何收费工位的路径 / 放行白名单 ⇒ 不拦；
 * · **没有 Authorization 就放行**（认证是路由自身职责，闸门不越权）；
 * · 未开通 ⇒ 404 {error, code=WORKSTATION_NOT_SUBSCRIBED, workstation, detail}，
 *   键序与文案与内核 JSONResponse 逐字一致；
 * · **任何异常（token 解不开 / DB 不通）一律放行**并 console.error：
 *   订阅校验出问题不该让整个服务不可用（与内核 _workstation_gate 的兜底口径一致）。
 *
 * 性能取舍：本层不做缓存（每次命中收费工位多 1–2 条极小查询，Hyperdrive 侧亚毫秒级）。
 * 内核用的是进程内缓存 + 写时失效；门面是多 isolate，做缓存就要处理失效广播，先不做（TODO(TS3) 再评估）。
 */
import type { MiddlewareHandler } from "hono";

import { withDb } from "./db";
import { getEnv, type Env } from "./env";
import { extractBearer, verifyToken } from "./auth";
import { authDbSplitEnabled } from "./boot-flag";
import { codesForUser, hasWorkstation } from "./routes/workstations";

/** subscriptions.py:WORKSTATION_PATHS —— 工位 key → 该工位覆盖的 API 路径前缀。 */
export const WORKSTATION_PATHS: Record<string, readonly string[]> = {
  customers: ["/api/v1/customers", "/api/v1/inquiries"],
  quotes: [
    "/api/v1/quotes", "/api/v1/quotations", "/api/v1/export-quote",
    "/api/v1/quote-profiles", "/api/v1/pricing-data", "/api/v1/spec",
    "/api/v1/internal/engine/quote",
  ],
  orders: ["/api/v1/orders", "/api/v1/payment-schedules", "/api/v1/receivables"],
  "trade-docs": [
    "/api/v1/trade-docs", "/api/v1/tenant/company-profile",
    "/api/v1/tenant/company-seals", "/api/v1/external-docs",
    "/api/v1/fx-rates", "/api/v1/actual-costs",
    // 内核内部 RPC 前缀（P2 引擎切片）—— **必须与订阅真源同步登记**，
    // 否则直连路径绕过工位闸门（P2 §8.5.2 踩过）。前缀覆盖同族全部 action。
    "/api/v1/internal/engine/trade-docs",
  ],
  shipments: ["/api/v1/shipments"],
  leadgen: ["/api/v1/leadgen", "/api/v1/leads"],
  outreach: ["/api/v1/outreach"],
  intel: ["/api/v1/intel"],
  research: ["/api/v1/research", "/api/v1/market"],
};

/** subscriptions.py:ALWAYS_ALLOWED_PREFIXES —— 永不锁死（否则用户没法去开通工位，死锁）。 */
export const ALWAYS_ALLOWED_PREFIXES: readonly string[] = [
  "/api/v1/auth",
  "/api/v1/teams",
  "/api/v1/me",
  "/api/v1/admin",
  "/api/v1/dashboard",
  "/api/v1/events",
  "/api/v1/capabilities",
  "/api/v1/enums",
  "/api/v1/tenant-products",
  "/api/v1/products",
  "/api/v1/file-objects",
  "/health",
];

const NOT_SUBSCRIBED_DETAIL = "该工位未开通，请在“工位开通”里启用";

/** subscriptions.py:_match_prefix —— 前缀 + 边界（/api/v1/order 不应匹配 /api/v1/orders）。 */
export function matchPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(prefix + "/");
}

/** subscriptions.py:is_always_allowed。 */
export function isAlwaysAllowedPath(path: string): boolean {
  return ALWAYS_ALLOWED_PREFIXES.some((p) => matchPrefix(path, p));
}

/** subscriptions.py:workstation_of —— 不属于任何收费工位返回 null（= 不拦）。 */
export function workstationOfPath(path: string): string | null {
  for (const [key, prefixes] of Object.entries(WORKSTATION_PATHS)) {
    if (prefixes.some((p) => matchPrefix(path, p))) return key;
  }
  return null;
}

/** 工位闸门中间件：挂 app.use("/api/*", workstationGate())（必须在路由注册之前）。 */
export function workstationGate(): MiddlewareHandler {
  return async (c, next) => {
    // 开关关闭 ⇒ 全站透传内核，闸门由内核中间件负责（不要重复判、也不要多一次 DB 查询）。
    // 只有 AUTH_DB_SPLIT=on（存在门面直连路由）时，门面才必须自己判 —— 直连请求根本不进内核。
    // 防御：极少数调用（如单测里没注入第三参 env、或非 Worker 环境的 /health）拿不到 env ⇒ 放行。
    const env = getEnv(c) as Env | undefined;
    if (!env || !authDbSplitEnabled(env)) return next();
    const path = new URL(c.req.url).pathname;
    if (!path.startsWith("/api/") || isAlwaysAllowedPath(path)) return next();
    const workstation = workstationOfPath(path);
    if (workstation === null) return next();

    const token = extractBearer(c.req.header("Authorization") ?? null);
    // 身份解析（两种认证都要判，否则 API token 会成为绕过口）：
    // · JWT：claims 里带 sub/role/team_id（会话身份）；
    // · API token（kaas_oat_）：门面 scope 中间件已认证并写入 apiTokenActor，但**它不是 JWT** ——
    //   旧实现会 verifyToken 失败 → catch → 放行 ⇒ **API token 直接绕过商业闸门**。
    //   这里改为用「token 创建人」的身份（与内核 proxy.mintInternalJwt 的 sub=created_by 同口径），
    //   并从 users 表取角色/团队（管理员仍放行）。
    const apiTokenActor = c.get("apiTokenActor") as
      | { createdBy?: number; teamId?: number | null }
      | undefined;
    if (apiTokenActor === undefined && !token) return next(); // 未认证：认证交给路由自身

    try {
      let user: { id: number; role: string | null; team_id: number | null } | null = null;
      if (apiTokenActor) {
        const createdBy = Number(apiTokenActor.createdBy);
        if (!Number.isFinite(createdBy)) return next();
        const rows = await withDb(env, (sql) =>
          sql.unsafe("SELECT id, role, team_id FROM users WHERE id=$1", [createdBy]));
        const row = (rows as Array<Record<string, unknown>>)[0];
        if (!row) return next();
        user = {
          id: Number(row.id),
          role: (row.role as string | null | undefined) ?? null,
          team_id: row.team_id === null || row.team_id === undefined ? null : Number(row.team_id),
        };
      } else {
        const secret = env.JWT_SECRET;
        if (!secret) return next();
        const payload = (await verifyToken(token as string, secret)) as Record<string, unknown>;
        const userId = Number(payload.sub);
        if (!Number.isFinite(userId)) return next();
        user = {
          id: userId,
          role: (payload.role as string | null | undefined) ?? null,
          team_id: payload.team_id === undefined || payload.team_id === null ? null : Number(payload.team_id),
        };
      }
      if (user === null) return next();
      const codes = await withDb(env, (sql) => codesForUser(sql, user as never, "gate"));
      if (!hasWorkstation(codes, workstation)) {
        return c.json(
          {
            error: "not_found",
            code: "WORKSTATION_NOT_SUBSCRIBED",
            workstation,
            detail: NOT_SUBSCRIBED_DETAIL,
          },
          404,
        );
      }
    } catch (err) {
      // 有意兜底：工位门控尽力而为，放行后由下游鉴权兜底（内核同一口径）。
      console.error("[workstation-gate] error; falling through to downstream auth", err);
    }
    return next();
  };
}

/** 供测试/契约脚本使用的映射快照（键序稳定，便于与 Python 侧逐条比对）。 */
export function workstationMapSnapshot(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const key of Object.keys(WORKSTATION_PATHS).sort()) {
    out[key] = [...(WORKSTATION_PATHS[key] ?? [])];
  }
  return out;
}
