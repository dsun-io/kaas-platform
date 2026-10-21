/**
 * KaaS TS 门面 · HTTP 协议助手（错误信封 + 入参解析 + 值规范化）。
 *
 * 只做协议层转换，不含任何业务规则（ADR-008）。
 *
 * 错误信封对齐 FastAPI HTTPException 语义：**响应体恒为 {"detail": <detail>}**，
 * detail 本身可以是字符串（旧式）或对象（新式 {error/code/detail...}）。
 * 对照真源：backend/worker/src/main.py 各端点的 HTTPException 抛出处。
 */
import type { Context } from "hono";
import { ZodError, type ZodTypeAny, type output } from "zod";

import { MissingSecretError } from "./env";

/** 对齐 FastAPI HTTPException(status_code, detail=detail) → 响应体 {"detail": detail}。 */
export class ApiError extends Error {
  readonly status: number;
  readonly detail: unknown;
  constructor(status: number, detail: unknown) {
    super(typeof detail === "string" ? detail : JSON.stringify(detail));
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
  }
  /** 完整响应体（FastAPI 把 HTTPException.detail 包成 {"detail": ...}）。 */
  get body(): { detail: unknown } {
    return { detail: this.detail };
  }
}

/** 构造 HTTP 错误（对齐 Python raise HTTPException(status_code=..., detail=...)）。 */
export function httpError(status: number, detail: unknown): ApiError {
  return new ApiError(status, detail);
}

/**
 * 路由统一出口：把 ApiError / MissingSecretError 映射成响应，其余异常上抛
 * （由 index.ts CORS 中间件的兜底 catch 转成 500，对齐 Python 未捕获异常路径）。
 */
export async function respond(c: Context, fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ApiError) {
      return c.json(e.body, e.status as never);
    }
    if (e instanceof MissingSecretError) {
      // 对齐 Python：HTTPException(503, detail=f"{key} not configured")
      return c.json({ detail: e.message }, 503);
    }
    throw e;
  }
}

/** FastAPI/pydantic 风格 422 detail 数组元素（缺失字段）。 */
function missingIssue(loc: (string | number)[], input: unknown): Record<string, unknown> {
  return { type: "missing", loc, msg: "Field required", input, url: "https://errors.pydantic.dev/2.11/v/missing" };
}

/** 非法类型（pydantic v2 int_parsing/float_parsing 等措辞的近似，已登记金标差异）。 */
function invalidTypeIssue(loc: (string | number)[], input: unknown, msg: string): Record<string, unknown> {
  return { type: "value_error", loc, msg, input };
}

/**
 * 解析 JSON body 并跑 zod 校验。
 * - 非法 JSON → 422（对齐 FastAPI json_invalid；URL 措辞为近似，已登记差异）。
 * - 校验失败 → 422 detail 数组（loc 前缀 "body"，对齐 pydantic v2 形状；
 *   逐字 message 对齐依赖 schema 生成器，TODO(TODO:TS1)，当前为近似形状）。
 */
export async function parseBody<S extends ZodTypeAny>(c: Context, schema: S): Promise<output<S>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw httpError(422, [
      { type: "json_invalid", loc: ["body"], msg: "Invalid JSON", input: null },
    ]);
  }
  return parseWith(schema, body, ["body"]);
}

/** 解析 query/path 参数（loc 前缀对齐 FastAPI："query" / "path"）。 */
export function parseQuery<S extends ZodTypeAny>(
  schema: S,
  input: unknown,
  where: "query" | "path" = "query",
): output<S> {
  return parseWith(schema, input, [where]);
}

function parseWith<S extends ZodTypeAny>(schema: S, input: unknown, locPrefix: string[]): output<S> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  throw httpError(422, result.error.issues.map((issue) => {
    const loc = [...locPrefix, ...issue.path.map((p) => (typeof p === "symbol" ? String(p) : p))];
    if (issue.code === "invalid_type" && issue.received === "undefined") {
      return missingIssue(loc, input);
    }
    return invalidTypeIssue(loc, input, issue.message);
  }));
}

/** pydantic .isoformat() 对齐：+00:00 偏移（微秒精度差异已登记金标白名单）。 */
export function pyIso(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) {
    return value.toISOString().replace("Z", "+00:00");
  }
  return value;
}

/** int8/BIGINT 列在 postgres.js 下是 string；Python asyncpg 返回 int。 */
export function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return Number(value);
}

/** 同 num，但用于非空场景（count(*) 等）。 */
export function num0(value: unknown): number {
  return Number(value ?? 0);
}

/** 布尔列兜底（postgres.js 已返回 boolean，这里防 string 形态）。 */
export function bool(value: unknown): boolean {
  return value === true || value === "t" || value === "true";
}
