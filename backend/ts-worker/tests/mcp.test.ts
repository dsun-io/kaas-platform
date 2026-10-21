/**
 * W5 M3 · MCP server + API token → 内部 JWT 凭据转换测试。
 *
 * 覆盖：
 * - POST /mcp：initialize / ping / notifications/initialized / JSON-RPC 错误（-32601/-32602）；
 * - tools/list 按 API token scopes 裁剪；
 * - tools/call 成功（内部复用 REST）、缺 scope 403、工具内部 REST 错误 → isError；
 * - resources/list + resources/read（workstations / openapi 摘要）；
 * - proxy：API token 转发 KERNEL 前换短时效内部 JWT（sub=created_by、team_id、exp≤60s），
 *   JWT 请求则原样透传（JWT 语义零改动）。
 */
import { jwtVerify } from "jose";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../src/env";
import app from "../src/index";
import { createToken } from "../src/session";
import { mintApiToken } from "../src/tokens";
import { INTERNAL_JWT_TTL_SECONDS } from "../src/proxy";
import {
  dbCallsContaining,
  FIXED_SECRET,
  resetDb,
  TEST_ENV,
  type DbRow,
} from "./helpers";

vi.mock("../src/db", () => import("./db-mock"));

// ── 桩 ────────────────────────────────────────────────────────────────────

function tokenRow(overrides: Partial<DbRow> = {}): DbRow {
  return {
    id: 3,
    tenant_id: "default",
    team_id: 4,
    name: "MCP token",
    scopes: ["customers:read"],
    prefix: "kaas_oat_AbCdEf12",
    created_by: 5,
    created_at: new Date("2026-10-21T03:00:00Z"),
    last_used_at: null,
    expires_at: null,
    revoked_at: null,
    ...overrides,
  };
}

function userRow(overrides: Partial<DbRow> = {}): DbRow {
  return {
    id: 5,
    email: "owner@qa.test",
    display_name: "Owner",
    account_type: "customer",
    role: "owner",
    status: "active",
    team_id: 4,
    console_access: false,
    plan: "free",
    is_tenant_admin: false,
    ...overrides,
  };
}

function installToken(scopes: string[]): string {
  const minted = mintApiToken();
  resetDb((query) => {
    if (query.includes("FROM api_tokens")) return [tokenRow({ scopes })];
    if (query.includes("FROM users WHERE id")) return [userRow()];
    return [];
  });
  return minted.plaintext;
}

function bearer(token: string, init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return { ...init, headers };
}

async function mcpPost(
  body: unknown,
  token: string,
  env: Env = TEST_ENV,
): Promise<Response> {
  return await app.request(
    "/mcp",
    bearer(token, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
  );
}

interface JsonRpcResponse {
  jsonrpc: string;
  id: unknown;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

interface ToolTextResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

function parseToolResult(body: JsonRpcResponse): unknown {
  const result = body.result as ToolTextResult | undefined;
  expect(result?.content[0]?.type).toBe("text");
  return JSON.parse(result?.content[0]?.text ?? "null");
}

function captureKernel(): {
  env: Env;
  calls: Array<{ url: string; method: string; authorization: string | null }>;
} {
  const calls: Array<{ url: string; method: string; authorization: string | null }> = [];
  const env: Env = {
    ...TEST_ENV,
    KERNEL: {
      fetch: async (input: Request | string, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(input, init);
        calls.push({
          url: req.url,
          method: req.method,
          authorization: req.headers.get("Authorization"),
        });
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    },
  };
  return { env, calls };
}

beforeEach(() => {
  resetDb(() => []);
});

// ── JSON-RPC 基础 ─────────────────────────────────────────────────────────

describe("POST /mcp · JSON-RPC 基础", () => {
  it("initialize → protocolVersion / serverInfo / capabilities.tools", async () => {
    const token = installToken(["customers:read"]);
    const res = await mcpPost(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "vitest", version: "0.0.1" },
        },
      },
      token,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as JsonRpcResponse;
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBe(1);
    expect(body.result?.protocolVersion).toBe("2025-06-18");
    expect(body.result?.serverInfo).toMatchObject({ name: "kaas-edge-mcp" });
    expect(body.result?.capabilities).toMatchObject({ tools: { listChanged: false } });
  });

  it("notifications/initialized（无 id）→ 202 无 body", async () => {
    const token = installToken(["customers:read"]);
    const res = await mcpPost(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      token,
    );

    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });

  it("ping → {}", async () => {
    const token = installToken(["customers:read"]);
    const res = await mcpPost({ jsonrpc: "2.0", id: "p", method: "ping" }, token);

    expect(res.status).toBe(200);
    expect((await res.json()) as JsonRpcResponse).toMatchObject({
      jsonrpc: "2.0",
      id: "p",
      result: {},
    });
  });

  it("未知 method → JSON-RPC -32601", async () => {
    const token = installToken(["customers:read"]);
    const res = await mcpPost({ jsonrpc: "2.0", id: 9, method: "no/such" }, token);

    expect(res.status).toBe(200);
    const body = (await res.json()) as JsonRpcResponse;
    expect(body.error?.code).toBe(-32601);
    expect(body.error?.message).toContain("no/such");
  });

  it("非法 JSON → HTTP 400 + -32700", async () => {
    const token = installToken(["customers:read"]);
    const res = await app.request(
      "/mcp",
      bearer(token, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      }),
      TEST_ENV,
    );

    expect(res.status).toBe(400);
    expect(((await res.json()) as JsonRpcResponse).error?.code).toBe(-32700);
  });

  it("缺 API token → 401（现有 unauthorized 信封）", async () => {
    const res = await app.request(
      "/mcp",
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
      TEST_ENV,
    );

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      detail: { error: "unauthorized", message: "Authentication required" },
    });
  });

  it("JWT（非 API token）→ 401 MCP requires an API token", async () => {
    resetDb((query) => (query.includes("FROM users WHERE id") ? [userRow()] : []));
    const jwt = await createToken(5, FIXED_SECRET);
    const res = await mcpPost({ jsonrpc: "2.0", id: 1, method: "ping" }, jwt);

    expect(res.status).toBe(401);
    const body = (await res.json()) as { detail: { message: string } };
    expect(body.detail.message).toContain("API token");
  });

  it("GET /mcp → 405 Allow: POST（最小 Streamable HTTP 不含 SSE）", async () => {
    const res = await app.request("/mcp", { method: "GET" }, TEST_ENV);
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });
});

// ── tools/list 按 scope 裁剪 ─────────────────────────────────────────────

describe("tools/list · scope 过滤", () => {
  it("customers:read → 只见 customers 两个工具", async () => {
    const token = installToken(["customers:read"]);
    const res = await mcpPost({ jsonrpc: "2.0", id: 2, method: "tools/list" }, token);

    expect(res.status).toBe(200);
    const body = (await res.json()) as JsonRpcResponse;
    const tools = (body.result?.tools ?? []) as Array<{ name: string }>;
    expect(tools.map((tool) => tool.name)).toEqual(["customers_list", "customers_search"]);
  });

  it("customers:read + quotes:calc + intel:read → 只出现对应工具", async () => {
    const token = installToken(["customers:read", "quotes:calc", "intel:read"]);
    const res = await mcpPost({ jsonrpc: "2.0", id: 2, method: "tools/list" }, token);

    const body = (await res.json()) as JsonRpcResponse;
    const names = ((body.result?.tools ?? []) as Array<{ name: string }>).map((tool) => tool.name);
    expect(names).toEqual([
      "customers_list",
      "customers_search",
      "quotes_calculate",
      "quotes_verify",
      "intel_shipments_list",
    ]);
  });

  it("tool inputSchema 是 JSON Schema object（zod 转换，不手写第二份）", async () => {
    const token = installToken(["customers:read"]);
    const res = await mcpPost({ jsonrpc: "2.0", id: 2, method: "tools/list" }, token);
    const body = (await res.json()) as JsonRpcResponse;
    const tools = (body.result?.tools ?? []) as Array<{ inputSchema: Record<string, unknown> }>;
    expect(tools[0]?.inputSchema).toMatchObject({ type: "object" });
  });
});

// ── tools/call ────────────────────────────────────────────────────────────

describe("tools/call", () => {
  it("customers_list 内部复用 REST，返回同形状 {items,total,page,page_size}", async () => {
    const token = installToken(["customers:read"]);
    const res = await mcpPost(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "customers_list", arguments: { page: 1, page_size: 5 } },
      },
      token,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as JsonRpcResponse;
    expect(body.result?.isError).toBeUndefined();
    expect(parseToolResult(body)).toMatchObject({ items: [], total: 0, page: 1, page_size: 5 });
    expect(dbCallsContaining("FROM users WHERE id")).not.toHaveLength(0);
  });

  it("quotes_calculate 走透传：返回 KERNEL 结果，且 KERNEL 收到内部 JWT", async () => {
    const token = installToken(["quotes:calc"]);
    const captured = captureKernel();
    const res = await mcpPost(
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "quotes_calculate", arguments: { product_key: "X", quantity: 1 } },
      },
      token,
      captured.env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as JsonRpcResponse;
    expect(parseToolResult(body)).toEqual({ ok: true });
    expect(captured.calls).toHaveLength(1);
    expect(captured.calls[0]?.url).toContain("/api/v1/export-quote/calculate");
    const auth = captured.calls[0]?.authorization ?? "";
    expect(auth.startsWith("Bearer kaas_oat_")).toBe(false);
    const { payload } = await jwtVerify(auth.slice("Bearer ".length), new TextEncoder().encode(FIXED_SECRET), {
      algorithms: ["HS256"],
    });
    expect(payload.sub).toBe("5");
    expect(payload.team_id).toBe(4);
    expect(payload.token_id).toBe(3);
  });

  it("缺 scope → HTTP 403 SCOPE_NOT_DECLARED（不调用 REST/KERNEL）", async () => {
    const token = installToken(["customers:read"]);
    const captured = captureKernel();
    const res = await mcpPost(
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "quotes_calculate", arguments: {} },
      },
      token,
      captured.env,
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as { detail: { code: string; message: string } };
    expect(body.detail.code).toBe("SCOPE_NOT_DECLARED");
    expect(body.detail.message).toContain("quotes:calc");
    expect(captured.calls).toHaveLength(0);
  });

  it("未知工具 → JSON-RPC -32602", async () => {
    const token = installToken(["customers:read"]);
    const res = await mcpPost(
      { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "nope", arguments: {} } },
      token,
    );

    const body = (await res.json()) as JsonRpcResponse;
    expect(body.error?.code).toBe(-32602);
    expect(body.error?.message).toContain("nope");
  });

  it("工具内部 REST 非 2xx → MCP result isError:true（不改写为协议错误）", async () => {
    const token = installToken(["customers:read"]);
    resetDb((query) => {
      if (query.includes("FROM api_tokens")) return [tokenRow({ scopes: ["customers:read"] })];
      if (query.includes("FROM users WHERE id")) return [userRow({ status: "disabled" })];
      return [];
    });
    const res = await mcpPost(
      { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "customers_list", arguments: {} } },
      token,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as JsonRpcResponse;
    const result = body.result as unknown as ToolTextResult;
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0]?.text ?? "{}") as { status: number };
    expect(payload.status).toBe(401);
  });
});

// ── resources ─────────────────────────────────────────────────────────────

describe("resources", () => {
  it("resources/list → workstations + openapi", async () => {
    const token = installToken(["customers:read"]);
    const res = await mcpPost({ jsonrpc: "2.0", id: 8, method: "resources/list" }, token);
    const body = (await res.json()) as JsonRpcResponse;
    const resources = (body.result?.resources ?? []) as Array<{ uri: string }>;
    expect(resources.map((resource) => resource.uri)).toEqual([
      "kaas://workstations",
      "kaas://openapi",
    ]);
  });

  it("resources/read kaas://workstations → 9 个工位 + full_chain", async () => {
    const token = installToken(["customers:read"]);
    const res = await mcpPost(
      { jsonrpc: "2.0", id: 9, method: "resources/read", params: { uri: "kaas://workstations" } },
      token,
    );
    const body = (await res.json()) as JsonRpcResponse;
    const contents = (body.result?.contents ?? []) as Array<{ text: string }>;
    const payload = JSON.parse(contents[0]?.text ?? "{}") as {
      full_chain: string;
      workstations: string[];
      labels: Record<string, string>;
    };
    expect(payload.full_chain).toBe("full_chain");
    expect(payload.workstations).toHaveLength(9);
    expect(payload.workstations).toContain("trade-docs");
    expect(payload.labels["trade-docs"]).toBe("单证");
  });

  it("resources/read kaas://openapi → 路径数/操作数/security profile 摘要", async () => {
    const token = installToken(["customers:read"]);
    const res = await mcpPost(
      { jsonrpc: "2.0", id: 10, method: "resources/read", params: { uri: "kaas://openapi" } },
      token,
    );
    const body = (await res.json()) as JsonRpcResponse;
    const contents = (body.result?.contents ?? []) as Array<{ text: string }>;
    const payload = JSON.parse(contents[0]?.text ?? "{}") as {
      path_count: number;
      operation_count: number;
      security_schemes: string[];
    };
    expect(payload.path_count).toBeGreaterThan(0);
    expect(payload.operation_count).toBeGreaterThan(0);
    expect(payload.security_schemes).toContain("apiToken");
  });

  it("未知 resource → JSON-RPC -32602", async () => {
    const token = installToken(["customers:read"]);
    const res = await mcpPost(
      { jsonrpc: "2.0", id: 11, method: "resources/read", params: { uri: "kaas://nope" } },
      token,
    );
    const body = (await res.json()) as JsonRpcResponse;
    expect(body.error?.code).toBe(-32602);
  });
});

// ── proxy 凭据转换 ────────────────────────────────────────────────────────

describe("proxy · API token → 内部 JWT", () => {
  it("转发 KERNEL 前换短时效 JWT（sub/team_id/token_id，exp≤60s），不转发 kaas_oat_ 明文", async () => {
    const token = installToken(["quotes:calc"]);
    const captured = captureKernel();
    const res = await app.request(
      "/api/v1/export-quote/calculate",
      bearer(token, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ product_key: "X" }),
      }),
      captured.env,
    );

    expect(res.status).toBe(200);
    expect(captured.calls).toHaveLength(1);
    const auth = captured.calls[0]?.authorization ?? "";
    expect(auth.startsWith("Bearer ")).toBe(true);
    const internalJwt = auth.slice("Bearer ".length);
    expect(internalJwt.startsWith("kaas_oat_")).toBe(false);

    const { payload } = await jwtVerify(
      internalJwt,
      new TextEncoder().encode(FIXED_SECRET),
      { algorithms: ["HS256"] },
    );
    expect(payload.sub).toBe("5");
    expect(payload.created_by).toBe(5);
    expect(payload.tenant_id).toBe("default");
    expect(payload.team_id).toBe(4);
    expect(payload.token_id).toBe(3);
    const ttl = Number(payload.exp) - Number(payload.iat);
    expect(ttl).toBeLessThanOrEqual(INTERNAL_JWT_TTL_SECONDS);
    expect(ttl).toBeLessThanOrEqual(60);
  });

  it("JWT 请求原样透传（Authorization 不被替换）", async () => {
    const captured = captureKernel();
    const jwt = await createToken(5, FIXED_SECRET);
    const res = await app.request(
      "/api/v1/export-quote/calculate",
      bearer(jwt, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ product_key: "X" }),
      }),
      captured.env,
    );

    expect(res.status).toBe(200);
    expect(captured.calls[0]?.authorization).toBe(`Bearer ${jwt}`);
    expect(dbCallsContaining("FROM api_tokens")).toHaveLength(0);
  });
});
