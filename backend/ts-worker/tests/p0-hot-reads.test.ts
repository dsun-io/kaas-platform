/**
 * P0 热读直连（`AUTH_DB_SPLIT`）集成测试 —— 真源 backend/worker/src/{ws_files,ws_approvals}.py。
 *
 * 设计 = docs/ARCH_AUTH_DB_SPLIT_2026-10-24.md §3.2 / §6 / §8。覆盖：
 * - 开关 on：5 条只读 GET 200，且 **env.KERNEL.fetch 一次都没被调用**（页面不再依赖 Python 冷启动）；
 * - 开关 off（默认）：仍走 KERNEL.fetch，行为与今天一致（一键回退路径）；
 * - SQL 形状：tenant_id='default' 恒在、团队谓词按角色/团队生效、排序口径逐字一致；
 * - tenant/team 隔离：构造「别团队行」→ 404 不泄露存在性；无团队非管理员 → 403 NO_TEAM；
 * - 401 未鉴权路径不变（不打到 DB / 内核）；
 * - TS-DB 失败 → 503 `{error:"db_unavailable",retryable:true}`（与 kernel_unavailable 分开）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import app from "../src/index";
import { DB_UNAVAILABLE_MESSAGE } from "../src/hot-read";
import { MEDIA_KIND_LABELS } from "../src/rules";
import { createToken } from "../src/session";
import {
  FIXED_SECRET,
  dbCallsContaining,
  dbState,
  makeTestEnv,
  resetDb,
  TEST_ENV,
  type DbRow,
} from "./helpers";

vi.mock("../src/db", () => import("./db-mock"));

// ── 测试脚手架 ──────────────────────────────────────────────────────────────

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

/** 内核替身：记录被转发到的 path（开关 off 时应有 1 条；on 时应为 0 条）。 */
function kernelSpy(flag: Record<string, unknown> = {}): {
  seen: Array<{ method: string; path: string; search: string }>;
  fetch: ReturnType<typeof vi.fn>;
  env: typeof TEST_ENV;
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

async function request(
  path: string,
  user: DbRow | null,
  env: typeof TEST_ENV = TEST_ENV,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (user !== null) {
    const token = await createToken(user.id as number, FIXED_SECRET);
    headers.set("Authorization", "Bearer " + token);
  }
  return app.request(path, { ...init, headers }, env);
}

/** 按 SQL 片段路由的 DB 桩（fakeSql 把插值换成 "?"，但 unsafe 的原样 SQL 保留 $n）。 */
function dbStub(rows: {
  user?: DbRow;
  mediaCounts?: DbRow[];
  profiles?: DbRow[];
  profile?: DbRow | null;
  productMedia?: DbRow[];
  unread?: DbRow;
  approvalsTotal?: DbRow[];
  approvals?: DbRow[];
  docs?: DbRow[];
}): (query: string) => DbRow[] {
  return (query: string): DbRow[] => {
    if (query.includes("FROM users WHERE id")) return rows.user ? [rows.user] : [];
    if (query.includes("SELECT owner_id, COUNT(*)")) return rows.mediaCounts ?? [];
    if (query.includes("SELECT product_key, info FROM product_profiles")) return rows.profiles ?? [];
    if (query.includes("SELECT product_key, info, updated_at, team_id")) {
      return rows.profile ? [rows.profile] : [];
    }
    if (query.includes("SELECT id, tenant_id, team_id, owner_type")) return rows.productMedia ?? [];
    if (query.includes("FROM notifications")) return rows.unread ? [rows.unread] : [];
    if (query.includes("count(*) AS n FROM order_item_change_requests")) {
      return rows.approvalsTotal ?? [{ n: "0" }];
    }
    if (query.includes("SELECT r.*, o.order_no")) return rows.approvals ?? [];
    if (query.includes("FROM trade_docs")) return rows.docs ?? [];
    return [];
  };
}

function onEnv(flag: Record<string, unknown> = {}) {
  return kernelSpy({ AUTH_DB_SPLIT: "on", ...flag });
}

/** 关断路径的公共断言：只有一次 KERNEL.fetch，path/search 与旧透传逐字一致。 */
function expectForwarded(
  spy: ReturnType<typeof kernelSpy>,
  path: string,
  search = "",
): void {
  expect(spy.seen).toHaveLength(1);
  expect(spy.seen[0]).toEqual({ method: "GET", path, search });
}

beforeEach(() => {
  resetDb(() => []);
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/v1/products（ws_files.py:385-431）
// ══════════════════════════════════════════════════════════════════════════════

describe("GET /api/v1/products（P0 直连）", () => {
  const CHAIN_LINK_INFO = {
    name_en_list: ["Chain Link Fence", "Chain Link Mesh"],
    name_en_primary: "Chain Link Fence",
    usage: "fence",
  };

  it("开关 on：200 + 形状与内核一致（3 个注册表产品，按 sorted keys）+ 全程不经内核", async () => {
    resetDb(
      dbStub({
        user: userRow(),
        mediaCounts: [
          { owner_id: "chain_link", n: "2" },
          { owner_id: "deer_net", n: "0" },
        ],
        profiles: [
          { product_key: "chain_link", info: CHAIN_LINK_INFO },
          // 同一 key 的第二行（updated_at 更旧）**不应**生效（setdefault 口径）
          { product_key: "chain_link", info: { usage: "old" } },
        ],
      }),
    );
    const spy = onEnv();

    const res = await request("/api/v1/products", userRow(), spy.env);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: DbRow[]; media_kinds: Record<string, string> };

    expect(body.media_kinds).toEqual(MEDIA_KIND_LABELS);
    expect(body.items.map((item) => item.product_key)).toEqual([
      "chain_link",
      "deer_net",
      "field_fence",
    ]);
    expect(body.items[0]).toEqual({
      product_key: "chain_link",
      name: "勾花网",
      name_en: "Chain Link Fence",
      name_en_aliases: ["Chain Link Mesh"],
      name_en_list: ["Chain Link Fence", "Chain Link Mesh"],
      category_code: "gouhuawang",
      media_count: 2,
      profile: CHAIN_LINK_INFO,
    });
    // 没配团队资料 ⇒ 英文名回落代码注册表（旧响应逐字不变）；profile 为 {}
    expect(body.items[1]).toEqual({
      product_key: "deer_net",
      name: "鹿网",
      name_en: "Deer Net",
      name_en_aliases: [],
      name_en_list: ["Deer Net"],
      category_code: "luwang",
      media_count: 0,
      profile: {},
    });
    expect(body.items[2]).toMatchObject({
      product_key: "field_fence",
      name: "牛栏网",
      name_en: "Field Fence",
      category_code: "niulanwang",
    });

    // 团队隔离（soft 尺）：两条 SQL 都带 tenant + team 谓词
    const profCall = dbCallsContaining("SELECT product_key, info FROM product_profiles")[0]!;
    expect(profCall.query).toContain("WHERE tenant_id=$1 AND team_id=$2");
    expect(profCall.query).toContain("ORDER BY updated_at DESC");
    expect(profCall.params).toEqual(["default", 4]);

    const mediaCall = dbCallsContaining("SELECT owner_id, COUNT(*)")[0]!;
    expect(mediaCall.query).toContain("AND owner_type='product' AND kind='product_photo' AND is_current");
    expect(mediaCall.query).toContain("AND team_id=$2");
    expect(mediaCall.query).toContain("GROUP BY owner_id");
    expect(mediaCall.params).toEqual(["default", 4]);

    expect(spy.fetch).not.toHaveBeenCalled();
  });

  it("管理员视角：不加团队谓词（看得见全部团队的资料/图片）", async () => {
    resetDb(
      dbStub({
        user: userRow({ role: "admin" }),
        mediaCounts: [{ owner_id: "field_fence", n: "1" }],
      }),
    );
    const spy = onEnv();

    const res = await request("/api/v1/products", userRow({ role: "admin" }), spy.env);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: DbRow[] };
    expect(body.items.find((item) => item.product_key === "field_fence")!.media_count).toBe(1);

    const profCall = dbCallsContaining("SELECT product_key, info FROM product_profiles")[0]!;
    expect(profCall.query).not.toContain("team_id=$2");
    expect(profCall.params).toEqual(["default"]);
    const mediaCall = dbCallsContaining("SELECT owner_id, COUNT(*)")[0]!;
    expect(mediaCall.query).not.toContain("team_id=$2");
    expect(mediaCall.params).toEqual(["default"]);
    expect(spy.fetch).not.toHaveBeenCalled();
  });

  it("无团队的非管理员：soft 尺不 403，只是私有部分为空（team_id = NULL 谓词）", async () => {
    resetDb(dbStub({ user: userRow({ team_id: null }) }));
    const spy = onEnv();

    const res = await request("/api/v1/products", userRow({ team_id: null }), spy.env);

    expect(res.status).toBe(200);
    const profCall = dbCallsContaining("SELECT product_key, info FROM product_profiles")[0]!;
    expect(profCall.query).toContain("AND team_id=$2");
    expect(profCall.params).toEqual(["default", null]);
    expect(spy.fetch).not.toHaveBeenCalled();
  });

  it("历史单值 name_en 兼容（product_names.py:98-101）", async () => {
    resetDb(
      dbStub({
        user: userRow(),
        profiles: [{ product_key: "deer_net", info: { name_en: "Deer Fence" } }],
      }),
    );
    const spy = onEnv();

    const res = await request("/api/v1/products", userRow(), spy.env);
    const body = (await res.json()) as { items: DbRow[] };

    expect(body.items[1]).toMatchObject({
      product_key: "deer_net",
      name_en: "Deer Fence",
      name_en_list: ["Deer Fence"],
      name_en_aliases: [],
    });
  });

  it("开关 off（默认）：仍走 KERNEL.fetch，行为与今天一致（回退路径）", async () => {
    resetDb(dbStub({ user: userRow() }));
    const spy = kernelSpy();

    const res = await request("/api/v1/products", userRow(), spy.env);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expectForwarded(spy, "/api/v1/products");
  });

  it("白名单只放 notifications ⇒ products 仍透传、unread-count 直连", async () => {
    resetDb(dbStub({ user: userRow(), unread: { n: "0" } }));
    const spy = onEnv({ AUTH_DB_SPLIT_ROUTES: "notifications" });

    const products = await request("/api/v1/products", userRow(), spy.env);
    expect(products.status).toBe(200);
    expect(spy.seen).toHaveLength(1);

    const unread = await request("/api/v1/notifications/unread-count", userRow(), spy.env);
    expect(unread.status).toBe(200);
    expect(await unread.json()).toEqual({ unread: 0 });
    expect(spy.seen).toHaveLength(1);
  });

  it("TS-DB 查询失败 → 503 db_unavailable（与 kernel_unavailable 分开）", async () => {
    resetDb((query) => {
      if (query.includes("FROM users WHERE id")) return [userRow()];
      throw new Error("hyperdrive down");
    });
    const spy = onEnv();

    const res = await request("/api/v1/products", userRow(), spy.env);

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

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/v1/products/{product_key}/profile（ws_files.py:438-463）
// ══════════════════════════════════════════════════════════════════════════════

describe("GET /api/v1/products/{key}/profile（P0 直连）", () => {
  function profileRow(overrides: Partial<DbRow> = {}): DbRow {
    return {
      product_key: "chain_link",
      info: {
        name_en_list: ["Chain Link Mesh"],
        name_en_primary: "Chain Link Fence",
        usage: "fence",
      },
      updated_at: new Date("2026-10-01T03:04:05Z"),
      team_id: "4",
      ...overrides,
    };
  }

  it("开关 on：本团队行 200，info 按读时投影归一（主名在前）+ updated_at isoformat", async () => {
    resetDb(dbStub({ user: userRow(), profile: profileRow() }));
    const spy = onEnv();

    const res = await request("/api/v1/products/chain_link/profile", userRow(), spy.env);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      product_key: "chain_link",
      info: {
        name_en_list: ["Chain Link Fence", "Chain Link Mesh"],
        name_en_primary: "Chain Link Fence",
        usage: "fence",
      },
      updated_at: "2026-10-01T03:04:05.000+00:00",
    });
    const call = dbCallsContaining("SELECT product_key, info, updated_at, team_id")[0]!;
    expect(call.query).toContain("WHERE tenant_id=$1 AND product_key=$2");
    expect(call.params).toEqual(["default", "chain_link"]);
    expect(spy.fetch).not.toHaveBeenCalled();
  });

  it("别团队的行 → 404 PROFILE_NOT_FOUND（不泄露存在性；构造两租户行）", async () => {
    resetDb(dbStub({ user: userRow(), profile: profileRow({ team_id: "8" }) }));
    const spy = onEnv();

    const res = await request("/api/v1/products/chain_link/profile", userRow(), spy.env);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      detail: { error: "not_found", code: "PROFILE_NOT_FOUND" },
    });
    expect(spy.fetch).not.toHaveBeenCalled();
  });

  it("历史 NULL 行（无法归因）对非管理员 → 404（Q1=B + D3/D4）", async () => {
    resetDb(dbStub({ user: userRow(), profile: profileRow({ team_id: null }) }));
    const spy = onEnv();

    const res = await request("/api/v1/products/chain_link/profile", userRow(), spy.env);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      detail: { error: "not_found", code: "PROFILE_NOT_FOUND" },
    });
  });

  it("访问者无团队（非管理员）→ 403 NO_TEAM（403 先于 404）", async () => {
    resetDb(
      dbStub({ user: userRow({ team_id: null }), profile: profileRow({ team_id: "8" }) }),
    );
    const spy = onEnv();

    const res = await request(
      "/api/v1/products/chain_link/profile",
      userRow({ team_id: null }),
      spy.env,
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ detail: { error: "forbidden", code: "NO_TEAM" } });
  });

  it("行不存在不是 404：200 + info {} + updated_at null（产品定义人人可读）", async () => {
    resetDb(dbStub({ user: userRow(), profile: null }));
    const spy = onEnv();

    const res = await request("/api/v1/products/deer_net/profile", userRow(), spy.env);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      product_key: "deer_net",
      info: {},
      updated_at: null,
    });
  });

  it("info 是 JSON 字符串（dbjson 漏登记的防御）⇒ 解析后再投影，坏值回落 {}", async () => {
    resetDb(
      dbStub({
        user: userRow(),
        profile: profileRow({ info: JSON.stringify({ name_en: "Legacy Name" }) }),
      }),
    );
    const spy = onEnv();

    const ok = await request("/api/v1/products/chain_link/profile", userRow(), spy.env);
    expect(((await ok.json()) as { info: DbRow }).info).toEqual({
      name_en: "Legacy Name",
      name_en_list: ["Legacy Name"],
      name_en_primary: "Legacy Name",
    });

    resetDb(dbStub({ user: userRow(), profile: profileRow({ info: "{not json" }) }));
    const bad = await request("/api/v1/products/chain_link/profile", userRow(), spy.env);
    expect(bad.status).toBe(200);
    expect(await bad.json()).toEqual({
      product_key: "chain_link",
      info: {},
      updated_at: "2026-10-01T03:04:05.000+00:00",
    });
  });

  it("开关 off：原样透传（path 参数不丢）", async () => {
    resetDb(dbStub({ user: userRow() }));
    const spy = kernelSpy();

    const res = await request("/api/v1/products/chain_link/profile", userRow(), spy.env);

    expect(res.status).toBe(200);
    expectForwarded(spy, "/api/v1/products/chain_link/profile");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/v1/products/{product_key}/media（ws_files.py:503-512）
// ══════════════════════════════════════════════════════════════════════════════

describe("GET /api/v1/products/{key}/media（P0 直连）", () => {
  function mediaRow(overrides: Partial<DbRow> = {}): DbRow {
    return {
      id: "12",
      tenant_id: "default",
      team_id: "4",
      owner_type: "product",
      owner_id: "chain_link",
      kind: "product_photo",
      media_kind: "production",
      name: "正面图",
      storage: "inline",
      object_key: null,
      file_name: "a.png",
      content_type: "image/png",
      file_size: "2048",
      sha256: "abc",
      version: "1",
      supersedes_id: null,
      is_current: true,
      is_primary: true,
      sort_order: "0",
      uploaded_by: "9",
      created_at: new Date("2026-10-01T03:04:05Z"),
      ...overrides,
    };
  }

  it("开关 on：200 + items 投影（BIGINT→int / created_at→iso）+ 排序口径逐字一致", async () => {
    resetDb(dbStub({ user: userRow(), productMedia: [mediaRow()] }));
    const spy = onEnv();

    const res = await request("/api/v1/products/chain_link/media", userRow(), spy.env);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: DbRow[]; media_kinds: Record<string, string> };
    expect(body.media_kinds).toEqual(MEDIA_KIND_LABELS);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      id: 12,
      team_id: 4,
      file_size: 2048,
      version: 1,
      supersedes_id: null,
      sort_order: 0,
      created_at: "2026-10-01T03:04:05.000+00:00",
      media_kind: "production",
    });

    const call = dbCallsContaining("FROM file_objects")[0]!;
    // tenant 隔离 + owner 隔离 + 只取当前件（is_current）
    expect(call.query).toContain(
      "WHERE tenant_id=$1 AND owner_type='product' AND owner_id=$2 AND kind='product_photo' AND is_current",
    );
    // 硬团队尺：$3（前两个参数是 tenant / product_key）
    expect(call.query).toContain("AND team_id=$3");
    // 展示顺序唯一口径 is_primary DESC, sort_order, id
    expect(call.query).toContain("ORDER BY is_primary DESC, sort_order, id");
    expect(call.params).toEqual(["default", "chain_link", 4]);
    expect(spy.fetch).not.toHaveBeenCalled();
  });

  it("管理员：不加团队谓词（参数只有 tenant + product_key）", async () => {
    resetDb(dbStub({ user: userRow({ role: "admin" }), productMedia: [] }));
    const spy = onEnv();

    const res = await request("/api/v1/products/chain_link/media", userRow({ role: "admin" }), spy.env);

    expect(res.status).toBe(200);
    const call = dbCallsContaining("FROM file_objects")[0]!;
    expect(call.query).not.toContain("team_id=$3");
    expect(call.params).toEqual(["default", "chain_link"]);
  });

  it("非管理员无团队 → 403 NO_TEAM（硬尺，不查库）", async () => {
    resetDb(dbStub({ user: userRow({ team_id: null }) }));
    const spy = onEnv();

    const res = await request(
      "/api/v1/products/chain_link/media",
      userRow({ team_id: null }),
      spy.env,
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ detail: { error: "forbidden", code: "NO_TEAM" } });
    expect(dbCallsContaining("FROM file_objects")).toHaveLength(0);
    expect(spy.fetch).not.toHaveBeenCalled();
  });

  it("开关 off：原样透传", async () => {
    resetDb(dbStub({ user: userRow() }));
    const spy = kernelSpy();

    const res = await request("/api/v1/products/chain_link/media", userRow(), spy.env);

    expect(res.status).toBe(200);
    expectForwarded(spy, "/api/v1/products/chain_link/media");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/v1/notifications/unread-count（ws_approvals.py:618-629）
// ══════════════════════════════════════════════════════════════════════════════

describe("GET /api/v1/notifications/unread-count（P0 直连）", () => {
  it("开关 on：200 {unread:N}，SQL = tenant + user + 未读，且不经内核", async () => {
    resetDb(dbStub({ user: userRow({ id: 11 }), unread: { n: "2" } }));
    const spy = onEnv();

    const res = await request("/api/v1/notifications/unread-count", userRow({ id: 11 }), spy.env);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ unread: 2 });

    const call = dbCallsContaining("FROM notifications")[0]!;
    expect(call.query).toContain(
      "WHERE tenant_id=$1 AND user_id=$2 AND read_at IS NULL",
    );
    expect(call.params).toEqual(["default", 11]);
    expect(spy.fetch).not.toHaveBeenCalled();
  });

  it("count 为空/null ⇒ 0（Python int(count or 0)）", async () => {
    resetDb(dbStub({ user: userRow(), unread: { n: null } }));
    const spy = onEnv();

    const res = await request("/api/v1/notifications/unread-count", userRow(), spy.env);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ unread: 0 });
  });

  it("开关 off：原样透传", async () => {
    resetDb(dbStub({ user: userRow() }));
    const spy = kernelSpy();

    const res = await request("/api/v1/notifications/unread-count", userRow(), spy.env);

    expect(res.status).toBe(200);
    expectForwarded(spy, "/api/v1/notifications/unread-count");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/v1/approvals（ws_approvals.py:478-572）
// ══════════════════════════════════════════════════════════════════════════════

describe("GET /api/v1/approvals（P0 直连）", () => {
  function approvalRow(overrides: Partial<DbRow> = {}): DbRow {
    return {
      id: "5",
      tenant_id: "default",
      order_id: "31",
      requested_by: "9",
      reason: "改数量",
      items: [{ product_name_raw: "鹿网" }],
      snapshot: [],
      status: "pending",
      decided_by: null,
      decided_at: null,
      decision_reason: null,
      team_id: "4",
      created_at: new Date("2026-10-22T01:02:03Z"),
      order_no: "SO-001",
      order_status: "confirmed",
      total_amount: "1200.50",
      currency: "USD",
      requester_name: "申请人",
      ...overrides,
    };
  }

  it("管理员 pending：只筛 status='pending'（无团队路由子查询）+ 分页参数 + affected_docs 一次 IN 查", async () => {
    resetDb(
      dbStub({
        user: userRow({ role: "admin" }),
        approvalsTotal: [{ n: "2" }],
        approvals: [approvalRow()],
        docs: [
          { order_id: "31", id: "3", doc_type: "contract", doc_no: "CT-1", status: "issued" },
        ],
      }),
    );
    const spy = onEnv();

    const res = await request(
      "/api/v1/approvals?view=pending&page=2&page_size=10",
      userRow({ role: "admin" }),
      spy.env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: DbRow[];
      total: number;
      page: number;
      page_size: number;
    };
    expect(body).toMatchObject({ total: 2, page: 2, page_size: 10 });
    expect(body.items).toEqual([
      {
        id: 5,
        order_id: 31,
        order_no: "SO-001",
        requested_by: 9,
        reason: "改数量",
        items: [{ product_name_raw: "鹿网" }],
        snapshot: [],
        status: "pending",
        decided_by: null,
        decided_at: null,
        decision_reason: null,
        team_id: 4,
        created_at: "2026-10-22T01:02:03.000+00:00",
        order_status: "confirmed",
        order_total_amount: 1200.5,
        order_currency: "USD",
        requester_name: "申请人",
        affected_docs: [{ id: 3, doc_type: "contract", doc_no: "CT-1", status: "issued" }],
      },
    ]);

    const countCall = dbCallsContaining("count(*) AS n FROM order_item_change_requests")[0]!;
    expect(countCall.query).toContain("WHERE r.tenant_id = $1 AND r.status = 'pending'");
    expect(countCall.query).not.toContain("team_approvers");
    expect(countCall.params).toEqual(["default"]);

    const rowsCall = dbCallsContaining("SELECT r.*, o.order_no")[0]!;
    expect(rowsCall.query).toContain("ORDER BY r.created_at DESC, r.id DESC");
    expect(rowsCall.query).toContain("LIMIT $2 OFFSET $3");
    expect(rowsCall.params).toEqual(["default", 10, 10]);

    const docsCall = dbCallsContaining("FROM trade_docs")[0]!;
    expect(docsCall.query).toContain("order_id = ANY($2::bigint[])");
    expect(docsCall.params).toEqual(["default", [31]]);
    expect(spy.fetch).not.toHaveBeenCalled();
  });

  it("非管理员 pending：指定审批人优先 + 团队管理员兜底（与 ws_approvals.py:503-514 逐字）", async () => {
    resetDb(dbStub({ user: userRow({ id: 9, team_id: 4 }), approvalsTotal: [{ n: "0" }] }));
    const spy = onEnv();

    const res = await request("/api/v1/approvals?view=pending", userRow({ id: 9, team_id: 4 }), spy.env);

    expect(res.status).toBe(200);
    const countCall = dbCallsContaining("count(*) AS n FROM order_item_change_requests")[0]!;
    expect(countCall.query).toContain("r.status = 'pending'");
    expect(countCall.query).toContain("EXISTS (SELECT 1 FROM team_approvers a");
    expect(countCall.query).toContain("a.team_id = r.team_id AND a.user_id = $2");
    expect(countCall.query).toContain("NOT EXISTS (SELECT 1 FROM team_approvers a2");
    expect(countCall.query).toContain("o.tenant_id = r.tenant_id AND o.id = r.order_id");
    expect(countCall.query).toContain("o.team_id = $2");
    expect(countCall.params).toEqual(["default", 9]);
  });

  it("view=mine → requested_by；view=done → decided_by + 已处理状态", async () => {
    const spy = onEnv();

    resetDb(dbStub({ user: userRow({ id: 9 }), approvalsTotal: [{ n: "0" }] }));
    await request("/api/v1/approvals?view=mine", userRow({ id: 9 }), spy.env);
    const mine = dbCallsContaining("count(*) AS n FROM order_item_change_requests")[0]!;
    expect(mine.query).toContain("WHERE r.tenant_id = $1 AND r.requested_by = $2");
    expect(mine.params).toEqual(["default", 9]);

    resetDb(dbStub({ user: userRow({ id: 9 }), approvalsTotal: [{ n: "0" }] }));
    await request("/api/v1/approvals?view=done", userRow({ id: 9 }), spy.env);
    const done = dbCallsContaining("count(*) AS n FROM order_item_change_requests")[0]!;
    expect(done.query).toContain(
      "WHERE r.tenant_id = $1 AND r.decided_by = $2 AND r.status IN ('approved','rejected')",
    );
    expect(done.params).toEqual(["default", 9]);
  });

  it("非法 view → 422 INVALID_VIEW（不静默返回空列表）", async () => {
    resetDb(dbStub({ user: userRow() }));
    const spy = onEnv();

    const res = await request("/api/v1/approvals?view=nope", userRow(), spy.env);

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      detail: {
        error: "validation",
        code: "INVALID_VIEW",
        field: "view",
        value: "nope",
        allowed: ["pending", "mine", "done"],
      },
    });
    expect(dbCallsContaining("FROM order_item_change_requests")).toHaveLength(0);
    expect(spy.fetch).not.toHaveBeenCalled();
  });

  it("page_size 越界（>200）/ page<1 → 422（FastAPI Query 约束）", async () => {
    resetDb(dbStub({ user: userRow() }));
    const spy = onEnv();

    expect((await request("/api/v1/approvals?page_size=201", userRow(), spy.env)).status).toBe(422);
    expect((await request("/api/v1/approvals?page=0", userRow(), spy.env)).status).toBe(422);
    expect(dbCallsContaining("FROM order_item_change_requests")).toHaveLength(0);
  });

  it("开关 off：原样透传（query 不丢）", async () => {
    resetDb(dbStub({ user: userRow() }));
    const spy = kernelSpy();

    const res = await request("/api/v1/approvals?view=pending&page=2", userRow(), spy.env);

    expect(res.status).toBe(200);
    expectForwarded(spy, "/api/v1/approvals", "?view=pending&page=2");
  });

  it("TS-DB 失败 → 503 db_unavailable", async () => {
    resetDb((query) => {
      if (query.includes("FROM users WHERE id")) return [userRow({ role: "admin" })];
      throw new Error("hyperdrive down");
    });
    const spy = onEnv();

    const res = await request("/api/v1/approvals", userRow({ role: "admin" }), spy.env);

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: "db_unavailable",
      message: DB_UNAVAILABLE_MESSAGE,
      status: 503,
      retryable: true,
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 401 未鉴权路径不变（开关 on 也不打到 DB / 内核）
// ══════════════════════════════════════════════════════════════════════════════

describe("401：未鉴权不触达 DB / 内核（开关 on 也一样）", () => {
  const paths = [
    "/api/v1/products",
    "/api/v1/products/chain_link/profile",
    "/api/v1/products/chain_link/media",
    "/api/v1/notifications/unread-count",
    "/api/v1/approvals",
  ];

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
