/**
 * P0 灰度开关：控制台热读端点「门面直连 Hyperdrive（TS-DB）」vs「原样透传 Python 内核」。
 *
 * 设计 = docs/ARCH_AUTH_DB_SPLIT_2026-10-24.md §8「灰度与回退」：
 * - `AUTH_DB_SPLIT`：`off|on`（Worker var，可即时改），**默认 off**；
 *   缺省/非法值一律按 off 处理 —— 变量没配上时行为与事故前的「全透传」逐字一致，
 *   这就是一键回退路径（门面回滚只需把该 var 改回 off，无需发版）。
 * - `AUTH_DB_SPLIT_ROUTES`：逗号白名单（如 `products,notifications`），空 = 全部受开关控制。
 *   条目按 **路由 id 前缀**匹配：写 `products` 覆盖 `products.list` / `products.profile`
 *   / `products.media`；写 `products.list` 只覆盖那一条（便于按端点逐个放量）。
 *
 * ⚠️ 本模块**只做开关判定**（协议层），不含任何业务规则（ADR-008）。
 * 开关必须**每请求求值**（Workers 的 env 是请求期注入，且改 var 要能即时生效），
 * 所以路由注册保持静态、由 handler 分支，不做「按开关条件注册」。
 */
import type { Env } from "./env";

/** 开关变量名（wrangler.jsonc vars / 控制台 Secrets 同名）。 */
export const AUTH_DB_SPLIT_VAR = "AUTH_DB_SPLIT";
/** 白名单变量名。 */
export const AUTH_DB_SPLIT_ROUTES_VAR = "AUTH_DB_SPLIT_ROUTES";

/** 开关取值（只有 `on` 才走直连；其余一切值 = off）。 */
export const AUTH_DB_SPLIT_ON = "on";
export const AUTH_DB_SPLIT_OFF = "off";

/**
 * P0 直连路由 id（与 `AUTH_DB_SPLIT_ROUTES` 的条目同一命名空间）。
 * 命名口径：`<域>.<端点>`；白名单条目可以只写域（前缀匹配）。
 */
export const DIRECT_ROUTE_IDS = {
  /** GET /api/v1/products —— 产品清单（ws_files.py:385） */
  productsList: "products.list",
  /** GET /api/v1/products/{product_key}/profile —— 产品基础信息（ws_files.py:438） */
  productsProfile: "products.profile",
  /** GET /api/v1/products/{product_key}/media —— 产品图（ws_files.py:503） */
  productsMedia: "products.media",
  /** GET /api/v1/notifications/unread-count —— 铃铛角标（ws_approvals.py:618） */
  notificationsUnreadCount: "notifications.unread-count",
  /** GET /api/v1/approvals —— 审批中心列表（ws_approvals.py:478） */
  approvalsList: "approvals.list",
  /**
   * POST /api/v1/export-quote/calculate —— 报价计算（quote_api.py:953）。
   * P2：不是「门面直连返回」，而是「门面供数 → 内核 /internal/engine/* 纯算 → 原样回放」，
   * 详见 docs/P2_COUPLING_ENGINE_2026-10-24.md §6/§8。
   */
  exportQuoteCalculate: "export-quote.calculate",
  // ── P3 批次A：询盘读端点（customers 域里仅剩的「仍在打内核」的只读 GET）──────────
  // 口径修正（2026-10-24 事实核对）：orders 列表/详情、customers 列表/详情、teams
  // 列表/详情**自「门面注册/移植」（route-classification 193 条）起就是直连 DB**，
  // 都不经过内核 ⇒ 不需要（也不应）挂本开关：给已直连的端点挂 off=透传会把默认行为
  // 退回依赖 Pyodide 冷启动，与本次事故的止血方向相反。询盘这三条才是这三域里
  // 真正还在 forwardAuthenticatedKernelRequest 的 GET（真源 ws_crm_ext.py:303/402/609）。
  /** GET /api/v1/inquiries —— 询盘总表（ws_crm_ext.py:303） */
  inquiriesList: "inquiries.list",
  /** GET /api/v1/inquiries/{id} —— 询盘详情（报价历史/关联订单/阶段流水，ws_crm_ext.py:402） */
  inquiriesDetail: "inquiries.detail",
  /** GET /api/v1/inquiries/{id}/stage-log —— 询盘阶段流水（ws_crm_ext.py:609） */
  inquiriesStageLog: "inquiries.stage-log",
  // ── P3 批次A（扩权）：quotes / tax 域只读端点（index.ts 里仍是 createProxyApp 透传的）──
  // 真源 = main.py:2504 / tax_archives.py:202 / tax_archives.py:372（源码核对为纯 SQL）。
  /** GET /api/v1/quotations —— 旧报价事实表台账（main.py:2504） */
  quotationsList: "quotations.list",
  /** GET /api/v1/tax-archives —— 税务档案列表（tax_archives.py:202） */
  taxArchivesList: "tax-archives.list",
  /** GET /api/v1/product-tax-rates —— 产品税率列表（tax_archives.py:372） */
  productTaxRatesList: "product-tax-rates.list",
} as const;

export type DirectRouteId = (typeof DIRECT_ROUTE_IDS)[keyof typeof DIRECT_ROUTE_IDS];

/** 读一个字符串型 var（非字符串/空白 ⇒ 空串；大小写与两侧空白不敏感）。 */
function readVar(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/** `AUTH_DB_SPLIT` 是否开启（只有 `on` 算开；缺失/off/其它值 = 关）。 */
export function authDbSplitEnabled(env: Env): boolean {
  return readVar(env[AUTH_DB_SPLIT_VAR]) === AUTH_DB_SPLIT_ON;
}

/** 白名单条目（已 trim + 小写 + 去空项；空数组 = 不设限）。 */
export function authDbSplitRoutes(env: Env): string[] {
  const raw = env[AUTH_DB_SPLIT_ROUTES_VAR];
  if (typeof raw !== "string") return [];
  return raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

/**
 * 该路由本次是否走「门面直连 DB」：
 * - 开关 off ⇒ 恒 false（走原透传，行为与今天一致）；
 * - 开关 on + 白名单为空 ⇒ 全部直连；
 * - 开关 on + 白名单非空 ⇒ 条目等于 id 或是 id 的**前缀段**才算命中
 *   （`products` 命中 `products.list`，但 `product` 不会误命中 —— 按 `.` 分段比较）。
 */
export function useDirectRoute(env: Env, routeId: string): boolean {
  if (!authDbSplitEnabled(env)) return false;
  const allowed = authDbSplitRoutes(env);
  if (allowed.length === 0) return true;
  const id = readVar(routeId);
  if (!id) return false;
  return allowed.some((entry) => id === entry || id.startsWith(entry + "."));
}
