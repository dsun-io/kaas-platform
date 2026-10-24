/**
 * 路由面覆盖机检（2026-10-21 波 C 后加入；2026-10-22 M1-f 重新对齐；2026-10-23 P0-A A3 加 dashboard/receivables；
 * 2026-10-23 C36 #19 加品名对照 GET/PATCH/DELETE；2026-10-23 C29 加历史订单导入 2 条；
 * 2026-10-24 R-D 加整单导入 template-info/preview 2 条透传；
 * 2026-10-24 旧单产品导入 3 条端点下线；2026-10-24 第二轮 preview-render-data +
 * 第三轮 A 客户英文名偏好 2 条透传）：Python **280** 业务路由（193 直接 + 87 透传）vs TS 门面注册路由。
 *
 * 2026-10-24 P0（AUTH_DB_SPLIT，docs/ARCH_AUTH_DB_SPLIT_2026-10-24.md §3.2）**只改实现分布，
 * 不改路由面**：products 3 条 GET + notifications/unread-count + approvals 列表共 **5 条只读
 * GET** 由「显式透传内核」改为「开关 on 时门面直连 Hyperdrive（off 仍透传）」。路径/method
 * 一个字没动 ⇒ 280 业务路由 + 4 内置 = 284 的口径不变（193 直接注册里 5 条换实现，87 前缀透传不变）。
 *
 * 规则：
 * - 引擎透传前缀（quotes/trade-docs/ai）由 proxy mount 覆盖，不逐条注册，单独计数；
 * - 其余路由必须一条不少、一条不多（method+path 全等，参数语法归一 {id} 与 :id 等价）。
 * - 内置路由（/docs 等）只要求 TS 侧不重复注册（openapi.json 由门面显式提供）。
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import app from "../src/index";

const ROUTES_JSON = path.join(__dirname, "..", "..", "ts-migration", "routes.json");
const PROXY_PREFIXES = [
  "/api/v1/quotes",
  "/api/v1/trade-docs",
  "/api/v1/ai",
  "/api/v1/clause-templates",
  "/api/v1/events",
  "/api/v1/export-quote",
  "/api/v1/external-docs",
  "/api/v1/fx-rates",
  "/api/v1/pricing-data",
  "/api/v1/product-tax-rates",
  "/api/v1/quotations",
  "/api/v1/tax-archives",
];

type PyRoute = { methods: string[]; path: string; file: string; line: number };

function normParam(p: string): string {
  // Python {id} 与 Hono :id 归一为 :p（两端口径统一）
  return p.replace(/\{[^}]+\}/g, ":p").replace(/:[A-Za-z_][A-Za-z0-9_]*/g, ":p");
}

function tsRoutes(): Array<{ method: string; path: string }> {
  return (app.routes as Array<{ method: string; path: string }>).map((r) => ({
    method: r.method.toUpperCase(),
    path: normParam(r.path),
  }));
}

describe("路由面覆盖（Python到TS门面）", () => {
  const raw = JSON.parse(fs.readFileSync(ROUTES_JSON, "utf8")) as { routes: PyRoute[] };
  const ts = tsRoutes();
  const tsSet = new Set(ts.map((r) => r.method + " " + r.path));
  const proxyCovered = raw.routes.filter((r) =>
    PROXY_PREFIXES.some((p) => r.path.startsWith(p)),
  );
  const direct = raw.routes.filter((r) =>
    !PROXY_PREFIXES.some((p) => r.path.startsWith(p)),
  );

  it("透传前缀与直接注册相加等于全量", () => {
    expect(proxyCovered.length).toBeGreaterThan(0);
    expect(direct.length + proxyCovered.length).toBe(raw.routes.length);
  });

  it("直接注册的路由一条不少", () => {
    const missing = direct
      .filter((r) =>
        !r.methods.every((m) =>
          tsSet.has(m.toUpperCase() + " " + normParam(r.path)),
        ),
      )
      .map((r) => r.methods.join("/") + " " + r.path + "  (" + r.file + ":" + r.line + ")");
    expect(missing, "缺失路由: " + missing.join(" | ")).toEqual([]);
  });

  it("P2 引擎切片逐条注册（改实现不改路由面，且必须命中 Python 真源）", () => {
    const engineRoutes = ["POST /api/v1/export-quote/calculate"];
    for (const route of engineRoutes) {
      const hits = ts.filter((r) => r.method + " " + r.path === route);
      expect(hits, "应恰好注册一次（重复注册会让 Hono 先注册者吞掉后者）: " + route).toHaveLength(1);
      const [method, p] = route.split(" ");
      const source = raw.routes.some(
        (r) => r.methods.includes(method!) && normParam(r.path) === p,
      );
      expect(source, "引擎切片必须有 Python 真源: " + route).toBe(true);
    }
  });

  it("P0 热读 5 条只读 GET 仍逐条注册（改实现不改路由面，各恰好 1 次）", () => {
    const p0Routes = [
      "GET /api/v1/products",
      "GET /api/v1/products/:p/profile",
      "GET /api/v1/products/:p/media",
      "GET /api/v1/notifications/unread-count",
      "GET /api/v1/approvals",
    ];
    for (const route of p0Routes) {
      const hits = ts.filter((r) => r.method + " " + r.path === route);
      expect(hits, "应恰好注册一次（重复注册会让 Hono 先注册者吞掉后者）: " + route).toHaveLength(1);
    }
    // 它们都不在引擎前缀透传组里：分类属于「门面注册」（P0 起其中 5 条走直连 SQL）
    for (const route of p0Routes) {
      const path = route.split(" ")[1]!;
      expect(PROXY_PREFIXES.some((p) => path.startsWith(p))).toBe(false);
    }
  });

  it("TS 侧没有多余路由", () => {
    // 门面自有路由（Python 无对应真源）：存活探针 / OpenAPI / W5 M1 API token 管理面。
    // 管理面是 TS 域（docs/W5_MCP_REST_DESIGN_2026-10-21.md §2），不来自 routes.json。
    const allowedExtra = new Set([
      "GET /health",
      "GET /openapi.json",
      // /docs 是 Swagger UI 静态页（W5 M2），不属于 Python 真源路由
      "GET /docs",
      "ALL /*",
      "GET /api/v1/api-tokens",
      "POST /api/v1/api-tokens",
      "DELETE /api/v1/api-tokens/:p",
      // W5 M3：MCP server（JSON-RPC over POST /mcp；GET 显式 405，不出现在 Python routes.json）
      "POST /mcp",
      "GET /mcp",
    ]);
    const pyPaths = new Set(direct.map((r) => normParam(r.path)));
    // P2（docs/P2_COUPLING_ENGINE_2026-10-24.md §8）：代理前缀内允许**显式注册**的引擎切片
    // —— 它的实现从「透传」改成「门面供数 → 内核纯算」，但路径/method 仍是 Python 真源。
    // 判据不是「放行任意路径」：必须在 routes.json 里能找到同 method+path 的真源。
    const pyAll = new Set(
      raw.routes.flatMap((r) => r.methods.map((m) => m.toUpperCase() + " " + normParam(r.path))),
    );
    const extra = ts
      .filter((r) => !pyPaths.has(r.path))
      .filter((r) => !pyAll.has(r.method + " " + r.path))
      .filter((r) => !allowedExtra.has(r.method + " " + r.path))
      .filter((r) =>
        !PROXY_PREFIXES.some((p) => r.path.startsWith(p + "/*") || r.path === p + "/*"),
      )
      .map((r) => r.method + " " + r.path);
    expect(extra, "多余路由: " + extra.join(" | ")).toEqual([]);
  });
});