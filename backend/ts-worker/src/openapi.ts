/**
 * OpenAPI 3.1 文档生成（W5 M2）——门面 REST 契约真源。
 *
 * 数据来源与边界（先读再改，避免下次误判「为什么只有 object」）：
 * - 路径：100% 从 Hono app.routes 自动发现（直接注册的端点 + 透传前缀 mount）。
 *   本文件不维护第二份路由表；新增/删除路由无需改这里。
 * - 透传路由组（createProxyApp 挂载的 /api/v1/<prefix>/*）：只记录 mount，
 *   在文档中标注 upstream = Python 内核；完整请求/响应契约见内核 OpenAPI。
 * - 请求模型：只有 REQUEST_SCHEMA_HINTS 显式关联的端点才引用
 *   generated/schemas.ts 的 zod 模型（zod → JSON Schema 由本文件内的小转换器完成，
 *   不引第三方依赖）。未关联的请求体统一为通用 object —— 这是有意为之：
 *   **优先保证路径完整 + 安全声明正确，不追求逐端点 schema 完美**。
 * - 响应模型：未逐端点建模（统一通用 object）；错误沿用 FastAPI 信封
 *   {detail: ...} 与内核错误信封 {error, message, status}。
 * - 安全：全局 security = [bearerAuth(JWT), apiToken(Bearer kaas_oat_...)]（二选一）；
 *   /health、/openapi.json 显式 security: []。其余端点按 W5 M2 任务口径统一声明，
 *   包括运行时其实公开的登录/注册（文档层保守，运行期语义不变）。
 * - /docs 是浏览器 UI 页面，不属于 REST 契约，生成时过滤掉。
 */
import type { ZodTypeAny } from "zod";

import {
  chain_CampaignCreate,
  chain_CampaignSend,
  chain_LeadCreate,
  chain_LeadPatch,
  chain_MailboxCreate,
  chain_MailboxPatch,
  chain_PickFromLeadgen,
  chain_ResearchCreate,
  chain_ResearchPatch,
  chain_TaskRun,
  main_NameMappingCreate,
  main_ShipmentCreate,
  ws_admin_accounts_AccountStatusIn,
  ws_extras_ActualCostIn,
  ws_extras_ActualCostResolveIn,
  ws_files_FilePatch,
  ws_files_PresignIn,
  ws_files_RegisterIn,
  ws_products__TenantProductStatusIn,
  ws_products_WorkstationProductIn,
  ws_shipments_ShipmentCreate,
  ws_shipments_ShipmentPatch,
  ws_workstations_SubscriptionIn,
} from "./generated/schemas";

/** package.json version（tsconfig 未开 resolveJsonModule；改版本时这里同步，测试会兜底）。 */
export const OPENAPI_VERSION = "0.1.0";

const TITLE = "KaaS Edge API";

const SERVERS = [
  { url: "https://kaas.powervoy.com", description: "生产门面（UI 同域，/api/v1 前缀）" },
  { url: "https://api.kaas.powervoy.com", description: "生产 API 域名（同一 kaas-edge 门面）" },
] as const;

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

/** 透传 mount 在文档里用这组方法占位（真实挂载是 ALL *）。 */
const MOUNT_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH"]);

/** 首段 → 业务域标签（口径对齐 backend/ts-migration/routes.json 的 domain）。 */
const TAG_BY_SEGMENT: Readonly<Record<string, string>> = {
  // customers
  customers: "customers",
  customer: "customers",
  inquiries: "customers",
  capabilities: "customers",
  "capability-customers": "customers",
  // teams / auth
  teams: "teams",
  auth: "auth",
  // orders
  orders: "orders",
  "payment-schedules": "orders",
  receivables: "orders",
  shipments: "orders",
  "actual-costs": "orders",
  // files
  "file-objects": "files",
  // outreach / admin / dashboard
  outreach: "outreach",
  admin: "admin",
  dashboard: "dashboard",
  // workstations
  workstations: "workstations",
  enums: "workstations",
  me: "workstations",
  spec: "workstations",
  products: "workstations",
  "product-options": "workstations",
  subscriptions: "workstations",
  tenant: "workstations",
  "tenant-products": "workstations",
  "tenant-product-status": "workstations",
  "workstation-products": "workstations",
  users: "workstations",
  // intel
  intel: "intel",
  leadgen: "intel",
  leads: "intel",
  research: "intel",
  market: "intel",
  // 引擎透传组
  quotes: "quotes",
  "export-quote": "quotes",
  quotations: "quotes",
  "fx-rates": "quotes",
  "pricing-data": "quotes",
  "product-tax-rates": "quotes",
  "tax-archives": "quotes",
  "trade-docs": "trade-docs",
  "clause-templates": "trade-docs",
  "external-docs": "trade-docs",
  ai: "ai",
  events: "cron",
  // 门面自有（W5 M1 API token 管理面）
  "api-tokens": "api-tokens",
};

const TAG_ORDER = [
  "auth",
  "customers",
  "teams",
  "orders",
  "files",
  "outreach",
  "admin",
  "workstations",
  "intel",
  "dashboard",
  "api-tokens",
  "quotes",
  "trade-docs",
  "ai",
  "cron",
  "meta",
];

const TAG_DESCRIPTIONS: Readonly<Record<string, string>> = {
  auth: "登录 / 会话 / 账号安全（bootstrap、改密、重置）",
  customers: "客户、联系人、询盘、客户能力位",
  teams: "团队、成员、邀请、团队订阅",
  orders: "订单、收款、付款计划、发货、实际成本",
  files: "文件对象（R2 直传 / 预签名 / 渲染）",
  outreach: "外联邮箱、活动、发信与回执 webhook",
  admin: "平台运维（账号、审计、租户、规格提案）",
  workstations: "工位、产品、规格、租户配置、订阅",
  intel: "情报：线索、leadgen、research、市场、物流",
  dashboard: "看板聚合",
  "api-tokens": "API 令牌管理（W5 M1；仅管理面，token 明文只显示一次）",
  quotes: "报价引擎（透传 Python 内核）",
  "trade-docs": "单证引擎（透传 Python 内核）",
  ai: "AI 能力（透传 Python 内核）",
  cron: "定时 / 事件（透传 Python 内核）",
  meta: "存活探针与 OpenAPI 文档",
};

/** 关联 generated/schemas.ts 的请求体（B 端写操作里已迁移 z 校验的部分）。 */
type RequestHint = readonly [name: string, schema: ZodTypeAny];

const REQUEST_SCHEMA_HINTS: Readonly<Record<string, RequestHint>> = {
  "POST /api/v1/outreach/mailboxes": ["chain_MailboxCreate", chain_MailboxCreate],
  "PATCH /api/v1/outreach/mailboxes/:mailbox_id": ["chain_MailboxPatch", chain_MailboxPatch],
  "POST /api/v1/outreach/campaigns": ["chain_CampaignCreate", chain_CampaignCreate],
  "POST /api/v1/outreach/campaigns/:campaign_id/send": ["chain_CampaignSend", chain_CampaignSend],
  "POST /api/v1/outreach/generate": ["chain_TaskRun", chain_TaskRun],
  "POST /api/v1/leads": ["chain_LeadCreate", chain_LeadCreate],
  "PATCH /api/v1/leads/:lead_id": ["chain_LeadPatch", chain_LeadPatch],
  "POST /api/v1/research/from-leadgen": ["chain_PickFromLeadgen", chain_PickFromLeadgen],
  "POST /api/v1/research/products": ["chain_ResearchCreate", chain_ResearchCreate],
  "PATCH /api/v1/research/products/:research_id": ["chain_ResearchPatch", chain_ResearchPatch],
  "POST /api/v1/market/name-mappings": ["main_NameMappingCreate", main_NameMappingCreate],
  "POST /api/v1/intel/shipments": ["main_ShipmentCreate", main_ShipmentCreate],
  "POST /api/v1/actual-costs": ["ws_extras_ActualCostIn", ws_extras_ActualCostIn],
  "POST /api/v1/actual-costs/resolve": ["ws_extras_ActualCostResolveIn", ws_extras_ActualCostResolveIn],
  "POST /api/v1/shipments": ["ws_shipments_ShipmentCreate", ws_shipments_ShipmentCreate],
  "PATCH /api/v1/shipments/:shipment_id": ["ws_shipments_ShipmentPatch", ws_shipments_ShipmentPatch],
  "PATCH /api/v1/admin/accounts/:user_id": ["ws_admin_accounts_AccountStatusIn", ws_admin_accounts_AccountStatusIn],
  "POST /api/v1/tenant-product-status": ["ws_products__TenantProductStatusIn", ws_products__TenantProductStatusIn],
  "POST /api/v1/workstation-products": ["ws_products_WorkstationProductIn", ws_products_WorkstationProductIn],
  "PUT /api/v1/users/:user_id/subscriptions/:code": ["ws_workstations_SubscriptionIn", ws_workstations_SubscriptionIn],
  "PATCH /api/v1/file-objects/:file_id": ["ws_files_FilePatch", ws_files_FilePatch],
  "POST /api/v1/file-objects/presign": ["ws_files_PresignIn", ws_files_PresignIn],
  "POST /api/v1/file-objects/register": ["ws_files_RegisterIn", ws_files_RegisterIn],
};

// ── 通用 JSON Schema 片段 ────────────────────────────────────────────────

const ANY_JSON = { type: "object", additionalProperties: true } as const;

const ERROR_REF = { $ref: "#/components/schemas/ErrorEnvelope" } as const;
const KERNEL_ERROR_REF = { $ref: "#/components/schemas/KernelErrorEnvelope" } as const;

const HEALTH_SCHEMA = {
  type: "object",
  properties: {
    status: { type: "string", example: "ok" },
    service: { type: "string", example: "kaas-edge" },
    kernel: {
      type: "object",
      additionalProperties: true,
      description: "仅 ?deep=1 时出现：经 KERNEL Service Binding 探内核的结果。",
    },
  },
  required: ["status", "service"],
} as const;

const ERROR_ENVELOPE_SCHEMA = {
  type: "object",
  description: "FastAPI 风格错误信封：detail 为字符串或结构化对象。",
  properties: {
    detail: {
      description: "错误详情（字符串或结构化对象）",
      anyOf: [{ type: "string" }, { type: "object", additionalProperties: true }],
    },
  },
  required: ["detail"],
} as const;

const KERNEL_ERROR_ENVELOPE_SCHEMA = {
  type: "object",
  description: "门面透传内核失败时的归一错误（proxy.ts 铁纪律：5xx/不可达统一包装）。",
  properties: {
    error: { type: "string", example: "kernel_error" },
    message: { type: "string" },
    status: { type: "integer" },
  },
  required: ["error", "message", "status"],
} as const;

// ── 类型 ────────────────────────────────────────────────────────────────

export interface RouteLike {
  method: string;
  path: string;
}

interface ProxyMount {
  prefix: string;
  mount: string;
  upstream: string;
  note: string;
}

export interface OpenApiDocument {
  openapi: "3.1.0";
  info: { title: string; version: string; description: string };
  servers: ReadonlyArray<{ url: string; description?: string }>;
  tags: Array<{ name: string; description: string }>;
  paths: Record<string, Record<string, unknown>>;
  components: {
    securitySchemes: Record<string, Record<string, unknown>>;
    schemas: Record<string, Record<string, unknown>>;
  };
  security: Array<Record<string, string[]>>;
  "x-kaas-proxy-mounts": ProxyMount[];
  "x-kaas-route-surface": {
    source: string;
    directOperations: number;
    proxyMounts: number;
    documentedProxyOperations: number;
  };
}

// ── 路径 / 标签工具 ──────────────────────────────────────────────────────

/** Hono 的 :id 与 FastAPI 的 {id} 归一为 :id（内部口径）。 */
function normalizeParams(path: string): string {
  return path.replace(/\{([^}]+)\}/g, ":$1");
}

/** 内部 :id → OpenAPI {id}。 */
function toOpenApiPath(path: string): string {
  return path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, "{$1}");
}

function pathParameters(path: string): Array<Record<string, unknown>> {
  const names: string[] = [];
  const re = /\{([^}]+)\}/g;
  let match: RegExpExecArray | null = re.exec(path);
  while (match !== null) {
    const name = match[1];
    if (name && !names.includes(name)) names.push(name);
    match = re.exec(path);
  }
  return names.map((name) => ({
    name,
    in: "path",
    required: true,
    schema: { type: "string" },
    description: "路径参数（门面按字符串解析/透传）",
  }));
}

function tagForPath(path: string): string {
  const match = /^\/api\/v1\/([^/]+)/.exec(path);
  if (!match) return "meta";
  const segment = match[1] ?? "";
  return TAG_BY_SEGMENT[segment] ?? segment ?? "meta";
}

function uniqueOperationId(
  tag: string,
  method: string,
  path: string,
  used: Set<string>,
): string {
  const stem = path
    .replace(/^\/api\/v1\//, "")
    .replace(/\{([^}]+)\}/g, "$1")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const base = (tag + "_" + method + "_" + stem).toLowerCase().replace(/_+/g, "_");
  let id = base.length > 0 ? base : "operation";
  let n = 2;
  while (used.has(id)) {
    id = base + "_" + String(n);
    n += 1;
  }
  used.add(id);
  return id;
}

function jsonContent(schema: unknown): Record<string, unknown> {
  return { "application/json": { schema } };
}

function errorResponse(description: string): Record<string, unknown> {
  return { description, content: jsonContent(ERROR_REF) };
}

// ── zod → JSON Schema（只覆盖 generated/schemas.ts 实际用到的子集）────────
//
// 为什么不用 @hono/zod-openapi / zod-to-json-schema：
// - 只有 /openapi.json 需要转换，且 generated 模型只用到 object/string/number/
//   boolean/array/union/record/default/null 这几种构造；
// - 引第三方依赖会给 Worker 增加只为文档服务的运行时代码；故内置小型转换器，
//   遇到未知构造返回 {}（退化为通用 object），不会让文档生成失败。

interface ZodCheck {
  kind?: string;
  value?: number;
  inclusive?: boolean;
  regex?: RegExp;
}

interface ZodDef {
  typeName?: string;
  description?: string;
  shape?: () => Record<string, ZodTypeAny>;
  type?: ZodTypeAny;
  keyType?: ZodTypeAny;
  valueType?: ZodTypeAny;
  options?: ZodTypeAny[];
  values?: readonly string[];
  value?: unknown;
  innerType?: ZodTypeAny;
  schema?: ZodTypeAny;
  in?: ZodTypeAny;
  getter?: () => ZodTypeAny;
  checks?: readonly ZodCheck[];
  defaultValue?: () => unknown;
}

type JsonSchema = Record<string, unknown>;

function defOf(schema: ZodTypeAny): ZodDef {
  return (schema as unknown as { _def?: ZodDef })._def ?? {};
}

export function zodToJsonSchema(schema: ZodTypeAny, seen: Set<ZodTypeAny> = new Set()): JsonSchema {
  const def = defOf(schema);
  const out = convertCore(schema, def, seen);
  if (
    typeof def.description === "string"
    && def.description.length > 0
    && out.description === undefined
  ) {
    out.description = def.description;
  }
  return out;
}

function convertCore(schema: ZodTypeAny, def: ZodDef, seen: Set<ZodTypeAny>): JsonSchema {
  if (seen.has(schema)) return {};
  seen.add(schema);
  try {
    switch (def.typeName) {
      case "ZodObject": {
        const shape = def.shape ? def.shape() : {};
        const properties: JsonSchema = {};
        const required: string[] = [];
        for (const [key, value] of Object.entries(shape)) {
          properties[key] = zodToJsonSchema(value, seen);
          const childType = defOf(value).typeName;
          if (childType !== "ZodOptional" && childType !== "ZodDefault") required.push(key);
        }
        const out: JsonSchema = { type: "object", properties };
        if (required.length > 0) out.required = required;
        return out;
      }
      case "ZodString": {
        const out: JsonSchema = { type: "string" };
        applyStringChecks(def.checks, out);
        return out;
      }
      case "ZodNumber": {
        const isInt = (def.checks ?? []).some((c) => c.kind === "int");
        const out: JsonSchema = { type: isInt ? "integer" : "number" };
        applyNumberChecks(def.checks, out);
        return out;
      }
      case "ZodBoolean":
        return { type: "boolean" };
      case "ZodArray": {
        const out: JsonSchema = {
          type: "array",
          items: def.type ? zodToJsonSchema(def.type, seen) : {},
        };
        for (const check of def.checks ?? []) {
          if (check.kind === "min" && typeof check.value === "number") out.minItems = check.value;
          if (check.kind === "max" && typeof check.value === "number") out.maxItems = check.value;
        }
        return out;
      }
      case "ZodUnion": {
        const options = (def.options ?? []).map((option) => zodToJsonSchema(option, seen));
        return { anyOf: options };
      }
      case "ZodRecord": {
        const value = def.valueType ?? def.type;
        return {
          type: "object",
          additionalProperties: value ? zodToJsonSchema(value, seen) : true,
        };
      }
      case "ZodDefault": {
        const out = def.innerType ? zodToJsonSchema(def.innerType, seen) : {};
        if (def.defaultValue) {
          try {
            const value = def.defaultValue();
            if (value !== undefined) {
              JSON.stringify(value); // 防循环/不可序列化默认值（如函数）
              out.default = value;
            }
          } catch {
            // 默认值不可序列化就不写，不影响 rest
          }
        }
        return out;
      }
      case "ZodOptional":
        return def.innerType ? zodToJsonSchema(def.innerType, seen) : {};
      case "ZodNullable": {
        const inner = def.innerType ? zodToJsonSchema(def.innerType, seen) : {};
        return { anyOf: [inner, { type: "null" }] };
      }
      case "ZodEnum":
        return { type: "string", enum: [...(def.values ?? [])] };
      case "ZodLiteral":
        return { const: def.value };
      case "ZodAny":
      case "ZodUnknown":
        return {};
      case "ZodNull":
        return { type: "null" };
      case "ZodDate":
        return { type: "string", format: "date-time" };
      case "ZodEffects":
        return def.schema ? zodToJsonSchema(def.schema, seen) : {};
      case "ZodCatch":
        return def.innerType ? zodToJsonSchema(def.innerType, seen) : {};
      case "ZodBranded":
        return def.type ? zodToJsonSchema(def.type, seen) : {};
      case "ZodPipeline":
        return def.in ? zodToJsonSchema(def.in, seen) : {};
      case "ZodLazy": {
        if (!def.getter) return {};
        return zodToJsonSchema(def.getter(), seen);
      }
      default:
        return {};
    }
  } finally {
    seen.delete(schema);
  }
}

function applyStringChecks(checks: readonly ZodCheck[] | undefined, out: JsonSchema): void {
  for (const check of checks ?? []) {
    if (check.kind === "min" && typeof check.value === "number") out.minLength = check.value;
    if (check.kind === "max" && typeof check.value === "number") out.maxLength = check.value;
    if (check.kind === "regex" && check.regex instanceof RegExp) out.pattern = check.regex.source;
    if (check.kind === "datetime") out.format = "date-time";
    if (check.kind === "email") out.format = "email";
    if (check.kind === "url") out.format = "uri";
    if (check.kind === "uuid") out.format = "uuid";
  }
}

function applyNumberChecks(checks: readonly ZodCheck[] | undefined, out: JsonSchema): void {
  for (const check of checks ?? []) {
    if (typeof check.value !== "number") continue;
    if (check.kind === "min") {
      if (check.inclusive === false) out.exclusiveMinimum = check.value;
      else out.minimum = check.value;
    }
    if (check.kind === "max") {
      if (check.inclusive === false) out.exclusiveMaximum = check.value;
      else out.maximum = check.value;
    }
  }
}

// ── 操作生成 ────────────────────────────────────────────────────────────

interface OperationOptions {
  tag: string;
  method: string;
  path: string;
  reqKey: string;
  usedOperationIds: Set<string>;
  components: Record<string, Record<string, unknown>>;
  isProxy: boolean;
  special?: "health" | "openapi";
}

function buildOperation(options: OperationOptions): Record<string, unknown> {
  const { tag, method, path, reqKey, usedOperationIds, components, isProxy, special } = options;
  const operation: Record<string, unknown> = {
    operationId: uniqueOperationId(tag, method, path, usedOperationIds),
    summary: tag + " " + method + " " + path,
    tags: [tag],
    description: isProxy
      ? "透传路由组：" + path + " → Python 内核（Service Binding KERNEL）。"
        + "门面只做鉴权 + 原样转发，不重写业务；请求/响应契约详见内核 OpenAPI。"
      : "门面路由 " + method + " " + path + "。业务规则在 Python 内核（ADR-008），"
        + "门面只做鉴权 / 参数校验 / 协议转换。",
    responses: defaultResponses(method, isProxy),
  };

  const params = pathParameters(path);
  if (params.length > 0) operation.parameters = params;

  if (special === "health") {
    operation.description =
      "存活探针（对齐 Python 版 GET /health；无需鉴权）。?deep=1 时经 KERNEL Service Binding 探内核（部署冒烟用）。";
    operation.security = [];
    operation.responses = {
      "200": { description: "OK", content: jsonContent(HEALTH_SCHEMA) },
    };
  }
  if (special === "openapi") {
    operation.description = "本 OpenAPI 3.1 文档（由门面显式服务，application/json；无需鉴权）。";
    operation.security = [];
    operation.responses = {
      "200": { description: "OpenAPI 3.1 文档", content: jsonContent(ANY_JSON) },
    };
  }

  if (!special && WRITE_METHODS.has(method)) {
    const hint = REQUEST_SCHEMA_HINTS[reqKey];
    let schema: unknown = ANY_JSON;
    let description = "请求体（通用 object：该端点未关联 generated 模型，形状以内核/前端契约为准）";
    if (hint) {
      const [name, zodSchema] = hint;
      if (!components[name]) components[name] = zodToJsonSchema(zodSchema);
      schema = { $ref: "#/components/schemas/" + name };
      description = "请求体（zod 生成模型 " + name + "；源 src/generated/schemas.ts）";
    }
    operation.requestBody = {
      required: true,
      description,
      content: jsonContent(schema),
    };
  }

  return operation;
}

function defaultResponses(method: string, isProxy: boolean): Record<string, unknown> {
  const responses: Record<string, unknown> = {
    "200": {
      description: isProxy
        ? "透传，详见内核 openapi（响应形状/状态码由 Python 内核决定，门面不改写）"
        : "成功（application/json）",
      content: jsonContent(ANY_JSON),
    },
    "401": errorResponse("未认证（Bearer 缺失/无效；JWT 或 kaas_oat_ API token）"),
    "403": errorResponse("无权限（角色/scope/工位不足）"),
  };
  if (WRITE_METHODS.has(method)) {
    responses["422"] = errorResponse("参数校验失败（FastAPI 风格 detail）");
  }
  if (isProxy) {
    responses["502"] = { description: "内核不可达（kernel_error）", content: jsonContent(KERNEL_ERROR_REF) };
    responses["503"] = { description: "内核未配置 / 暂不可用（kernel_error）", content: jsonContent(KERNEL_ERROR_REF) };
  }
  return responses;
}

function proxyMountRecord(prefix: string): ProxyMount {
  return {
    prefix,
    mount: "ALL " + prefix + "/*",
    upstream: "python-kernel",
    note: "透传，详见内核 openapi（门面不改写请求/响应语义）",
  };
}

// ── 主入口 ──────────────────────────────────────────────────────────────

/**
 * 从 Hono app.routes 生成 OpenAPI 3.1。
 *
 * @param routes Hono 的 app.routes（method/path 即可，传子集也可用于测试）
 */
export function buildOpenApiDocument(routes: ReadonlyArray<RouteLike>): OpenApiDocument {
  const paths: Record<string, Record<string, unknown>> = {};
  const usedOperationIds = new Set<string>();
  const usedTags = new Set<string>();
  const components: Record<string, Record<string, unknown>> = {
    ErrorEnvelope: { ...ERROR_ENVELOPE_SCHEMA },
    KernelErrorEnvelope: { ...KERNEL_ERROR_ENVELOPE_SCHEMA },
  };
  const seenRoutes = new Set<string>();
  const mounts: ProxyMount[] = [];
  let directOperations = 0;

  for (const route of routes) {
    const method = String(route.method ?? "").toUpperCase();
    const rawPath = String(route.path ?? "");
    if (!rawPath.startsWith("/")) continue;

    if (method === "ALL") {
      // 根 catch-all 是 CORS 中间件（app.use("*")），不是业务路由；
      // /api/v1/<prefix>/* 是透传挂载点（ALL），单独记录为 mount。
      if (rawPath === "/*") continue;
      if (!rawPath.endsWith("/*")) continue;
      const prefix = rawPath.slice(0, -2);
      if (!prefix || mounts.some((m) => m.prefix === prefix)) continue;
      mounts.push(proxyMountRecord(prefix));
      continue;
    }

    if (!HTTP_METHODS.has(method)) continue;

    const normPath = normalizeParams(rawPath);
    // /docs 是浏览器 UI（HTML），不属于 REST 契约，不进 paths。
    if (normPath === "/docs") continue;

    const dedupeKey = method + " " + normPath;
    if (seenRoutes.has(dedupeKey)) continue;
    seenRoutes.add(dedupeKey);

    const tag = tagForPath(normPath);
    usedTags.add(tag);
    const pathKey = toOpenApiPath(normPath);
    const item = paths[pathKey] ?? {};
    const special = normPath === "/health"
      ? "health"
      : normPath === "/openapi.json"
        ? "openapi"
        : undefined;

    item[method.toLowerCase()] = buildOperation({
      tag,
      method,
      path: pathKey,
      reqKey: method + " " + normPath,
      usedOperationIds,
      components,
      isProxy: false,
      ...(special ? { special } : {}),
    });
    paths[pathKey] = item;
    directOperations += 1;
  }

  // 透传组：每条前缀一个占位 path（{proxyPath} = 内核任意子路径），标注 upstream。
  mounts.sort((a, b) => a.prefix.localeCompare(b.prefix));
  for (const mount of mounts) {
    const tag = tagForPath(mount.prefix);
    usedTags.add(tag);
    const pathKey = mount.prefix + "/{proxyPath}";
    const item: Record<string, unknown> = {
      "x-kaas-proxy-mount": mount,
      description: "透传路由组 " + mount.prefix + "/*：上游 Python 内核（" + mount.note + "）。",
    };
    for (const method of MOUNT_METHODS) {
      const operation = buildOperation({
        tag,
        method,
        path: pathKey,
        reqKey: method + " " + mount.prefix + "/{proxyPath}",
        usedOperationIds,
        components,
        isProxy: true,
      });
      // {proxyPath} 不是单段参数：标注为「内核任意子路径」，避免误解为只能一段。
      const params = operation.parameters;
      if (Array.isArray(params)) {
        for (const param of params) {
          if (param && typeof param === "object") {
            const record = param as Record<string, unknown>;
            if (record.name === "proxyPath") {
              record.description = "内核任意子路径（可含多级 /），门面原样透传";
            }
          }
        }
      }
      item[method.toLowerCase()] = operation;
    }
    paths[pathKey] = item;
  }

  const tags = [...usedTags]
    .sort((a, b) => {
      const ia = TAG_ORDER.indexOf(a);
      const ib = TAG_ORDER.indexOf(b);
      if (ia !== ib) return (ia < 0 ? TAG_ORDER.length : ia) - (ib < 0 ? TAG_ORDER.length : ib);
      return a.localeCompare(b);
    })
    .map((name) => ({ name, description: TAG_DESCRIPTIONS[name] ?? name }));

  return {
    openapi: "3.1.0",
    info: {
      title: TITLE,
      version: OPENAPI_VERSION,
      description:
        "KaaS TS 门面（kaas-edge）REST 契约。路径从 Hono app.routes 自动发现："
        + "直接注册端点 + 透传前缀 mount。业务规则只在 Python 内核实现；"
        + "透传组的完整契约见内核 OpenAPI。请求/响应 schema 仅对已关联的生成模型展开，"
        + "其余为通用 object（有意边界，见 src/openapi.ts 文件头）。",
    },
    servers: SERVERS,
    tags,
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          description: "UI 会话 JWT（HS256）。Authorization: Bearer <jwt>",
        },
        apiToken: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "kaas_oat_*",
          description:
            "API token（W5 M1）：Bearer kaas_oat_<base64url>。"
            + "与 JWT 共用 Bearer 头，门面按 kaas_oat_ 前缀分流；scope 见 /api/v1/api-tokens。",
        },
      },
      schemas: components,
    },
    security: [{ bearerAuth: [] }, { apiToken: [] }],
    "x-kaas-proxy-mounts": mounts,
    "x-kaas-route-surface": {
      source: "hono app.routes",
      directOperations,
      proxyMounts: mounts.length,
      documentedProxyOperations: mounts.length * MOUNT_METHODS.length,
    },
  };
}
