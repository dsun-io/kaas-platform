/**
 * KaaS TS 门面 · MCP server（W5 M3；设计 = docs/W5_MCP_REST_DESIGN_2026-10-21.md §4）。
 *
 * 传输：Streamable HTTP 最小实现 —— `POST /mcp` 收 JSON-RPC 2.0；暂无 SSE/GET 流（GET 返回 405）。
 * 鉴权：与 REST 同一 `Authorization: Bearer kaas_oat_...`；MCP 只接受 API token（JWT 不映射 scope）。
 * 工具：首期 8 个，**全部通过内部 app.request 复用现有 REST 路由**（禁止在 MCP 里重写业务逻辑）：
 *   customers_list / customers_search / inquiries_list / orders_list / trade_docs_list /
 *   quotes_calculate / quotes_verify / intel_shipments_list。
 *   内部请求继续带原 Bearer：全局 API token 中间件会再校验一次 scope，业务路由/透传层照常执行——
 *   scope 与数据只有一条链路（REST），MCP 只是协议转换。
 * Resources：kaas://workstations（静态工位清单）、kaas://openapi（/openapi.json 摘要）。
 *
 * 错误口径：
 * - HTTP 鉴权/授权失败 → 现有 `{detail:{error,message}}` 信封（scope 用 code=SCOPE_NOT_DECLARED）；
 * - JSON-RPC 协议错误 → HTTP 200 + `{jsonrpc,id,error:{code,message}}`（-32700/-32600/-32601/-32602）；
 * - 工具内部 REST 非 2xx → MCP result `{isError:true, content:[...]}`（不把 REST 错误改写成协议错误）。
 */
import { Hono, type Context } from "hono";
import { z } from "zod";

import { resolveActor, type ApiTokenActor, type AppEnv } from "./actor";
import { quote_api__CalculateIn } from "./generated/schemas";
import { ApiError } from "./http";
import { buildOpenApiDocument, zodToJsonSchema } from "./openapi";
import { allWorkstations, FULL_CHAIN } from "./rules";
import { hasScope } from "./tokens";

export const MCP_PROTOCOL_VERSION = "2025-06-18";
export const MCP_SERVER_NAME = "kaas-edge-mcp";
export const MCP_SERVER_VERSION = "0.1.0";

type JsonObject = Record<string, unknown>;

interface ToolCallContext {
  app: Hono<AppEnv>;
  env: AppEnv["Bindings"];
  bearer: string;
}

interface ToolDefinition {
  name: string;
  description: string;
  /** 调用该工具所需 scope（与 scope-map.ts 的 REST 映射同一套白名单）。 */
  scope: string;
  inputSchema: JsonObject;
  call: (args: JsonObject, ctx: ToolCallContext) => Promise<unknown>;
}

class RestError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown) {
    super(`REST call failed: ${status}`);
    this.name = "RestError";
    this.status = status;
    this.body = body;
  }
}

class RpcError extends Error {
  readonly code: number;
  readonly data?: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.data = data;
  }
}

class ScopeDenied extends Error {
  readonly toolName: string;
  readonly requiredScope: string;
  constructor(toolName: string, requiredScope: string) {
    super(`tool ${toolName} requires scope ${requiredScope}`);
    this.name = "ScopeDenied";
    this.toolName = toolName;
    this.requiredScope = requiredScope;
  }
}

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function schemaOf(schema: z.ZodTypeAny): JsonObject {
  // 复用 openapi.ts 的 zod → JSON Schema 转换器（M2 已有，不引第三方依赖、不手写第二份）。
  return zodToJsonSchema(schema);
}

async function callRest(
  ctx: ToolCallContext,
  path: string,
  init: { method: string; body?: unknown },
): Promise<unknown> {
  const headers: Record<string, string> = { Authorization: `Bearer ${ctx.bearer}` };
  let body: string | undefined;
  if (init.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.body);
  }
  const res = await ctx.app.request(path, { method: init.method, headers, body }, ctx.env);
  const text = await res.text();
  let parsed: unknown = text;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      // 非 JSON 响应（正常 REST 不应出现）原样交给工具结果，便于排查。
    }
  }
  if (!res.ok) throw new RestError(res.status, parsed);
  return parsed;
}

function withQuery(path: string, args: JsonObject, keys: readonly string[]): string {
  const params = new URLSearchParams();
  for (const key of keys) {
    const value = args[key];
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  const query = params.toString();
  return query.length > 0 ? `${path}?${query}` : path;
}

// ── 工具输入 schema（zod；JSON Schema 由 openapi.ts 转换器生成）──────────────

const page = z.number().int().min(1).optional().describe("页码，从 1 开始");
const pageSize = z.number().int().min(1).max(200).optional().describe("每页条数（1-200）");

const customersListSchema = z.object({
  page,
  page_size: pageSize,
  stage: z.string().optional().describe("客户阶段筛选"),
  q: z.string().optional().describe("公司名关键字"),
});

const customersSearchSchema = z.object({
  q: z.string().optional().describe("搜索关键字（公司名）"),
  search: z.string().optional().describe("q 的别名（二者取其一）"),
  page,
  page_size: pageSize,
});

const inquiriesListSchema = z.object({
  status: z.string().optional().describe("询盘状态"),
  customer_id: z.number().int().optional().describe("客户 id"),
});

const ordersListSchema = z.object({
  page,
  page_size: pageSize,
  status: z.string().optional().describe("订单状态"),
  customer_id: z.number().int().optional().describe("客户 id"),
  q: z.string().optional().describe("订单号/客户名关键字"),
});

const tradeDocsListSchema = z.object({
  doc_type: z.string().optional().describe("单证类型"),
  status: z.string().optional().describe("单证状态"),
  order_id: z.number().int().optional().describe("关联订单 id"),
  page,
  page_size: pageSize,
});

const intelShipmentsListSchema = z.object({
  page,
  page_size: pageSize,
  shipper: z.string().optional().describe("发货人（模糊）"),
  consignee: z.string().optional().describe("收货人（模糊）"),
  dest_country: z.string().optional().describe("目的国（模糊）"),
  hs_code: z.string().optional().describe("HS 编码（精确）"),
});

// 报价请求体直接复用 generated/schemas.ts 的 pydantic 生成模型（REST 同一份），
// 不在 MCP 手写第二份字段；计算/核验共用同一输入模型。
const quoteBodySchema = quote_api__CalculateIn;

function quoteTool(name: string, description: string, path: string): ToolDefinition {
  return {
    name,
    description,
    scope: "quotes:calc",
    inputSchema: schemaOf(quoteBodySchema),
    call: (args, ctx) => callRest(ctx, path, { method: "POST", body: args }),
  };
}

const TOOLS: readonly ToolDefinition[] = [
  {
    name: "customers_list",
    description: "列出客户（GET /api/v1/customers；分页/阶段/关键字过滤）。",
    scope: "customers:read",
    inputSchema: schemaOf(customersListSchema),
    call: (args, ctx) =>
      callRest(ctx, withQuery("/api/v1/customers", args, ["page", "page_size", "stage", "q"]), {
        method: "GET",
      }),
  },
  {
    name: "customers_search",
    description: "按公司名搜索客户（GET /api/v1/customers?q=...）。",
    scope: "customers:read",
    inputSchema: schemaOf(customersSearchSchema),
    call: (args, ctx) => {
      const merged: JsonObject = { ...args };
      if (merged.q === undefined && merged.search !== undefined) merged.q = merged.search;
      return callRest(ctx, withQuery("/api/v1/customers", merged, ["page", "page_size", "q"]), {
        method: "GET",
      });
    },
  },
  {
    name: "inquiries_list",
    description: "列出询盘（GET /api/v1/inquiries；状态/客户过滤）。",
    scope: "inquiries:read",
    inputSchema: schemaOf(inquiriesListSchema),
    call: (args, ctx) =>
      callRest(ctx, withQuery("/api/v1/inquiries", args, ["status", "customer_id"]), {
        method: "GET",
      }),
  },
  {
    name: "orders_list",
    description: "列出订单（GET /api/v1/orders；分页/状态/客户/关键字过滤）。",
    scope: "orders:read",
    inputSchema: schemaOf(ordersListSchema),
    call: (args, ctx) =>
      callRest(ctx, withQuery("/api/v1/orders", args, ["page", "page_size", "status", "customer_id", "q"]), {
        method: "GET",
      }),
  },
  {
    name: "trade_docs_list",
    description: "列出单证（GET /api/v1/trade-docs；类型/状态/订单过滤）。",
    scope: "trade_docs:read",
    inputSchema: schemaOf(tradeDocsListSchema),
    call: (args, ctx) =>
      callRest(ctx, withQuery("/api/v1/trade-docs", args, ["doc_type", "status", "order_id", "page", "page_size"]), {
        method: "GET",
      }),
  },
  quoteTool(
    "quotes_calculate",
    "客户视图算价（POST /api/v1/export-quote/calculate；透传 KERNEL 报价引擎）。",
    "/api/v1/export-quote/calculate",
  ),
  quoteTool(
    "quotes_verify",
    "报价核验（POST /api/v1/export-quote/verify；透传 KERNEL 报价引擎，三遍核验）。",
    "/api/v1/export-quote/verify",
  ),
  {
    name: "intel_shipments_list",
    description: "列出情报舱单（GET /api/v1/intel/shipments；发货人/收货人/目的国/HS 过滤）。",
    scope: "intel:read",
    inputSchema: schemaOf(intelShipmentsListSchema),
    call: (args, ctx) =>
      callRest(
        ctx,
        withQuery("/api/v1/intel/shipments", args, [
          "page",
          "page_size",
          "shipper",
          "consignee",
          "dest_country",
          "hs_code",
        ]),
        { method: "GET" },
      ),
  },
];

// ── Resources ─────────────────────────────────────────────────────────────

const WORKSTATION_LABELS: Readonly<Record<string, string>> = {
  customers: "客户管理",
  orders: "订单管理",
  leadgen: "获客",
  outreach: "外联",
  quotes: "报价",
  research: "产品研究",
  shipments: "舱单/发货",
  "trade-docs": "单证",
  intel: "情报",
};

interface ResourceDefinition {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

const RESOURCES: readonly ResourceDefinition[] = [
  {
    uri: "kaas://workstations",
    name: "KaaS 工位清单",
    description: "静态工位编码/名称清单（来自 rules.ts 的 allWorkstations()，非业务判定）。",
    mimeType: "application/json",
  },
  {
    uri: "kaas://openapi",
    name: "KaaS OpenAPI 摘要",
    description: "门面 /openapi.json 的摘要（路径数/操作数/安全方案/路径列表），不含完整文档。",
    mimeType: "application/json",
  },
];

const HTTP_VERBS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);

function workstationsPayload(): JsonObject {
  const codes = allWorkstations();
  return {
    full_chain: FULL_CHAIN,
    // workstations 直接是工位编码清单（真源 rules.ts:allWorkstations，字母序）；
    // labels 是展示名，供 MCP 客户端渲染，不参与任何判定。
    workstations: codes,
    labels: Object.fromEntries(codes.map((key) => [key, WORKSTATION_LABELS[key] ?? key])),
  };
}

function openApiSummary(innerApp: Hono<AppEnv>): JsonObject {
  const doc = buildOpenApiDocument(innerApp.routes);
  let operationCount = 0;
  for (const item of Object.values(doc.paths)) {
    for (const key of Object.keys(item)) {
      if (HTTP_VERBS.has(key.toLowerCase())) operationCount += 1;
    }
  }
  return {
    openapi: doc.openapi,
    title: doc.info.title,
    version: doc.info.version,
    servers: doc.servers,
    path_count: Object.keys(doc.paths).length,
    operation_count: operationCount,
    security_schemes: Object.keys(doc.components.securitySchemes),
    proxy_mounts: doc["x-kaas-proxy-mounts"].map((mount) => mount.prefix),
    paths: Object.keys(doc.paths),
  };
}

function readResource(uri: string, innerApp: Hono<AppEnv>): JsonObject | null {
  if (uri === "kaas://workstations") {
    return {
      uri,
      mimeType: "application/json",
      text: JSON.stringify(workstationsPayload()),
    };
  }
  if (uri === "kaas://openapi") {
    return {
      uri,
      mimeType: "application/json",
      text: JSON.stringify(openApiSummary(innerApp)),
    };
  }
  return null;
}

// ── JSON-RPC dispatch ─────────────────────────────────────────────────────

function toolResult(value: unknown): JsonObject {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  return { content: [{ type: "text", text }] };
}

function toolError(err: RestError): JsonObject {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({ error: "rest_error", status: err.status, body: err.body }),
      },
    ],
  };
}

async function dispatch(
  message: JsonObject,
  actor: ApiTokenActor,
  ctx: ToolCallContext,
  innerApp: Hono<AppEnv>,
): Promise<JsonObject> {
  const method = String(message.method);
  const params = asObject(message.params);

  switch (method) {
    case "initialize":
      return {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {
          tools: { listChanged: false },
          resources: { subscribe: false, listChanged: false },
        },
        serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
        instructions:
          "KaaS 工位能力：tools 按 API token 的 scopes 裁剪；所有工具复用 REST 路由与同一套鉴权。",
      };

    case "ping":
      return {};

    case "tools/list": {
      const tools = TOOLS.filter((tool) => hasScope(actor, tool.scope)).map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }));
      return { tools };
    }

    case "tools/call": {
      if (!params) throw new RpcError(-32602, "Invalid params: params must be an object");
      const name = params.name;
      if (typeof name !== "string" || name.length === 0) {
        throw new RpcError(-32602, "Invalid params: name is required");
      }
      const tool = TOOLS.find((candidate) => candidate.name === name);
      if (!tool) throw new RpcError(-32602, `Unknown tool: ${name}`);
      if (!hasScope(actor, tool.scope)) throw new ScopeDenied(name, tool.scope);

      if (params.arguments !== undefined && asObject(params.arguments) === null) {
        throw new RpcError(-32602, "Invalid params: arguments must be an object");
      }
      const args = asObject(params.arguments ?? {}) ?? {};
      try {
        return toolResult(await tool.call(args, ctx));
      } catch (err) {
        if (err instanceof RestError) return toolError(err);
        throw err;
      }
    }

    case "resources/list":
      return {
        resources: RESOURCES.map((resource) => ({
          uri: resource.uri,
          name: resource.name,
          description: resource.description,
          mimeType: resource.mimeType,
        })),
      };

    case "resources/read": {
      if (!params) throw new RpcError(-32602, "Invalid params: params must be an object");
      const uri = params.uri;
      if (typeof uri !== "string" || uri.length === 0) {
        throw new RpcError(-32602, "Invalid params: uri is required");
      }
      const contents = readResource(uri, innerApp);
      if (!contents) throw new RpcError(-32602, `Unknown resource: ${uri}`);
      return { contents: [contents] };
    }

    case "prompts/list":
      // 首期未实现 prompts：明确返回空列表，避免客户端把“未知方法”当连接故障。
      return { prompts: [] };

    default:
      throw new RpcError(-32601, `Method not found: ${method}`);
  }
}

function rpcErrorResponse(
  c: Context<AppEnv>,
  httpStatus: 200 | 400,
  id: unknown,
  code: number,
  message: string,
  data?: unknown,
): Response {
  return c.json(
    {
      jsonrpc: "2.0",
      id: id ?? null,
      error: { code, message, ...(data === undefined ? {} : { data }) },
    },
    httpStatus,
  );
}

async function authenticate(c: Context<AppEnv>): Promise<ApiTokenActor | Response> {
  try {
    const actor = await resolveActor(c);
    if (actor.kind !== "api_token") {
      return c.json(
        {
          detail: {
            error: "unauthorized",
            message: "MCP requires an API token (Authorization: Bearer kaas_oat_...)",
          },
        },
        401,
      );
    }
    return actor;
  } catch (err) {
    if (err instanceof ApiError) {
      return c.json(err.body, err.status as never);
    }
    throw err;
  }
}

/**
 * 挂载 MCP 路由（index.ts 在业务路由注册完后调用，传入同一个 Hono app 供内部 REST 复用）。
 * 路由路径固定为 /mcp；/api/* 的 API token scope 中间件不会拦截它（MCP 在 handler 内按 tool 校验）。
 */
export function createMcpApp(innerApp: Hono<AppEnv>): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post("/mcp", async (c) => {
    const auth = await authenticate(c);
    if (auth instanceof Response) return auth;
    const actor = auth;

    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      return rpcErrorResponse(c, 400, null, -32700, "Parse error");
    }
    if (Array.isArray(payload)) {
      return rpcErrorResponse(c, 400, null, -32600, "Invalid Request: batch not supported");
    }
    const message = asObject(payload);
    if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      return rpcErrorResponse(c, 400, message?.id, -32600, "Invalid Request");
    }

    const hasId = Object.prototype.hasOwnProperty.call(message, "id");
    if (!hasId) {
      // JSON-RPC notification（如 notifications/initialized）：处理完即 202，无响应体。
      return new Response(null, { status: 202 });
    }

    const ctx: ToolCallContext = {
      app: innerApp,
      env: c.env,
      bearer: (c.req.header("Authorization") ?? "").slice("Bearer ".length),
    };

    try {
      const result = await dispatch(message, actor, ctx, innerApp);
      return c.json({ jsonrpc: "2.0", id: message.id, result });
    } catch (err) {
      if (err instanceof ScopeDenied) {
        return c.json(
          {
            detail: {
              error: "forbidden",
              code: "SCOPE_NOT_DECLARED",
              message: `MCP tool ${err.toolName} requires scope: ${err.requiredScope}`,
            },
          },
          403,
        );
      }
      if (err instanceof RpcError) {
        return rpcErrorResponse(c, 200, message.id, err.code, err.message, err.data);
      }
      throw err;
    }
  });

  // Streamable HTTP 的最小实现只支持 POST；GET SSE 尚未提供（显式 405，避免客户端静默挂起）。
  app.get("/mcp", (c) => c.text("Method Not Allowed", 405, { Allow: "POST" }));

  return app;
}
