/**
 * W5 M2 · OpenAPI 3.1 文档机检。
 *
 * 口径与 tests/route-surface.test.ts 一致：
 * - 直接注册的 187 条业务路由必须逐条出现在 paths（method + path 精确匹配）；
 * - 86 条透传路由由 12 个前缀 mount 覆盖（mount 记录存在 + 每条路由的 method 都有占位操作）；
 * - 187 + 86 = 273（backend/ts-migration/routes.json 真源；2026-10-22 设计 §13.3 新增
 *   实收登记/订单附件 5 条；M1-f 补齐 M1-e 审批/通知/指定审批人 + 询盘详情 12 条显式路由）。
 *
 * 另检：/openapi.json 响应头、security 声明、请求模型关联、operationId 唯一、/docs 静态页。
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import app from "../src/index";
import {
  buildOpenApiDocument,
  OPENAPI_VERSION,
  type OpenApiDocument,
} from "../src/openapi";

const ROUTES_JSON = path.join(__dirname, "..", "..", "ts-migration", "routes.json");

/** 与 route-surface.test.ts 同口径：透传挂载前缀（Python 内核路由，门面不逐条注册）。 */
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

type PyRoute = { methods: string[]; path: string; domain: string };

type OpenApiOperation = Record<string, unknown> & {
  tags?: unknown;
  summary?: unknown;
  operationId?: unknown;
  parameters?: unknown;
  security?: unknown;
  requestBody?: unknown;
};

const HTTP_VERBS = ["get", "post", "put", "patch", "delete", "head", "options"];

interface OperationEntry {
  path: string;
  method: string;
  op: OpenApiOperation;
}

function loadPythonRoutes(): PyRoute[] {
  const raw = JSON.parse(fs.readFileSync(ROUTES_JSON, "utf8")) as { routes: PyRoute[] };
  return raw.routes;
}

async function fetchDocument(): Promise<OpenApiDocument> {
  const res = await app.request("http://localhost/openapi.json");
  return (await res.json()) as OpenApiDocument;
}

function allOperations(doc: OpenApiDocument): OperationEntry[] {
  const out: OperationEntry[] = [];
  for (const [routePath, item] of Object.entries(doc.paths)) {
    for (const [key, value] of Object.entries(item)) {
      if (HTTP_VERBS.includes(key)) {
        out.push({ path: routePath, method: key.toUpperCase(), op: value as OpenApiOperation });
      }
    }
  }
  return out;
}

function opAt(doc: OpenApiDocument, routePath: string, method: string): OpenApiOperation {
  const item = doc.paths[routePath];
  const op = item?.[method.toLowerCase()];
  if (!op) throw new Error("operation not found: " + method + " " + routePath);
  return op as OpenApiOperation;
}

function requestRef(op: OpenApiOperation): string | null {
  const body = op.requestBody as
    | { content?: Record<string, { schema?: Record<string, unknown> }> }
    | undefined;
  const ref = body?.content?.["application/json"]?.schema?.["$ref"];
  return typeof ref === "string" ? ref : null;
}

function securityOf(op: OpenApiOperation): unknown[] | null {
  return Array.isArray(op.security) ? (op.security as unknown[]) : null;
}

describe("OpenAPI 3.1（W5 M2）", () => {
  it("GET /openapi.json：200 + application/json + info/servers/version", async () => {
    const res = await app.request("http://localhost/openapi.json");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");

    const doc = (await res.json()) as OpenApiDocument;
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info.title).toBe("KaaS Edge API");
    expect(doc.info.version).toBe(OPENAPI_VERSION);

    const pkg = JSON.parse(
      fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"),
    ) as { version: string };
    expect(doc.info.version).toBe(pkg.version);

    expect(doc.servers.map((s) => s.url)).toEqual([
      "https://kaas.powervoy.com",
      "https://api.kaas.powervoy.com",
    ]);
  });

  it("273 条业务路由全覆盖：187 直接 + 86 透传", async () => {
    const routes = loadPythonRoutes();
    const proxyCovered = routes.filter((r) =>
      PROXY_PREFIXES.some((p) => r.path.startsWith(p)),
    );
    const direct = routes.filter((r) => !PROXY_PREFIXES.some((p) => r.path.startsWith(p)));

    expect(direct.length).toBe(187);
    expect(proxyCovered.length).toBe(86);
    expect(direct.length + proxyCovered.length).toBe(273);

    const doc = await fetchDocument();

    // ① 直接注册：method + path 逐条必须存在（routes.json 已是 {id} 语法）
    const missing: string[] = [];
    for (const route of direct) {
      const item = doc.paths[route.path];
      for (const method of route.methods) {
        if (!item || !(method.toLowerCase() in item)) {
          missing.push(method + " " + route.path);
        }
      }
    }
    expect(missing, "缺失直接路由: " + missing.join(" | ")).toEqual([]);

    // ② 透传组：12 个 mount 记录 + 每条透传路由的 method 都有占位操作
    const mounts = doc["x-kaas-proxy-mounts"];
    expect(mounts.length).toBe(PROXY_PREFIXES.length);
    for (const prefix of PROXY_PREFIXES) {
      expect(mounts.some((m) => m.prefix === prefix), "缺少 mount: " + prefix).toBe(true);
      expect(doc.paths[prefix + "/{proxyPath}"], "缺少 mount path: " + prefix).toBeTruthy();
    }

    const uncovered: string[] = [];
    for (const route of proxyCovered) {
      const prefix = PROXY_PREFIXES.find((p) => route.path.startsWith(p)) ?? "";
      const item = doc.paths[prefix + "/{proxyPath}"];
      for (const method of route.methods) {
        if (!item || !(method.toLowerCase() in item)) {
          uncovered.push(method + " " + route.path);
        }
      }
    }
    expect(uncovered, "透传未覆盖: " + uncovered.join(" | ")).toEqual([]);

    for (const mount of mounts) {
      expect(mount.upstream).toBe("python-kernel");
      const item = doc.paths[mount.prefix + "/{proxyPath}"];
      expect(item?.["x-kaas-proxy-mount"]).toMatchObject({ upstream: "python-kernel" });
    }

    const surface = doc["x-kaas-route-surface"];
    expect(surface.source).toBe("hono app.routes");
    expect(surface.proxyMounts).toBe(12);
  });

  it("安全声明：两个 bearer scheme + 全局 security；/health、/openapi.json 除外", async () => {
    const doc = await fetchDocument();
    const schemes = doc.components.securitySchemes;

    expect(schemes.bearerAuth).toMatchObject({
      type: "http",
      scheme: "bearer",
      bearerFormat: "JWT",
    });
    expect(schemes.apiToken).toMatchObject({
      type: "http",
      scheme: "bearer",
      bearerFormat: "kaas_oat_*",
    });
    expect(String(schemes.apiToken?.description)).toContain("kaas_oat_");
    expect(doc.security).toEqual([{ bearerAuth: [] }, { apiToken: [] }]);

    expect(securityOf(opAt(doc, "/health", "GET"))).toEqual([]);
    expect(securityOf(opAt(doc, "/openapi.json", "GET"))).toEqual([]);

    // 其余端点：操作级 security 或文档级全局 security 至少有一个生效
    const unprotected = allOperations(doc)
      .filter(({ path: p }) => p !== "/health" && p !== "/openapi.json")
      .filter(({ op }) => {
        const local = securityOf(op);
        return local ? local.length === 0 : doc.security.length === 0;
      })
      .map(({ method, path: p }) => method + " " + p);
    expect(unprotected, "缺安全声明: " + unprotected.join(" | ")).toEqual([]);
  });

  it("operation 结构：summary / tags / operationId 唯一 / path 参数", async () => {
    const doc = await fetchDocument();
    const ops = allOperations(doc);
    expect(ops.length).toBeGreaterThan(200);

    const declaredTags = new Set(doc.tags.map((t) => t.name));
    const seenIds = new Set<string>();
    const problems: string[] = [];

    for (const { path: routePath, method, op } of ops) {
      const tags = op.tags;
      if (!Array.isArray(tags) || tags.length !== 1 || typeof tags[0] !== "string") {
        problems.push(method + " " + routePath + " tags");
      } else if (!declaredTags.has(tags[0])) {
        problems.push(method + " " + routePath + " undeclared tag " + tags[0]);
      }

      if (typeof op.summary !== "string" || !op.summary.endsWith(method + " " + routePath)) {
        problems.push(method + " " + routePath + " summary=" + String(op.summary));
      }

      if (typeof op.operationId !== "string" || op.operationId.length === 0) {
        problems.push(method + " " + routePath + " operationId");
      } else if (seenIds.has(op.operationId)) {
        problems.push("duplicate operationId " + op.operationId);
      } else {
        seenIds.add(op.operationId);
      }

      // 路径模板参数必须在 parameters 里声明为 path/required
      const params = (op.parameters ?? []) as Array<Record<string, unknown>>;
      for (const match of routePath.matchAll(/\{([^}]+)\}/g)) {
        const name = match[1];
        const param = params.find((p) => p.name === name);
        if (!param || param.in !== "path" || param.required !== true) {
          problems.push(method + " " + routePath + " param " + String(name));
        }
      }
    }

    expect(problems, problems.join(" | ")).toEqual([]);
  });

  it("请求模型：已关联端点引用 generated 生成模型，未关联退化为通用 object", async () => {
    const doc = await fetchDocument();

    expect(requestRef(opAt(doc, "/api/v1/outreach/mailboxes", "POST"))).toBe(
      "#/components/schemas/chain_MailboxCreate",
    );
    expect(requestRef(opAt(doc, "/api/v1/file-objects/presign", "POST"))).toBe(
      "#/components/schemas/ws_files_PresignIn",
    );

    const mailbox = doc.components.schemas.chain_MailboxCreate as Record<string, unknown>;
    expect(mailbox.type).toBe("object");
    expect(mailbox.required).toEqual(["email"]);
    const mailboxProps = mailbox.properties as Record<string, Record<string, unknown>>;
    expect(mailboxProps.email).toEqual({ type: "string" });
    expect(mailboxProps.name).toMatchObject({
      anyOf: [{ type: "string" }, { type: "null" }],
      default: null,
    });
    expect(mailboxProps.is_default).toMatchObject({ type: "boolean", default: false });

    const campaignSend = doc.components.schemas.chain_CampaignSend as Record<string, unknown>;
    const leadIds = (campaignSend.properties as Record<string, Record<string, unknown>>).lead_ids;
    expect(leadIds).toMatchObject({ type: "array", items: { type: "integer" } });

    // 至少把 20 个已迁移 z 校验的写端点关联上
    const refs = allOperations(doc)
      .map(({ op }) => requestRef(op))
      .filter((ref): ref is string => ref !== null && ref.startsWith("#/components/schemas/"));
    expect(new Set(refs).size).toBeGreaterThanOrEqual(20);

    // 未关联的端点：通用 object，而不是空 schema / $ref
    const generic = opAt(doc, "/api/v1/customers", "POST").requestBody as {
      content: Record<string, { schema: Record<string, unknown> }>;
    };
    expect(generic.content["application/json"]?.schema).toMatchObject({
      type: "object",
      additionalProperties: true,
    });
  });

  it("GET /docs：静态 Swagger UI 页面（CDN，指向 /openapi.json）", async () => {
    const res = await app.request("http://localhost/docs");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("swagger-ui");
    expect(html).toContain("/openapi.json");
  });

  it("生成器可独立用于路由子集（不依赖全局 app）", () => {
    const doc = buildOpenApiDocument([
      { method: "GET", path: "/api/v1/customers/:id" },
      { method: "ALL", path: "/api/v1/quotes/*" },
      { method: "GET", path: "/api/v1/customers/:id" }, // 重复注册应去重
      { method: "ALL", path: "/*" }, // CORS catch-all 应忽略
    ]);
    expect(Object.keys(doc.paths)).toEqual([
      "/api/v1/customers/{id}",
      "/api/v1/quotes/{proxyPath}",
    ]);
    expect(doc["x-kaas-route-surface"].directOperations).toBe(1);
    expect(doc["x-kaas-proxy-mounts"]).toHaveLength(1);
    expect(doc.paths["/docs"]).toBeUndefined();
  });
});
