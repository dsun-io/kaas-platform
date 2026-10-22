/**
 * KaaS TS 门面（kaas-edge）——对外唯一门面（ADR-008）。
 *
 * 铁纪律：本文件及本 Worker 只做鉴权/参数校验/协议转换，
 * 业务规则只在 Python 内核一处实现；禁止写任何业务 if。
 */
import { Hono } from "hono";

import { type AppEnv } from "./actor";
import { getEnv } from "./env";
import { createMcpApp } from "./mcp";
import { apiTokenScopeMiddleware } from "./scope-map";
import adminRoutes from "./routes/admin";
import apiTokenRoutes from "./routes/api-tokens";
import authRoutes from "./routes/auth";
import customerRoutes from "./routes/customers";
import fileRoutes from "./routes/files";
import orderRoutes from "./routes/orders";
import outreachRoutes from "./routes/outreach";
import teamRoutes from "./routes/teams";
import intelRoutes from "./routes/intel";
import workstationsRoutes from "./routes/workstations";
import dashboardRoutes from "./routes/dashboard";
import { buildOpenApiDocument } from "./openapi";
import { createProxyApp } from "./proxy";
import { callKernel } from "./kernel";

const app = new Hono<AppEnv>();

// ── CORS 中间件（语义逐条对齐 backend/worker/src/main.py cors_middleware）──
// 白名单、回退来源、OPTIONS 204、Max-Age、Vary 头均与 Python 版一致。
const ALLOWED_ORIGINS = new Set([
  "https://kaas.powervoy.com",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
]);
const DEFAULT_ORIGIN = "https://kaas.powervoy.com";
const CORS_METHODS = "GET, POST, PUT, PATCH, DELETE, OPTIONS";
const CORS_HEADERS = "Authorization, Content-Type, X-Tenant-Id, X-Use-V2";
const CORS_MAX_AGE = "86400";

app.use("*", async (c, next) => {
  const origin = c.req.header("Origin") ?? "";
  const allowed = ALLOWED_ORIGINS.has(origin) ? origin : DEFAULT_ORIGIN;
  if (c.req.method === "OPTIONS") {
    // Python 版：OPTIONS 直接 204，不带 body
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": allowed,
        "Access-Control-Allow-Methods": CORS_METHODS,
        "Access-Control-Allow-Headers": CORS_HEADERS,
        "Access-Control-Max-Age": CORS_MAX_AGE,
      },
    });
  }
  try {
    await next();
  } catch (err) {
    // Python 版：未捕获异常也带 CORS 头返回 500（2026-10-19 生产实证：
    // 无 CORS 头会把真实 500 伪装成跨域问题）
    console.error(err);
    return c.json({ detail: "internal_error: unexpected server error" }, 500, corsHeaders(allowed));
  }
  // 正常响应：补 CORS 头 + Vary（Python 版对 response.headers 的处理）
  c.res.headers.set("Access-Control-Allow-Origin", allowed);
  c.res.headers.set("Vary", "Origin");
  return c.res;
});

function corsHeaders(allowed: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": allowed,
    "Vary": "Origin",
  };
}

// ── W5 M3：API token scope 闸门（只拦 Bearer kaas_oat_...；JWT/缺失原样透传）──
// 设计 = docs/W5_MCP_REST_DESIGN_2026-10-21.md §2；规则表在 src/scope-map.ts。
// 必须在业务路由之前注册：通过后把 actor 写入 c.set("apiTokenActor")，代理/路由复用同一身份。
// 用全局 * 注册（中间件内部只处理 /api/*）：若注册成 /api/*，OpenAPI 生成器会把它当成透传 mount。
app.use("*", apiTokenScopeMiddleware);

// ── 业务域挂载（Phase 2；语义真源 = backend/worker/src/main.py + ws_*.py）──
// auth 的 9 条路由用域内相对路径（/login、/me…），挂到 /api/v1/auth；
// customers/teams 沿用 Python 侧的完整 /api/v1 前缀（与真源逐字对照方便），挂到根。
app.route("/api/v1/auth", authRoutes);
app.route("/", customerRoutes);
app.route("/", teamRoutes);
// 波 C：intel（leadgen/leads/research/shipments/market）+ workstations（enums/spec/products/tenant/subscriptions）+ dashboard
// 注意：Hono 先注册先命中；workstations.ts 含 /api/v1/products* 5 条透传，后续 files 域若注册同路径需调整顺序。
app.route("/", intelRoutes);
app.route("/", workstationsRoutes);
app.route("/", dashboardRoutes);
app.route("/", orderRoutes);
app.route("/", fileRoutes);
app.route("/", outreachRoutes);
app.route("/", adminRoutes);
app.route("/", apiTokenRoutes);

// ── 引擎域透传（quotes / trade-docs / ai）：门面只鉴权+协议转换，不重写业务（ADR-008）──
// 详见 backend/ts-migration/route-classification.md 与 AGENTS.md 铁纪律。
app.route("/api/v1/quotes", createProxyApp("/api/v1/quotes"));
app.route("/api/v1/trade-docs", createProxyApp("/api/v1/trade-docs"));
app.route("/api/v1/ai", createProxyApp("/api/v1/ai"));
// 引擎/辅助域透传（未迁门面的 41 条）：clause-templates / events / export-quote / external-docs /
// fx-rates / pricing-data / product-tax-rates / quotations / tax-archives —— 一律门面鉴权后原样转发 KERNEL，
// 禁止在门面重写这些业务（如将来要迁，先在内核暴露 /internal/* 或补 rules 镜像，再逐条移植）。
app.route("/api/v1/clause-templates", createProxyApp("/api/v1/clause-templates"));
app.route("/api/v1/events", createProxyApp("/api/v1/events"));
app.route("/api/v1/export-quote", createProxyApp("/api/v1/export-quote"));
app.route("/api/v1/external-docs", createProxyApp("/api/v1/external-docs"));
app.route("/api/v1/fx-rates", createProxyApp("/api/v1/fx-rates"));
app.route("/api/v1/pricing-data", createProxyApp("/api/v1/pricing-data"));
app.route("/api/v1/product-tax-rates", createProxyApp("/api/v1/product-tax-rates"));
app.route("/api/v1/quotations", createProxyApp("/api/v1/quotations"));
app.route("/api/v1/tax-archives", createProxyApp("/api/v1/tax-archives"));

// ── W5 M3：MCP server（POST /mcp，JSON-RPC 2.0 / Streamable HTTP 最小实现）──
// 传入同一个 app 供 tools 内部复用 REST 路由（scope/数据一条链路）；MCP 不在 /api/* 下，
// 因此不经过上面的 REST scope 闸门，而是在 handler 内按 tool 的 scope 校验/裁剪。
app.route("/", createMcpApp(app));

// ── 存活探针（对齐 Python 版 GET /health 语义；service 名按本 worker 名标注）──
// ?deep=1：额外经 KERNEL Service Binding 探内核（部署流水线的内核探活用）。
// 默认（不带参数）不触发内核，避免监控高频探针放大 Python 冷启动。
app.get("/health", async (c) => {
  const base = { status: "ok", service: "kaas-edge" };
  if (c.req.query("deep") !== "1") return c.json(base);

  try {
    const res = await callKernel(getEnv(c).KERNEL, "/health");
    const kernel = (await res.json()) as {
      status?: string;
      service?: string;
      shared?: { loaded?: boolean };
    };
    return c.json({
      ...base,
      kernel: {
        status: kernel.status ?? "unknown",
        service: kernel.service ?? null,
        shared_loaded: kernel.shared?.loaded ?? null,
        http_status: res.status,
      },
    });
  } catch (err) {
    return c.json(
      {
        ...base,
        kernel: {
          status: "unreachable",
          message: err instanceof Error ? err.message : String(err),
        },
      },
      503,
    );
  }
});

// ── API 文档：/openapi.json（OpenAPI 3.1，路径从 app.routes 自动发现）+ /docs（Swagger UI）──
// 金标差异登记：Python 版 GET /openapi.json 被 CF SPA fallback 成 text/html
// （backend/ts-migration/golden/README.md「已知发现」）。TS 门面显式返回真 JSON。
// 生成逻辑全部在 src/openapi.ts（不维护第二份路由表；业务规则仍在 Python 内核）。
let openApiDocument: ReturnType<typeof buildOpenApiDocument> | null = null;

app.get("/openapi.json", (c) => {
  // 惰性构建：确保 app.routes 已包含全部挂载（含本路由与 /docs）；每个 isolate 只建一次。
  openApiDocument ??= buildOpenApiDocument(app.routes);
  return c.json(openApiDocument);
});

// /docs：轻量静态页；swagger-ui 走 CDN，不引入构建期/运行期重依赖，也不进 Worker 包。
const DOCS_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>KaaS Edge API · OpenAPI 3.1</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css" />
<style>body{margin:0}#swagger-ui .topbar{display:none}</style>
</head>
<body>
<div id="swagger-ui"></div>
<script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js" crossorigin></script>
<script>
  window.ui = SwaggerUIBundle({
    url: "/openapi.json",
    dom_id: "#swagger-ui",
    deepLinking: true,
    persistAuthorization: true,
    tryItOutEnabled: true
  });
</script>
</body>
</html>`;

app.get("/docs", (c) => c.html(DOCS_HTML));

// 未匹配 API 路由的 404 信封对齐 Python（FastAPI 返回 {"detail":"Not Found"} JSON；
// Hono 默认是 text/plain，会让前端按 JSON 解析失败）。非 /api 路径维持纯文本 404（正常情况不会到 Hono）。
app.notFound((c) => {
  if (c.req.path.startsWith("/api/")) {
    return c.json({ detail: "Not Found" }, 404);
  }
  return c.text("404 Not Found", 404);
});

export default app;

// 供测试与非 Workers 环境直接取 env（Workers 请求期经 c.env 注入，语义对齐 Python 请求期读绑定）
export { getEnv };
