// tax-archives 写路径（POST/PATCH/DELETE）门面直连 —— P2 §9 #4 前置。
//
// 测的是子应用（src/routes/tax-rates-write.ts），接线（index.ts mount / boot-flag）由 Lead 做，
// 所以这里自建 Hono 实例挂载它，不依赖主 app 的注册顺序。
//
// 真源：backend/worker/src/tax_archives.py:218/248/295；
// 纯校验唯一真源：backend/kaas_common/workstation/tax_archive_rules.py
// （内核侧对应测试：backend/worker/tests/test_tax_archive_write.py —— 两侧断言同一批错误码/文案）。
//
// 覆盖：on 直连（201/200/软删）/ off 逐字透传 / 422·409·403 错误码与文案逐字 /
//       团队闸门与跨团队 404 / 401 不打 DB+内核 / DB 失败 503。
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../src/env";
import { DB_UNAVAILABLE_MESSAGE } from "../src/hot-read";
import taxRatesWriteRoutes, {
  cleanTaxValues,
  normalizeCode,
  normalizeName,
  parseEffectiveDate,
  validateStatus,
} from "../src/routes/tax-rates-write";
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
app.route("/", taxRatesWriteRoutes);

// ── 脚手架（与 p0-hot-reads / misc-read 同一套）───────────────────────────────

function userRow(overrides: Partial<DbRow> = {}): DbRow {
  return {
    id: 9,
    email: "staff@qa.test",
    display_name: "Staff",
    account_type: "internal",
    role: "user",
    status: "active",
    team_id: 4,
    console_access: true,
    plan: "free",
    is_tenant_admin: false,
    ...overrides,
  };
}
const ADMIN_ROW: DbRow = { role: "system_admin", is_tenant_admin: true };
const NOW = new Date("2026-10-24T08:00:00Z");

function kernelSpy(flag: Record<string, unknown> = {}): {
  seen: Array<{ method: string; path: string; search: string }>;
  fetch: ReturnType<typeof vi.fn>;
  env: ReturnType<typeof makeTestEnv>;
} {
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
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (user !== null) {
    const token = await createToken(user.id as number, FIXED_SECRET);
    headers.set("Authorization", "Bearer " + token);
  }
  return app.request(path, { ...init, headers }, env);
}

function jsonInit(method: string, body: unknown): RequestInit {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

const INSERT_SQL =
  "INSERT INTO tax_archives"
  + " (tenant_id, team_id, code, name, effective_from, effective_to,"
  + "  tax_values, source, status, created_by)"
  + " VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,'active',$9)"
  + " RETURNING *";
const UPDATE_SQL =
  "UPDATE tax_archives SET name=$3, code=$4, effective_from=$5,"
  + " effective_to=$6, tax_values=$7::jsonb, source=$8, status=$9,"
  + " updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *";
const SOFT_DELETE_SQL =
  "UPDATE tax_archives SET status='inactive', updated_at=now()"
  + " WHERE tenant_id=$1 AND id=$2";

function archiveRow(overrides: DbRow = {}): DbRow {
  return {
    id: 7, tenant_id: "default", team_id: 4, code: "TAX-1", name: "默认税档",
    effective_from: new Date("2026-01-01T00:00:00Z"), effective_to: null,
    tax_values: { output_vat_rate: 0.13 }, source: "manual", status: "active",
    created_at: NOW, updated_at: NOW, ...overrides,
  };
}

type StubOptions = {
  user?: DbRow;
  teamCreatedBy?: number;
  archive?: DbRow | null;
  taken?: string[];
  inserted?: DbRow;
  updated?: DbRow;
};

function dbStub(options: StubOptions): (query: string) => DbRow[] {
  return (query: string, params: unknown[] = []): DbRow[] => {
    if (query.includes("FROM users WHERE id")) return options.user ? [options.user] : [];
    if (query.includes("created_by FROM teams WHERE id")) {
      return [{ created_by: options.teamCreatedBy ?? 9 }];
    }
    if (query.includes("SELECT 1 FROM tax_archives")) {
      const value = params[2];
      return (options.taken ?? []).includes(String(value)) ? [{ "?column?": 1 }] : [];
    }
    if (query.includes("SELECT * FROM tax_archives")) {
      const archive = options.archive === undefined ? archiveRow() : options.archive;
      if (!archive) return [];
      // 复刻 _archive_or_404 的团队过滤（!= 本团队 ⇒ 查不到）
      if (query.includes("AND team_id=$3") && Number(params[2]) !== Number(archive.team_id)) {
        return [];
      }
      return [archive];
    }
    if (query.includes("INSERT INTO tax_archives")) {
      return [options.inserted ?? archiveRow({ id: 99, code: String(params[2]), name: String(params[3]) })];
    }
    if (query.includes("UPDATE tax_archives SET name=")) {
      return [options.updated ?? archiveRow()];
    }
    if (query.includes("UPDATE tax_archives SET status='inactive'")) return [];
    return [];
  };
}

beforeEach(() => {
  resetDb(() => []);
});

// ══════════════════════════════════════════════════════════════════════════════
// 0. 共享纯校验的门面落点（与内核 test_tax_archive_write.py 断言同一批信封）
// ══════════════════════════════════════════════════════════════════════════════

describe("共享纯校验落点（parity 与 kaas_common/workstation/tax_archive_rules.py）", () => {
  it("名称/编码/状态/日期/税率的错误码与文案逐字一致", () => {
    expect(normalizeName("  默认税档  ")).toBe("默认税档");
    expect(() => normalizeName("   ")).toThrowError(/NAME_REQUIRED/);
    expect(normalizeCode("  TAX-1  ")).toBe("TAX-1");
    expect(normalizeCode("   ")).toBeNull();
    expect(validateStatus("inactive")).toBe("inactive");
    expect(() => validateStatus("archived")).toThrowError(/INVALID_STATUS/);
    expect(parseEffectiveDate("2026-10-01T00:00:00")).toBe("2026-10-01");
    expect(parseEffectiveDate(null)).toBeNull();
    expect(() => parseEffectiveDate("2026-13-40")).toThrowError(/INVALID_DATE/);
    expect(cleanTaxValues({ output_vat_rate: 0.13, misc_fee_rate: 0 })).toEqual({
      output_vat_rate: 0.13, misc_fee_rate: 0,
    });
    expect(() => cleanTaxValues({ output_vat_rate: 1.5 })).toThrowError(/INVALID_TAX_RATE/);
    expect(() => cleanTaxValues({})).toThrowError(/TAX_VALUES_REQUIRED/);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 1. POST /api/v1/tax-archives
// ══════════════════════════════════════════════════════════════════════════════

describe("POST /api/v1/tax-archives（P3 直连）", () => {
  const body = {
    name: "  默认税档  ", code: "TAX-2", effective_from: "2026-10-01",
    effective_to: null, tax_values: { output_vat_rate: 0.13 }, source: "manual",
  };

  it("开关 on：201 + _row_out 10 键 + INSERT 参数逐字 + 不经内核", async () => {
    resetDb(dbStub({ user: userRow(), inserted: archiveRow({ id: 99, name: "默认税档", code: "TAX-2" }) }));
    const spy = onEnv();

    const res = await request("/api/v1/tax-archives", userRow(), spy.env, jsonInit("POST", body));

    expect(res.status).toBe(201);
    const out = (await res.json()) as DbRow;
    expect(out.id).toBe(99);
    expect(out.name).toBe("默认税档");
    expect(out.code).toBe("TAX-2");
    expect(out.effective_from).toBe("2026-01-01");
    expect(out.status).toBe("active");
    // 团队闸门：非管理员先查 teams.created_by（is_team_admin 判定）
    const teamCall = dbCallsContaining("created_by FROM teams")[0]!;
    expect(teamCall.params).toEqual([4]);
    // 唯一性：name / code 各一条
    expect(dbCallsContaining("AND name=$3")[0]!.params).toEqual(["default", 4, "默认税档"]);
    expect(dbCallsContaining("AND code=$3")[0]!.params).toEqual(["default", 4, "TAX-2"]);
    const insert = dbCallsContaining("INSERT INTO tax_archives")[0]!;
    expect(insert.query).toBe(INSERT_SQL);
    expect(insert.params).toEqual([
      "default", 4, "TAX-2", "默认税档", "2026-10-01", null,
      '{"output_vat_rate":0.13}', "manual", "9",
    ]);
    expect(spy.fetch).not.toHaveBeenCalled();
  });

  it("管理员跳过 teams 查询（仅受租户约束）", async () => {
    resetDb(dbStub({ user: userRow(ADMIN_ROW) }));
    const spy = onEnv();

    const res = await request("/api/v1/tax-archives", userRow(ADMIN_ROW), spy.env, jsonInit("POST", body));

    expect(res.status).toBe(201);
    expect(dbCallsContaining("created_by FROM teams")).toHaveLength(0);
    expect(spy.fetch).not.toHaveBeenCalled();
  });

  it("名称空白 → 422 NAME_REQUIRED（文案逐字，不写库）", async () => {
    resetDb(dbStub({ user: userRow() }));
    const spy = onEnv();

    const res = await request("/api/v1/tax-archives", userRow(), spy.env,
      jsonInit("POST", { ...body, name: "   " }));

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      detail: { error: "validation", code: "NAME_REQUIRED", detail: "档案名称不能为空" },
    });
    expect(dbCallsContaining("INSERT INTO tax_archives")).toHaveLength(0);
    expect(spy.fetch).not.toHaveBeenCalled();
  });

  it("税率越界 → 422 INVALID_TAX_RATE（文案逐字）", async () => {
    resetDb(dbStub({ user: userRow() }));
    const spy = onEnv();

    const res = await request("/api/v1/tax-archives", userRow(), spy.env,
      jsonInit("POST", { ...body, tax_values: { misc_fee_rate: 2 } }));

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      detail: {
        error: "validation", code: "INVALID_TAX_RATE",
        detail: "misc_fee_rate 必须在 0~1 之间（10% 请填 0.1）",
      },
    });
    expect(dbCallsContaining("INSERT INTO tax_archives")).toHaveLength(0);
  });

  it("一项税率都没填 → 422 TAX_VALUES_REQUIRED", async () => {
    resetDb(dbStub({ user: userRow() }));
    const spy = onEnv();

    const res = await request("/api/v1/tax-archives", userRow(), spy.env,
      jsonInit("POST", { ...body, tax_values: {} }));

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      detail: {
        error: "validation", code: "TAX_VALUES_REQUIRED", detail: "至少填写一个税率项",
      },
    });
  });

  it("重名 → 409 NAME_TAKEN（文案逐字，不写库）", async () => {
    resetDb(dbStub({ user: userRow(), taken: ["默认税档"] }));
    const spy = onEnv();

    const res = await request("/api/v1/tax-archives", userRow(), spy.env, jsonInit("POST", body));

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      detail: {
        error: "conflict", code: "NAME_TAKEN",
        detail: "税务档案名称「默认税档」在本团队已存在",
      },
    });
    expect(dbCallsContaining("INSERT INTO tax_archives")).toHaveLength(0);
  });

  it("未给编码 → 自动取号 TAX-yyyyMMdd-i（跳过已占用的 -1）", async () => {
    const now = new Date();
    const base = "TAX-" + String(now.getFullYear())
      + String(now.getMonth() + 1).padStart(2, "0")
      + String(now.getDate()).padStart(2, "0");
    let insertCode: unknown;
    resetDb((query, params = []) => {
      if (query.includes("FROM users WHERE id")) return [userRow()];
      if (query.includes("created_by FROM teams WHERE id")) return [{ created_by: 9 }];
      if (query.includes("SELECT 1 FROM tax_archives")) {
        // 唯一性检查（name）不命中；取号时 base-1 已占用
        return params[2] === base + "-1" ? [{ "?column?": 1 }] : [];
      }
      if (query.includes("INSERT INTO tax_archives")) {
        insertCode = params[2];
        return [archiveRow({ id: 99, code: String(params[2]) })];
      }
      return [];
    });
    const spy = onEnv();

    const res = await request("/api/v1/tax-archives", userRow(), spy.env,
      jsonInit("POST", { ...body, code: null }));

    expect(res.status).toBe(201);
    expect(insertCode).toBe(base + "-2");
    expect(spy.fetch).not.toHaveBeenCalled();
  });

  it("日期非法 → 422 INVALID_DATE（文案逐字）", async () => {
    resetDb(dbStub({ user: userRow() }));
    const spy = onEnv();

    const res = await request("/api/v1/tax-archives", userRow(), spy.env,
      jsonInit("POST", { ...body, effective_from: "2026-13-40" }));

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      detail: {
        error: "validation", code: "INVALID_DATE",
        detail: "日期格式不合法：2026-13-40（应为 YYYY-MM-DD）",
      },
    });
  });

  it("无团队 → 403 TEAM_REQUIRED（不写库）", async () => {
    const user = userRow({ team_id: null });
    resetDb(dbStub({ user }));
    const spy = onEnv();

    const res = await request("/api/v1/tax-archives", user, spy.env, jsonInit("POST", body));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      detail: {
        error: "forbidden", code: "TEAM_REQUIRED",
        detail: "税务档案是团队级资源，当前账号没有团队",
      },
    });
    expect(dbCallsContaining("INSERT INTO tax_archives")).toHaveLength(0);
  });

  it("非团队管理员 → 403 TEAM_ADMIN_REQUIRED（内核同一文案）", async () => {
    resetDb(dbStub({ user: userRow(), teamCreatedBy: 777 }));
    const spy = onEnv();

    const res = await request("/api/v1/tax-archives", userRow(), spy.env, jsonInit("POST", body));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      detail: {
        error: "forbidden", code: "TEAM_ADMIN_REQUIRED",
        detail: "仅团队管理员可修改企业抬头/收款信息/公章",
      },
    });
    expect(dbCallsContaining("INSERT INTO tax_archives")).toHaveLength(0);
  });

  it("开关 off（默认）：原样透传（method/path/query）", async () => {
    const spy = kernelSpy();

    const res = await request("/api/v1/tax-archives", userRow(), spy.env, jsonInit("POST", body));

    expect(res.status).toBe(200);
    expect(spy.seen).toEqual([{ method: "POST", path: "/api/v1/tax-archives", search: "" }]);
    expect(dbState.calls).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 2. PATCH /api/v1/tax-archives/{id}
// ══════════════════════════════════════════════════════════════════════════════

describe("PATCH /api/v1/tax-archives/{id}（P3 直连）", () => {
  it("开关 on：只改给出的字段（合并语义）+ UPDATE 参数逐字 + 不经内核", async () => {
    resetDb(dbStub({
      user: userRow(),
      archive: archiveRow(),
      updated: archiveRow({ name: "新名字" }),
    }));
    const spy = onEnv();

    const res = await request("/api/v1/tax-archives/7", userRow(), spy.env,
      jsonInit("PATCH", { name: "  新名字  " }));

    expect(res.status).toBe(200);
    const out = (await res.json()) as DbRow;
    expect(out.name).toBe("新名字");
    expect(out.code).toBe("TAX-1");
    expect(out.effective_from).toBe("2026-01-01");
    // 定位查询带 team 过滤（跨团队档案查不到 ⇒ 404 不泄露）
    const load = dbCallsContaining("SELECT * FROM tax_archives")[0]!;
    expect(load.query).toBe(
      "SELECT * FROM tax_archives WHERE tenant_id=$1 AND id=$2 AND team_id=$3",
    );
    expect(load.params).toEqual(["default", 7, 4]);
    const update = dbCallsContaining("UPDATE tax_archives SET name=")[0]!;
    expect(update.query).toBe(UPDATE_SQL);
    expect(update.params).toEqual([
      "default", 7, "新名字", "TAX-1", new Date("2026-01-01T00:00:00Z"), null,
      '{"output_vat_rate":0.13}', "manual", "active",
    ]);
    // 唯一性排除自身
    const codeCheck = dbCallsContaining("AND code=$3")[0]!;
    expect(codeCheck.query).toBe(
      "SELECT 1 FROM tax_archives WHERE tenant_id=$1 AND team_id=$2 AND code=$3 AND id<>$4 LIMIT 1",
    );
    expect(codeCheck.params).toEqual(["default", 4, "TAX-1", 7]);
    expect(spy.fetch).not.toHaveBeenCalled();
  });

  it("不存在 → 404 TAX_ARCHIVE_NOT_FOUND（不写库）", async () => {
    resetDb(dbStub({ user: userRow(), archive: null }));
    const spy = onEnv();

    const res = await request("/api/v1/tax-archives/7", userRow(), spy.env,
      jsonInit("PATCH", { name: "x" }));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      detail: { error: "not_found", code: "TAX_ARCHIVE_NOT_FOUND" },
    });
    expect(dbCallsContaining("UPDATE tax_archives SET name=")).toHaveLength(0);
  });

  it("跨团队档案 → 404（团队过滤，不是 403 泄露存在性）", async () => {
    resetDb(dbStub({ user: userRow(), archive: archiveRow({ team_id: 8 }) }));
    const spy = onEnv();

    const res = await request("/api/v1/tax-archives/7", userRow(), spy.env,
      jsonInit("PATCH", { name: "x" }));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      detail: { error: "not_found", code: "TAX_ARCHIVE_NOT_FOUND" },
    });
    expect(dbCallsContaining("UPDATE tax_archives SET name=")).toHaveLength(0);
  });

  it("状态非法 → 422 INVALID_STATUS（不写库）", async () => {
    resetDb(dbStub({ user: userRow(), archive: archiveRow() }));
    const spy = onEnv();

    const res = await request("/api/v1/tax-archives/7", userRow(), spy.env,
      jsonInit("PATCH", { status: "archived" }));

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      detail: {
        error: "validation", code: "INVALID_STATUS",
        detail: "status 只能是 active / inactive",
      },
    });
    expect(dbCallsContaining("UPDATE tax_archives SET name=")).toHaveLength(0);
  });

  it("开关 off（默认）：原样透传", async () => {
    const spy = kernelSpy();

    const res = await request("/api/v1/tax-archives/7", userRow(), spy.env,
      jsonInit("PATCH", { name: "x" }));

    expect(res.status).toBe(200);
    expect(spy.seen).toEqual([
      { method: "PATCH", path: "/api/v1/tax-archives/7", search: "" },
    ]);
    expect(dbState.calls).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 3. DELETE /api/v1/tax-archives/{id}
// ══════════════════════════════════════════════════════════════════════════════

describe("DELETE /api/v1/tax-archives/{id}（P3 直连，软删）", () => {
  it("开关 on：200 {id,status:inactive} + 软删 SQL 参数逐字 + 不经内核", async () => {
    resetDb(dbStub({ user: userRow(), archive: archiveRow() }));
    const spy = onEnv();

    const res = await request("/api/v1/tax-archives/7", userRow(), spy.env, { method: "DELETE" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 7, status: "inactive" });
    const call = dbCallsContaining("UPDATE tax_archives SET status='inactive'")[0]!;
    expect(call.query).toBe(SOFT_DELETE_SQL);
    expect(call.params).toEqual(["default", 7]);
    expect(spy.fetch).not.toHaveBeenCalled();
  });

  it("不存在 → 404（不执行软删）", async () => {
    resetDb(dbStub({ user: userRow(), archive: null }));
    const spy = onEnv();

    const res = await request("/api/v1/tax-archives/7", userRow(), spy.env, { method: "DELETE" });

    expect(res.status).toBe(404);
    expect(dbCallsContaining("UPDATE tax_archives SET status='inactive'")).toHaveLength(0);
  });

  it("开关 off（默认）：原样透传", async () => {
    const spy = kernelSpy();

    const res = await request("/api/v1/tax-archives/7", userRow(), spy.env, { method: "DELETE" });

    expect(res.status).toBe(200);
    expect(spy.seen).toEqual([
      { method: "DELETE", path: "/api/v1/tax-archives/7", search: "" },
    ]);
    expect(dbState.calls).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 4. 401 / DB 失败
// ══════════════════════════════════════════════════════════════════════════════

describe("401：开关 on 时未鉴权不触达 DB / 内核", () => {
  const cases: Array<[string, string, RequestInit]> = [
    ["POST /api/v1/tax-archives", "/api/v1/tax-archives", jsonInit("POST", { name: "x", tax_values: { output_vat_rate: 0.1 } })],
    ["PATCH /api/v1/tax-archives/7", "/api/v1/tax-archives/7", jsonInit("PATCH", { name: "x" })],
    ["DELETE /api/v1/tax-archives/7", "/api/v1/tax-archives/7", { method: "DELETE" }],
  ];
  for (const [name, path, init] of cases) {
    it(`${name} 无 token → 401 Authentication required`, async () => {
      const spy = onEnv();

      const res = await request(path, null, spy.env, init);

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
  it("POST：写库抛错 → 503（不是 500、也不是 502 kernel_unavailable）", async () => {
    resetDb((query) => {
      if (query.includes("FROM users WHERE id")) return [userRow()];
      throw new Error("hyperdrive down");
    });
    const spy = onEnv();

    const res = await request("/api/v1/tax-archives", userRow(), spy.env,
      jsonInit("POST", { name: "x", tax_values: { output_vat_rate: 0.1 } }));

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: "db_unavailable",
      message: DB_UNAVAILABLE_MESSAGE,
      status: 503,
      retryable: true,
    });
    expect(spy.fetch).not.toHaveBeenCalled();
  });
});
