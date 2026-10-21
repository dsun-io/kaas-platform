/**
 * 路由面覆盖机检（2026-10-21 波 C 后加入）：Python 249 业务路由 vs TS 门面注册路由。
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

  it("TS 侧没有多余路由", () => {
    // 门面自有路由（Python 无对应真源）：存活探针 / OpenAPI / W5 M1 API token 管理面。
    // 管理面是 TS 域（docs/W5_MCP_REST_DESIGN_2026-10-21.md §2），不来自 routes.json。
    const allowedExtra = new Set([
      "GET /health",
      "GET /openapi.json",
      "ALL /*",
      "GET /api/v1/api-tokens",
      "POST /api/v1/api-tokens",
      "DELETE /api/v1/api-tokens/:p",
    ]);
    const pyPaths = new Set(direct.map((r) => normParam(r.path)));
    const extra = ts
      .filter((r) => !pyPaths.has(r.path))
      .filter((r) => !allowedExtra.has(r.method + " " + r.path))
      .filter((r) =>
        !PROXY_PREFIXES.some((p) => r.path.startsWith(p + "/*") || r.path === p + "/*"),
      )
      .map((r) => r.method + " " + r.path);
    expect(extra, "多余路由: " + extra.join(" | ")).toEqual([]);
  });
});
