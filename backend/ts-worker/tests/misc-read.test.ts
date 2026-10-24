// P3 批次A（下一批只读）：fx-rates / external-docs / trade-docs 附件 三条只读 GET 门面直连。
//
// 本文件测的是**子应用**（src/routes/misc-read.ts）本身：接线（index.ts mount / boot-flag
// route id）由 Lead 统一做，所以这里自建一个 Hono 实例挂载该子应用，不依赖主 app 的注册顺序。
//
// 真源：backend/worker/src/ws_extras.py:163-177 / :363-390、backend/worker/src/ws_files.py:642-659。
// 列类型真源：orchestrator/app/db/{workstation_models,external_docs}.py。
//
// 覆盖口径（与 P0 / quotes-read 同一套）：
// - on ⇒ 200 且 env.KERNEL.fetch 0 次；SQL 文本/参数/排序逐字断言；
// - off（默认）⇒ 原样 forwardKernelRequest（method/path/query 逐字一致）；
// - 401 未鉴权不打 DB / 内核；DB 失败 ⇒ 503 {error:"db_unavailable"}；
// - 隔离口径**照抄内核**：fx_rates / external_doc_uploads 在内核里就是全局表（无 tenant/team 谓词），
//   trade-docs/{id}/files 走 _team_scope（非管理员无团队 403 NO_TEAM）。
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../src/env";
import { DB_UNAVAILABLE_MESSAGE } from "../src/hot-read";
import miscReadRoutes from "../src/routes/misc-read";
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

// 子应用独立测试实例（接线由 Lead 在主 app 里做）
const app = new Hono<{ Bindings: Env }>();
app.route("/", miscReadRoutes);

// ── 脚手架（与 tests/p0-hot-reads.test.ts 同一套）────────────────────────────

function userRow(overrides: Partial<DbRow> = {}): DbRow {
  return {
    id: 9,
    email: "staff@qa.test",
    display_name: "Staff",
    account_type: "internal",
    role: "sales",
    status: "active",
    team_id: 4,
    console_access: true,
    plan: "free",
    is_tenant_admin: false,
    ...overrides,
  };
}

const ADMIN_ROW: DbRow = { role: "admin", is_tenant_admin: true };

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
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  const env = makeTestEnv({ KERNEL: { fetch: fetch as never }, ...flag });
  return { seen, fetch, env };
}

function onEnv(flag: Record<string, unknown> = {}) {
  return kernelSpy({ AUTH_DB_SPLIT: "on", ...flag });
}

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

function iso(text: string): string {
  return new Date(text).toISOString().replace("Z", "+00:00");
}

function dbStub(rows: {
  user?: DbRow;
  fxRates?: DbRow[];
  externalDocs?: DbRow[];
  docFiles?: DbRow[];
}): (query: string) => DbRow[] {
  return (query: string): DbRow[] => {
    if (query.includes("FROM users WHERE id")) return rows.user ? [rows.user] : [];
    if (query.includes("FROM fx_rates")) return rows.fxRates ?? [];
    if (query.includes("FROM external_doc_uploads")) return rows.externalDocs ?? [];
    if (query.includes("FROM trade_doc_files")) return rows.docFiles ?? [];
    return [];
  };
}

beforeEach(() => {
  resetDb(() => []);
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/v1/fx-rates（ws_extras.py:163-177）
// ══════════════════════════════════════════════════════════════════════════════

describe("GET /api/v1/fx-rates（P3 直连）", () => {
  const FX_ROW: DbRow = {
    id: "101",
    base_currency: "USD",
    quote_currency: "CNY",
    rate: "7.12340000",
    rate_date: new Date("2026-10-01T00:00:00Z"),
    source: "open.er-api.com",
    is_stale: false,
    fetched_at: new Date("2026-10-01T08:00:00Z"),
  };

  it("开关 on：200 + 裸数组 6 键投影（rate 数、rate_date 只出日期）+ 不经内核", async () => {
    resetDb(dbStub({ user: userRow(), fxRates: [FX_ROW] }));
    const spy = onEnv();

    const res = await request("/api/v1/fx-rates", userRow(), spy.env);

    expect(res.status).toBe(200);
    // 内核返回的就是数组本身（不是 {items,total}）
    expect(await res.json()).toEqual([
      {
        base_currency: "USD",
        quote_currency: "CNY",
        rate: 7.1234,
        rate_date: "2026-10-01",
        source: "open.er-api.com",
        is_stale: false,
      },
    ]);
    // SQL 逐字 + limit 夹取后作 $3 传参
    const call = dbCallsContaining("FROM fx_rates")[0]!;
    expect(call.query).toBe(
      "SELECT * FROM fx_rates WHERE base_currency=$1 AND quote_currency=$2"
      + " ORDER BY rate_date DESC LIMIT $3",
    );
    expect(call.params).toEqual(["USD", "CNY", 30]);
    expect(spy.fetch).not.toHaveBeenCalled();
  });

  it("查询参数：base/quote 覆盖 + limit 夹取 [1,365]（0→1、1000→365）+ 非整数 422", async () => {
    resetDb(dbStub({ user: userRow() }));
    const spy = onEnv();

    await request("/api/v1/fx-rates?base_currency=EUR&quote_currency=USD&limit=0", userRow(), spy.env);
    expect(dbCallsContaining("FROM fx_rates")[0]!.params).toEqual(["EUR", "USD", 1]);

    resetDb(dbStub({ user: userRow() }));
    await request("/api/v1/fx-rates?limit=1000", userRow(), spy.env);
    expect(dbCallsContaining("FROM fx_rates")[0]!.params).toEqual(["USD", "CNY", 365]);

    resetDb(dbStub({ user: userRow() }));
    const bad = await request("/api/v1/fx-rates?limit=abc", userRow(), spy.env);
    expect(bad.status).toBe(422);
    expect(dbCallsContaining("FROM fx_rates")).toHaveLength(0);
    expect(spy.fetch).not.toHaveBeenCalled();
  });

  it("开关 off（默认）：原样透传（query 逐字）", async () => {
    resetDb(dbStub({ user: userRow() }));
    const spy = kernelSpy();

    const res = await request("/api/v1/fx-rates?base_currency=EUR&quote_currency=USD&limit=5", userRow(), spy.env);

    expect(res.status).toBe(200);
    expect(spy.seen).toEqual([
      { method: "GET", path: "/api/v1/fx-rates", search: "?base_currency=EUR&quote_currency=USD&limit=5" },
    ]);
  });

  it("开关 off 且无 token：保持今天的「交给内核裁决」（门面不新增 401）", async () => {
    const spy = kernelSpy();

    const res = await request("/api/v1/fx-rates", null, spy.env);

    expect(res.status).toBe(200);
    expect(spy.seen).toHaveLength(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/v1/external-docs（ws_extras.py:363-390）
//
// 2026-10-24 安全修复：本轮之前内核 `WHERE 1=1`（连 tenant 都不过滤）。现在两边同一条尺：
// tenant 恒在 + 行级可见性（管理员放行；否则 uploaded_by=我 或 挂载对象属本团队；无团队只剩
// uploaded_by）。**parity 锁**：本文件的 DOC_MATRIX / EXPECTED_VISIBLE 与
// backend/worker/tests/test_external_docs_scope.py 的 ROWS / EXPECTED **逐行一致**，
// 两侧各自断言自己发出的 SQL 与参数等于同一份 canonical 形状。
// ══════════════════════════════════════════════════════════════════════════════

const LIST_SELECT =
  "SELECT id, doc_type, file_name, content_type, file_size, order_id,"
  + " quote_order_id, inquiry_id, customer_id, status, notes, uploaded_by, created_at"
  + " FROM external_doc_uploads WHERE 1=1";
const LIST_SCOPE =
  " AND (uploaded_by = $2::text"
  + " OR order_id IN (SELECT id FROM orders WHERE tenant_id = $1 AND team_id = $3)"
  + " OR quote_order_id IN (SELECT id FROM quote_orders WHERE tenant_id = $1 AND team_id = $4)"
  + " OR inquiry_id IN (SELECT id FROM cust_inquiries WHERE tenant_id = $1 AND team_id = $5))";
const LIST_TAIL = " ORDER BY created_at DESC LIMIT ";

// ── 构造数据矩阵（与 backend/worker/tests/test_external_docs_scope.py:ROWS 逐行一致）──
const ORDER_TEAM: Record<number, number> = { 31: 4, 32: 8 };
const QUOTE_TEAM: Record<number, number> = { 41: 4, 42: 8 };
const INQUIRY_TEAM: Record<number, number> = { 51: 4, 52: 8 };
const DOC_MATRIX = [
  { id: 1, tenant_id: "default", uploaded_by: "9", order_id: null, quote_order_id: null, inquiry_id: null },
  { id: 2, tenant_id: "default", uploaded_by: "12", order_id: 32, quote_order_id: null, inquiry_id: null },
  { id: 3, tenant_id: "default", uploaded_by: "12", order_id: 31, quote_order_id: null, inquiry_id: null },
  { id: 4, tenant_id: "default", uploaded_by: "12", order_id: null, quote_order_id: 41, inquiry_id: null },
  { id: 5, tenant_id: "default", uploaded_by: "12", order_id: null, quote_order_id: null, inquiry_id: 51 },
  { id: 6, tenant_id: "default", uploaded_by: "12", order_id: null, quote_order_id: null, inquiry_id: null },
  { id: 7, tenant_id: "other", uploaded_by: "9", order_id: null, quote_order_id: null, inquiry_id: null },
];
// 与内核测试 EXPECTED 完全相同的期望可见集合
const EXPECTED_VISIBLE: Record<string, number[]> = {
  admin: [1, 2, 3, 4, 5, 6],
  member: [1, 3, 4, 5],
  other: [2],
  no_team: [],
};

/** 参照实现（只用于行为断言；真正的守卫是 SQL/参数逐字断言）。 */
function simulateVisible(input: {
  isAdmin: boolean;
  uid?: string;
  team?: number | null;
  tenant?: string;
}): number[] {
  const tenant = input.tenant ?? "default";
  const teamOf = (id: number | null, map: Record<number, number>): number | null =>
    id === null ? null : map[id] ?? null;
  return DOC_MATRIX.filter((row) => {
    if (row.tenant_id !== tenant) return false;
    if (input.isAdmin) return true;
    if (String(row.uploaded_by) === String(input.uid)) return true;
    const team = input.team;
    if (team === null || team === undefined) return false;
    return teamOf(row.order_id, ORDER_TEAM) === team
      || teamOf(row.quote_order_id, QUOTE_TEAM) === team
      || teamOf(row.inquiry_id, INQUIRY_TEAM) === team;
  }).map((row) => row.id);
}

describe("GET /api/v1/external-docs（P3 直连）", () => {
  const DOC_ROW: DbRow = {
    id: "201",
    doc_type: "pi",
    file_name: "supplier-PI.pdf",
    content_type: "application/pdf",
    file_size: "20480",
    order_id: "31",
    quote_order_id: null,
    inquiry_id: null,
    customer_id: "C-9",
    status: "draft",
    notes: null,
    uploaded_by: "9",
    created_at: new Date("2026-10-01T03:04:05Z"),
  };

  it("开关 on：200 + 裸数组 13 键投影（file_size 数、created_at iso）+ 不经内核", async () => {
    resetDb(dbStub({ user: userRow(), externalDocs: [DOC_ROW] }));
    const spy = onEnv();

    const res = await request("/api/v1/external-docs", userRow(), spy.env);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      {
        id: 201,
        doc_type: "pi",
        file_name: "supplier-PI.pdf",
        content_type: "application/pdf",
        file_size: 20480,
        order_id: 31,
        quote_order_id: null,
        inquiry_id: null,
        customer_id: "C-9",
        status: "draft",
        notes: null,
        uploaded_by: "9",
        created_at: iso("2026-10-01T03:04:05Z"),
      },
    ]);
    const call = dbCallsContaining("FROM external_doc_uploads")[0]!;
    // 修复后：tenant 恒在 + 行级可见性谓词（member id 9 / team 4）⇒ LIMIT 落到 $6
    expect(call.query).toBe(LIST_SELECT + " AND tenant_id=$1" + LIST_SCOPE + LIST_TAIL + "$6");
    expect(call.params).toEqual(["default", "9", 4, 4, 4, 50]);
    expect(spy.fetch).not.toHaveBeenCalled();
  });

  it("筛选：order_id→$1、doc_type→$2、limit 作末参；order_id=0 也算筛（内核 is not None 口径）", async () => {
    resetDb(dbStub({ user: userRow() }));
    const spy = onEnv();

    await request("/api/v1/external-docs?order_id=7&doc_type=pi&limit=10", userRow(), spy.env);
    const filtered = dbCallsContaining("FROM external_doc_uploads")[0]!;
    expect(filtered.query).toBe(LIST_SELECT + " AND tenant_id=$1" + LIST_SCOPE
      + " AND order_id=$6 AND doc_type=$7" + LIST_TAIL + "$8");
    expect(filtered.params).toEqual(["default", "9", 4, 4, 4, 7, "pi", 10]);

    resetDb(dbStub({ user: userRow() }));
    await request("/api/v1/external-docs?order_id=0", userRow(), spy.env);
    const zero = dbCallsContaining("FROM external_doc_uploads")[0]!;
    // order_id=0 在 Python 是 is not None ⇒ 照样进谓词（不能当假值丢掉）
    expect(zero.query).toContain(" AND order_id=$6");
    expect(zero.params).toEqual(["default", "9", 4, 4, 4, 0, 50]);
    expect(spy.fetch).not.toHaveBeenCalled();
  });

  it("limit 越界（ge=1/le=500）→ 422；空 order_id → 422（FastAPI int 解析）", async () => {
    resetDb(dbStub({ user: userRow() }));
    const spy = onEnv();

    expect((await request("/api/v1/external-docs?limit=0", userRow(), spy.env)).status).toBe(422);
    expect((await request("/api/v1/external-docs?limit=501", userRow(), spy.env)).status).toBe(422);
    expect((await request("/api/v1/external-docs?order_id=", userRow(), spy.env)).status).toBe(422);
    expect(dbCallsContaining("FROM external_doc_uploads")).toHaveLength(0);
    expect(spy.fetch).not.toHaveBeenCalled();
  });

  it("开关 off（默认）：原样透传（query 逐字）", async () => {
    resetDb(dbStub({ user: userRow() }));
    const spy = kernelSpy();

    const res = await request("/api/v1/external-docs?order_id=7&limit=10", userRow(), spy.env);

    expect(res.status).toBe(200);
    expect(spy.seen).toEqual([
      { method: "GET", path: "/api/v1/external-docs", search: "?order_id=7&limit=10" },
    ]);
  });

  it("管理员：只受 tenant 约束（不加行级谓词）", async () => {
    resetDb(dbStub({ user: userRow(ADMIN_ROW) }));
    const spy = onEnv();

    await request("/api/v1/external-docs", userRow(ADMIN_ROW), spy.env);

    const call = dbCallsContaining("FROM external_doc_uploads")[0]!;
    expect(call.query).toBe(LIST_SELECT + " AND tenant_id=$1" + LIST_TAIL + "$2");
    expect(call.params).toEqual(["default", 50]);
    // 注意：SELECT 列清单里本来就有 uploaded_by（元数据列），断言的是 WHERE 里没有谓词
    expect(call.query).not.toContain("uploaded_by = $");
    expect(spy.fetch).not.toHaveBeenCalled();
  });

  it("无团队的非管理员：只剩 uploaded_by（未挂载/非本人上传的件不可见）", async () => {
    const user = userRow({ id: 11, team_id: null });
    resetDb(dbStub({ user }));
    const spy = onEnv();

    await request("/api/v1/external-docs", user, spy.env);

    const call = dbCallsContaining("FROM external_doc_uploads")[0]!;
    expect(call.query).toBe(LIST_SELECT + " AND tenant_id=$1"
      + " AND (uploaded_by = $2::text)" + LIST_TAIL + "$3");
    expect(call.query).not.toContain("team_id = $");
    expect(call.params).toEqual(["default", "11", 50]);
    expect(spy.fetch).not.toHaveBeenCalled();
  });

  it("别团队成员（id 10 / team 8）：谓词参数换成该身份与本团队", async () => {
    const user = userRow({ id: 10, team_id: 8 });
    resetDb(dbStub({ user }));
    const spy = onEnv();

    await request("/api/v1/external-docs", user, spy.env);

    const call = dbCallsContaining("FROM external_doc_uploads")[0]!;
    expect(call.query).toBe(LIST_SELECT + " AND tenant_id=$1" + LIST_SCOPE + LIST_TAIL + "$6");
    expect(call.params).toEqual(["default", "10", 8, 8, 8, 50]);
    expect(spy.fetch).not.toHaveBeenCalled();
  });

  it("parity 矩阵：与内核测试同一份构造数据 ⇒ 同一份可见集合", async () => {
    // 从**实际发出的参数**里解出谓词用到的身份/团队（位置是 canonical 的），再求值：
    // 任何一侧把 uid/team 写错、或谓词位置漂移，这里都会与 EXPECTED_VISIBLE 不符。
    const cases = [
      { key: "admin", user: userRow(ADMIN_ROW), isAdmin: true },
      { key: "member", user: userRow(), isAdmin: false },
      { key: "other", user: userRow({ id: 10, team_id: 8 }), isAdmin: false },
      { key: "no_team", user: userRow({ id: 11, team_id: null }), isAdmin: false },
    ];
    for (const item of cases) {
      resetDb(dbStub({ user: item.user }));
      const spy = onEnv();
      await request("/api/v1/external-docs", item.user, spy.env);
      const call = dbCallsContaining("FROM external_doc_uploads")[0]!;
      const params = call.params as unknown[];
      const uid = item.isAdmin ? undefined : String(params[1]);
      const team = !item.isAdmin && call.query.includes("team_id = $")
        ? Number(params[2])
        : null;
      expect(simulateVisible({ isAdmin: item.isAdmin, uid, team })).toEqual(
        EXPECTED_VISIBLE[item.key],
      );
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/v1/trade-docs/{doc_id}/files（ws_files.py:642-659）
// ══════════════════════════════════════════════════════════════════════════════

describe("GET /api/v1/trade-docs/{id}/files（P3 直连）", () => {
  const LINK_ROW: DbRow = {
    link_id: "31",
    link_role: "stamp_scan",
    link_caption: "盖章件",
    link_sort_order: 2,
    id: "41",
    tenant_id: "default",
    team_id: "4",
    owner_type: "trade_doc",
    owner_id: "12",
    kind: "doc_attachment",
    media_kind: null,
    name: "seal.pdf",
    storage: "r2",
    object_key: "k/41.pdf",
    file_name: "seal.pdf",
    content_type: "application/pdf",
    file_size: "1024",
    sha256: "abc123",
    version: "1",
    supersedes_id: null,
    is_current: true,
    is_primary: false,
    // 文件自身的 sort_order 是 7、链接位次是 2 ⇒ 最终以链接位次覆盖（Python item.update 口径）
    sort_order: 7,
    uploaded_by: "9",
    created_at: new Date("2026-10-01T03:04:05Z"),
  };

  it("开关 on（成员）：200 + 文件投影 + link 四键 + 团队谓词 + 不经内核", async () => {
    resetDb(dbStub({ user: userRow(), docFiles: [LINK_ROW] }));
    const spy = onEnv();

    const res = await request("/api/v1/trade-docs/12/files", userRow(), spy.env);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      items: [
        {
          id: 41,
          tenant_id: "default",
          team_id: 4,
          owner_type: "trade_doc",
          owner_id: "12",
          kind: "doc_attachment",
          media_kind: null,
          name: "seal.pdf",
          storage: "r2",
          object_key: "k/41.pdf",
          file_name: "seal.pdf",
          content_type: "application/pdf",
          file_size: 1024,
          sha256: "abc123",
          version: 1,
          supersedes_id: null,
          is_current: true,
          is_primary: false,
          sort_order: 2,
          uploaded_by: "9",
          created_at: iso("2026-10-01T03:04:05Z"),
          link_id: 31,
          role: "stamp_scan",
          caption: "盖章件",
        },
      ],
    });
    // SQL 逐字：链接列在前 + f.* 元数据（= _META_COLS 的 f. 前缀版）+ 团队谓词从 $3 起
    const call = dbCallsContaining("FROM trade_doc_files")[0]!;
    expect(call.query).toBe(
      "SELECT t.id AS link_id, t.role AS link_role, t.caption AS link_caption,"
      + " t.sort_order AS link_sort_order, f.id, f.tenant_id, f.team_id, f.owner_type,"
      + " f.owner_id, f.kind, f.media_kind, f.name, f.storage, f.object_key, f.file_name,"
      + " f.content_type, f.file_size, f.sha256, f.version, f.supersedes_id, f.is_current,"
      + " f.is_primary, f.sort_order, f.uploaded_by, f.created_at"
      + " FROM trade_doc_files t JOIN file_objects f ON f.id = t.file_id"
      + " WHERE t.tenant_id=$1 AND t.trade_doc_id=$2 AND f.team_id=$3"
      + " ORDER BY t.sort_order, t.id",
    );
    expect(call.params).toEqual(["default", 12, 4]);
    expect(spy.fetch).not.toHaveBeenCalled();
  });

  it("管理员：不加团队谓词（tenant/doc 仍恒在）", async () => {
    resetDb(dbStub({ user: userRow(ADMIN_ROW) }));
    const spy = onEnv();

    const res = await request("/api/v1/trade-docs/12/files", userRow(ADMIN_ROW), spy.env);

    expect(res.status).toBe(200);
    const call = dbCallsContaining("FROM trade_doc_files")[0]!;
    // 注意：列清单里本来就有 f.team_id（元数据列），这里断言的是 **WHERE 里没有**团队谓词
    expect(call.query).not.toContain("AND f.team_id=$");
    expect(call.query).toContain("WHERE t.tenant_id=$1 AND t.trade_doc_id=$2" + " ORDER BY t.sort_order, t.id");
    expect(call.params).toEqual(["default", 12]);
    expect(spy.fetch).not.toHaveBeenCalled();
  });

  it("非管理员且无团队 → 403 NO_TEAM（硬尺，且不查附件表）", async () => {
    const user = userRow({ team_id: null });
    resetDb(dbStub({ user }));
    const spy = onEnv();

    const res = await request("/api/v1/trade-docs/12/files", user, spy.env);

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ detail: { error: "forbidden", code: "NO_TEAM" } });
    expect(dbCallsContaining("FROM trade_doc_files")).toHaveLength(0);
    expect(spy.fetch).not.toHaveBeenCalled();
  });

  it("开关 off（默认）：原样透传", async () => {
    resetDb(dbStub({ user: userRow() }));
    const spy = kernelSpy();

    const res = await request("/api/v1/trade-docs/12/files", userRow(), spy.env);

    expect(res.status).toBe(200);
    expect(spy.seen).toEqual([
      { method: "GET", path: "/api/v1/trade-docs/12/files", search: "" },
    ]);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 401（on 时门面直接拦）与 DB 故障
// ══════════════════════════════════════════════════════════════════════════════

describe("401：开关 on 时未鉴权不触达 DB / 内核", () => {
  const paths = ["/api/v1/fx-rates", "/api/v1/external-docs", "/api/v1/trade-docs/12/files"];

  for (const path of paths) {
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
  const paths = ["/api/v1/fx-rates", "/api/v1/external-docs", "/api/v1/trade-docs/12/files"];

  for (const path of paths) {
    it(`${path}：查询抛错 → 503（不是 500、也不是 502 kernel_unavailable）`, async () => {
      resetDb((query) => {
        if (query.includes("FROM users WHERE id")) return [userRow()];
        throw new Error("hyperdrive down");
      });
      const spy = onEnv();

      const res = await request(path, userRow(), spy.env);

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
