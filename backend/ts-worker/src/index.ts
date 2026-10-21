/**
 * KaaS TS 门面（kaas-edge）——对外唯一门面（ADR-008）。
 *
 * 铁纪律：本文件及本 Worker 只做鉴权/参数校验/协议转换，
 * 业务规则只在 Python 内核一处实现；禁止写任何业务 if。
 */
import { Hono } from "hono";

import { getEnv, type Env } from "./env";

const app = new Hono<{ Bindings: Env }>();

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

// ── 存活探针（对齐 Python 版 GET /health 语义；service 名按本 worker 名标注）──
app.get("/health", (c) => {
  return c.json({ status: "ok", service: "kaas-edge" });
});

// ── OpenAPI 描述（显式服务，application/json）──
// 金标差异登记：Python 版 GET /openapi.json 被 CF SPA fallback 成 text/html
// （backend/ts-migration/golden/README.md「已知发现」）。TS 门面显式返回真 JSON。
// 目前仅覆盖 /health；全量 paths 随域迁移从 pydantic 模型生成，禁止手抄。
// TODO(TODO:TS1) openapi paths 改为从 Python pydantic 模型代码生成
const OPENAPI = {
  openapi: "3.0.3",
  info: {
    title: "KaaS Edge API",
    version: "0.1.0",
    description:
      "KaaS TS 门面（kaas-edge）。业务规则在 Python 内核实现；本描述仅覆盖门面已迁移路由。",
  },
  paths: {
    "/health": {
      get: {
        summary: "存活探针",
        responses: {
          "200": {
            description: "OK",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    status: { type: "string", example: "ok" },
                    service: { type: "string", example: "kaas-edge" },
                  },
                  required: ["status", "service"],
                },
              },
            },
          },
        },
      },
    },
  },
} as const;

app.get("/openapi.json", (c) => {
  return c.json(OPENAPI);
});

export default app;

// 供测试与非 Workers 环境直接取 env（Workers 请求期经 c.env 注入，语义对齐 Python 请求期读绑定）
export { getEnv };
