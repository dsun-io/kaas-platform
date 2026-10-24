// AI 只读端点（providers / usage）门面直连 —— P3 只读迁移批次。
//
// 测的是子应用（src/routes/ai-read.ts）；接线（index.ts mount / boot-flag）由 Lead 做。
// 真源：backend/worker/src/chain.py:583-596（providers）/ :710-747（usage）；
// 表类型：backend/orchestrator/alembic/versions/20260921_ai_layer.py。
//
// 覆盖：on 直连（形状 + SQL/参数逐字 + stats 聚合）/ off 逐字透传 / 平台运营闸门 403 /
//       分页与筛选项 422 / 401 / DB 失败 503 / 不触内核。
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../src/env";
import aiReadRoutes, { maskApiKey } from "../src/routes/ai-read";
import { DB_UNAVAILABLE_MESSAGE } from "../src/hot-read";
import { createToken } from "../src/session";
import {
  FIXED_SECRET,
  dbCallsContaining,
  dbState,
  makeTestEnv,
  resetDb,
  type DbRow,
} from "./helpers";

vi.mock("../src/db", () => import("./db-mock"));

const app = new Hono<{ Bindings: Env }>();
app.route("/", aiReadRoutes);

function userRow(overrides: Partial<DbRow> = {}): DbRow {
  return {
    id: 9, email: "staff@qa.test", display_name: "Staff",
    account_type: "internal", role: "user", status: "active", team_id: 4,
    console_access: true, plan: "free", is_tenant_admin: false, ...overrides,
  };
}
/** 平台运营 = internal + 管理员（chain._require_ai_admin → main._require_platform_ops）。 */
const AI_ADMIN: DbRow = userRow({ role: "admin" });
const NOW = "2026-10-24T08:00:00.000+00:00";

function kernelSpy(flag: Record<string, unknown> = {}) {
  const seen: Array<{ method: string; path: string; search: string }> = [];
  const fetch = vi.fn(async (input: Request | string) => {
    const req = input instanceof Request ? input : new Request(input);
    const url = new URL(req.url);
    seen.push({ method: req.method, path: url.pathname, search: url.search });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  });
  const env = makeTestEnv({ KERNEL: { fetch: fetch as never }, ...flag });
  return { seen, fetch, env };
}
const onEnv = (flag: Record<string, unknown> = {}) => kernelSpy({ AUTH_DB_SPLIT: "on", ...flag });

async function request(
  path: string,
  user: DbRow | null,
  env: ReturnType<typeof makeTestEnv>,
): Promise<Response> {
  const headers = new Headers();
  if (user !== null) {
    const token = await createToken(user.id as number, FIXED_SECRET);
    headers.set("Authorization", "Bearer " + token);
  }
  return app.request(path, { headers }, env);
}

function providerRow(overrides: DbRow = {}): DbRow {
  return {
    id: 1, tenant_id: "default", provider: "deepseek",
    api_key: "sk-1234567890abcdef", model: "deepseek-chat-custom",
    base_url: "https://api.deepseek.com/v1", enabled: true,
    created_at: new Date(NOW), updated_at: new Date(NOW), ...overrides,
  };
}

function usageRow(overrides: DbRow = {}): DbRow {
  return {
    id: "101", task_key: "lead_scoring", provider: "deepseek", model: "deepseek-chat",
    prompt_tokens: 120, completion_tokens: "45", cost_usd: "0.001234",
    status: "success", error: null, latency_ms: 850,
    created_at: new Date("2026-10-24T07:00:00Z"), ...overrides,
  };
}

type StubOptions = {
  user?: DbRow;
  providers?: DbRow[];
  total?: DbRow[];
  usage?: DbRow[];
  stats?: DbRow[];
};

function dbStub(options: StubOptions): (query: string) => DbRow[] {
  return (query: string): DbRow[] => {
    if (query.includes("FROM users WHERE id")) return options.user ? [options.user] : [];
    if (query.includes("FROM ai_providers")) return options.providers ?? [];
    if (query.includes("GROUP BY task_key, provider, status")) return options.stats ?? [];
    if (query.includes("COUNT(*) FROM ai_usage")) return options.total ?? [{ count: "0" }];
    if (query.includes("FROM ai_usage")) return options.usage ?? [];
    return [];
  };
}

beforeEach(() => {
  resetDb(() => []);
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/v1/ai/providers（chain.py:583-596）
// ══════════════════════════════════════════════════════════════════════════════

describe("GET /api/v1/ai/providers（P3 直连）", () => {
  it("开关 on：8 键投影 + PROVIDER_DEFAULTS 顺序 + 不存在的 provider 用默认值", async () => {
    resetDb(dbStub({ user: AI_ADMIN, providers: [providerRow()] }));
    const spy = onEnv();

    const res = await request("/api/v1/ai/providers", AI_ADMIN, spy.env);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      items: [
        {
          provider: "deepseek",
          api_key_masked: "sk-1****cdef",
          has_key: true,
          model: "deepseek-chat-custom",
          base_url: "https://api.deepseek.com/v1",
          enabled: true,
          default_model: "deepseek-chat",
          default_base_url: "https://api.deepseek.com/v1",
        },
        {
          provider: "kimi",
          api_key_masked: null,
          has_key: false,
          model: null,
          base_url: null,
          enabled: false,
          default_model: "kimi-k2-0905-preview",
          default_base_url: "https://api.moonshot.cn/v1",
        },
        {
          provider: "zhipu",
          api_key_masked: null,
          has_key: false,
          model: null,
          base_url: null,
          enabled: false,
          default_model: "glm-4",
          default_base_url: "https://open.bigmodel.cn/api/paas/v4",
        },
      ],
    });
    const call = dbCallsContaining("FROM ai_providers")[0]!;
    expect(call.query).toBe("SELECT * FROM ai_providers WHERE tenant_id=$1");
    expect(call.params).toEqual(["default"]);
    expect(spy.fetch).not.toHaveBeenCalled();
  });

  it("非平台运营（internal + 普通角色）→ 403 Platform operator required（不打 DB）", async () => {
    resetDb(dbStub({ user: userRow() }));
    const spy = onEnv();

    const res = await request("/api/v1/ai/providers", userRow(), spy.env);

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      detail: { error: "forbidden", message: "Platform operator required" },
    });
    expect(dbCallsContaining("FROM ai_providers")).toHaveLength(0);
    expect(spy.fetch).not.toHaveBeenCalled();
  });

  it("开关 off（默认）：原样透传", async () => {
    const spy = kernelSpy();

    const res = await request("/api/v1/ai/providers", AI_ADMIN, spy.env);

    expect(res.status).toBe(200);
    expect(spy.seen).toEqual([{ method: "GET", path: "/api/v1/ai/providers", search: "" }]);
    expect(dbState.calls).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/v1/ai/usage（chain.py:710-747）
// ══════════════════════════════════════════════════════════════════════════════

describe("GET /api/v1/ai/usage（P3 直连）", () => {
  it("开关 on：分页 + 行投影 + stats 聚合 + SQL/参数逐字", async () => {
    resetDb(dbStub({
      user: AI_ADMIN,
      total: [{ count: "3" }],
      usage: [usageRow(), usageRow({ id: "100", status: "failed", error: "boom", cost_usd: null })],
      stats: [
        { task_key: "lead_scoring", provider: "deepseek", status: "success", cnt: "2", prompt_tokens: "240", completion_tokens: "90" },
        { task_key: "opening_line", provider: "kimi", status: "template_only", cnt: "1", prompt_tokens: "0", completion_tokens: "0" },
      ],
    }));
    const spy = onEnv();

    const res = await request("/api/v1/ai/usage", AI_ADMIN, spy.env);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      items: [
        {
          id: 101, task_key: "lead_scoring", provider: "deepseek", model: "deepseek-chat",
          prompt_tokens: 120, completion_tokens: 45, cost_usd: 0.001234,
          status: "success", error: null, latency_ms: 850,
          created_at: "2026-10-24T07:00:00.000+00:00",
        },
        {
          id: 100, task_key: "lead_scoring", provider: "deepseek", model: "deepseek-chat",
          prompt_tokens: 120, completion_tokens: 45, cost_usd: null,
          status: "failed", error: "boom", latency_ms: 850,
          created_at: "2026-10-24T07:00:00.000+00:00",
        },
      ],
      total: 3,
      page: 1,
      page_size: 20,
      stats: [
        { task_key: "lead_scoring", provider: "deepseek", status: "success", count: 2, prompt_tokens: 240, completion_tokens: 90 },
        { task_key: "opening_line", provider: "kimi", status: "template_only", count: 1, prompt_tokens: 0, completion_tokens: 0 },
      ],
    });
    const count = dbCallsContaining("COUNT(*) FROM ai_usage")[0]!;
    expect(count.query).toBe("SELECT COUNT(*) FROM ai_usage WHERE tenant_id = $1");
    expect(count.params).toEqual(["default"]);
    const page = dbCallsContaining("ORDER BY created_at DESC LIMIT")[0]!;
    expect(page.query).toBe(
      "SELECT id, task_key, provider, model, prompt_tokens, completion_tokens,"
      + " cost_usd, status, error, latency_ms, created_at"
      + " FROM ai_usage WHERE tenant_id = $1"
      + " ORDER BY created_at DESC LIMIT $2 OFFSET $3",
    );
    expect(page.params).toEqual(["default", 20, 0]);
    // stats 与筛选无关（内核也只按 tenant 过滤）
    const stats = dbCallsContaining("GROUP BY task_key, provider, status")[0]!;
    expect(stats.params).toEqual(["default"]);
    expect(spy.fetch).not.toHaveBeenCalled();
  });

  it("筛选与分页：参数顺序 task_key → provider → status，LIMIT/OFFSET 顺延；空串不算筛", async () => {
    resetDb(dbStub({ user: AI_ADMIN, total: [{ count: "0" }] }));
    const spy = onEnv();

    await request(
      "/api/v1/ai/usage?task_key=lead_scoring&provider=deepseek&status=failed&page=2&page_size=5",
      AI_ADMIN, spy.env,
    );

    const page = dbCallsContaining("ORDER BY created_at DESC LIMIT")[0]!;
    expect(page.query).toBe(
      "SELECT id, task_key, provider, model, prompt_tokens, completion_tokens,"
      + " cost_usd, status, error, latency_ms, created_at"
      + " FROM ai_usage WHERE tenant_id = $1 AND task_key = $2 AND provider = $3 AND status = $4"
      + " ORDER BY created_at DESC LIMIT $5 OFFSET $6",
    );
    expect(page.params).toEqual(["default", "lead_scoring", "deepseek", "failed", 5, 5]);

    resetDb(dbStub({ user: AI_ADMIN, total: [{ count: "0" }] }));
    await request("/api/v1/ai/usage?status=", AI_ADMIN, spy.env);
    const empty = dbCallsContaining("ORDER BY created_at DESC LIMIT")[0]!;
    expect(empty.query).not.toContain("status = $");
    expect(empty.params).toEqual(["default", 20, 0]);
    expect(spy.fetch).not.toHaveBeenCalled();
  });

  it("page<1 / page_size 越界或非整数 → 422（不查库）", async () => {
    resetDb(dbStub({ user: AI_ADMIN }));
    const spy = onEnv();

    expect((await request("/api/v1/ai/usage?page=0", AI_ADMIN, spy.env)).status).toBe(422);
    expect((await request("/api/v1/ai/usage?page_size=0", AI_ADMIN, spy.env)).status).toBe(422);
    expect((await request("/api/v1/ai/usage?page_size=201", AI_ADMIN, spy.env)).status).toBe(422);
    expect((await request("/api/v1/ai/usage?page=abc", AI_ADMIN, spy.env)).status).toBe(422);
    expect(dbCallsContaining("FROM ai_usage")).toHaveLength(0);
    expect(spy.fetch).not.toHaveBeenCalled();
  });

  it("非平台运营 → 403（不打 DB）", async () => {
    resetDb(dbStub({ user: userRow() }));
    const spy = onEnv();

    const res = await request("/api/v1/ai/usage", userRow(), spy.env);

    expect(res.status).toBe(403);
    expect(dbCallsContaining("FROM ai_usage")).toHaveLength(0);
  });

  it("开关 off（默认）：原样透传（query 逐字）", async () => {
    const spy = kernelSpy();

    const res = await request("/api/v1/ai/usage?task_key=lead_scoring&page=2", AI_ADMIN, spy.env);

    expect(res.status).toBe(200);
    expect(spy.seen).toEqual([
      { method: "GET", path: "/api/v1/ai/usage", search: "?task_key=lead_scoring&page=2" },
    ]);
    expect(dbState.calls).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 共享小助手 / 401 / DB 失败
// ══════════════════════════════════════════════════════════════════════════════

describe("maskApiKey（chain.py:92-95 _mask 逐字）", () => {
  it("空 → null；≤8 位 → ****；更长 → 首4+****+尾4", () => {
    expect(maskApiKey(null)).toBeNull();
    expect(maskApiKey("")).toBeNull();
    expect(maskApiKey("short")).toBe("****");
    expect(maskApiKey("12345678")).toBe("****");
    expect(maskApiKey("123456789")).toBe("1234****6789");
  });
});

describe("401：开关 on 时未鉴权不触达 DB / 内核", () => {
  for (const path of ["/api/v1/ai/providers", "/api/v1/ai/usage"]) {
    it(`${path} 无 token → 401 Authentication required`, async () => {
      const spy = onEnv();

      const res = await request(path, null, spy.env);

      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({
        detail: { error: "unauthorized", message: "Authentication required" },
      });
      expect(dbState.calls).toHaveLength(0);
      expect(spy.fetch).not.toHaveBeenCalled();
    });
  }
});

describe("TS-DB 失败 → 503 db_unavailable", () => {
  for (const path of ["/api/v1/ai/providers", "/api/v1/ai/usage"]) {
    it(`${path}：查询抛错 → 503`, async () => {
      resetDb((query) => {
        if (query.includes("FROM users WHERE id")) return [AI_ADMIN];
        throw new Error("hyperdrive down");
      });
      const spy = onEnv();

      const res = await request(path, AI_ADMIN, spy.env);

      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({
        error: "db_unavailable",
        message: DB_UNAVAILABLE_MESSAGE,
        status: 503,
        retryable: true,
      });
      expect(spy.fetch).not.toHaveBeenCalled();
    });
  }
});
