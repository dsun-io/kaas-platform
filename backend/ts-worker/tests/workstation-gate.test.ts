/**
 * 门面·工位闸门（src/workstation-gate.ts）单测。
 *
 * 为什么必须有这一组：工位闸门是**商业限制**的边界。它原先只在内核中间件里，
 * 门面直连路由（AUTH_DB_SPLIT=on）不经过内核 ⇒ 一旦放量就绕过限制
 * （2026-10-24 P2 灰度实测踩到：未开通账号直接算出报价，见 docs/P2_COUPLING_ENGINE_2026-10-24.md §8.5.2）。
 *
 * 覆盖：
 * 1. 路径映射与**真源漂移机检**（直接解析 backend/kaas_common/workstation/subscriptions.py）；
 * 2. 未开通 ⇒ 404 且 body 与内核逐字同形；
 * 3. 已开通 ⇒ 放行；放行白名单（products 等）不受闸门影响；
 * 4. 无 token ⇒ 放行（认证归路由）；开关 off ⇒ 全放行（内核负责）；
 * 5. DB 抛错 ⇒ **放行**（与内核兜底口径一致）。
 */
import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

// 与其它路由测试同款：把 src/db 的 withDb 接到共享假 SQL（否则会真连 PG）。
vi.mock("../src/db", () => import("./db-mock"));

import app from "../src/index";
import {
  ALWAYS_ALLOWED_PREFIXES,
  isAlwaysAllowedPath,
  matchPrefix,
  workstationMapSnapshot,
  workstationOfPath,
  WORKSTATION_PATHS,
} from "../src/workstation-gate";

import { FIXED_SECRET, makeTestEnv, resetDb, resetSubscriptions, type DbRow } from "./helpers";

const PY_SOURCE = new URL("../../kaas_common/workstation/subscriptions.py", import.meta.url);

const USER: DbRow = {
  id: 7,
  email: "member@qa.test",
  display_name: "成员",
  account_type: "customer",
  role: "member",
  status: "active",
  team_id: 3,
  console_access: false,
  plan: "free",
  is_tenant_admin: false,
};

async function tokenFor(): Promise<string> {
  const { createToken } = await import("../src/session");
  return createToken(USER.id as number, FIXED_SECRET);
}

function envOn(over: Record<string, unknown> = {}) {
  return makeTestEnv({
    AUTH_DB_SPLIT: "on",
    AUTH_DB_SPLIT_ROUTES: "quotations.list",
    KERNEL: { fetch: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }) } as never,
    ...over,
  });
}

async function call(path: string, env: ReturnType<typeof makeTestEnv>, withToken = true) {
  const headers = new Headers();
  if (withToken) headers.set("Authorization", "Bearer " + (await tokenFor()));
  return app.request(path, { headers }, env);
}

const gateBody = {
  error: "not_found",
  code: "WORKSTATION_NOT_SUBSCRIBED",
  workstation: "quotes",
  detail: "该工位未开通，请在“工位开通”里启用",
};

describe("路径映射（与 kaas_common 真源逐条一致）", () => {
  it("前缀匹配带边界：/api/v1/orders 不吞 /api/v1/orders-x", () => {
    expect(matchPrefix("/api/v1/orders", "/api/v1/orders")).toBe(true);
    expect(matchPrefix("/api/v1/orders/9", "/api/v1/orders")).toBe(true);
    expect(matchPrefix("/api/v1/orders-x", "/api/v1/orders")).toBe(false);
    expect(workstationOfPath("/api/v1/orders-x")).toBeNull();
  });

  it("代表性映射：inquiries→customers、quotations→quotes、内部 RPC→quotes、fx-rates→trade-docs", () => {
    expect(workstationOfPath("/api/v1/inquiries")).toBe("customers");
    expect(workstationOfPath("/api/v1/inquiries/12/stage-log")).toBe("customers");
    expect(workstationOfPath("/api/v1/quotations")).toBe("quotes");
    // 内部 RPC 前缀必须覆盖整族（P2 灰度踩坑点）
    expect(workstationOfPath("/api/v1/internal/engine/quote/calculate")).toBe("quotes");
    expect(workstationOfPath("/api/v1/internal/engine/quote/verify")).toBe("quotes");
    expect(workstationOfPath("/api/v1/fx-rates")).toBe("trade-docs");
  });

  it("放行白名单：产品/文件/账号/团队等不按工位收费", () => {
    for (const p of ["/api/v1/products", "/api/v1/products/x/media", "/api/v1/file-objects/1/content",
      "/api/v1/auth/login", "/api/v1/teams", "/api/v1/dashboard", "/api/v1/tenant-products", "/health"]) {
      expect(isAlwaysAllowedPath(p)).toBe(true);
    }
    expect(isAlwaysAllowedPath("/api/v1/quotations")).toBe(false);
  });

  it("漂移机检：TS 映射与 Python WORKSTATION_PATHS / ALWAYS_ALLOWED_PREFIXES 完全相同", () => {
    const source = readFileSync(PY_SOURCE, "utf8");
    // 去掉行注释后抓取两个声明块里的路径字面量（避免把注释里的示例当成映射）。
    const strip = (text: string) => text.split("\n").map((l) => l.replace(/#.*$/, "")).join("\n");
    // 按「定义处」定位（模块顶部 __all__ 里也出现这两个名字，不能用第一次 indexOf）。
    const blockOf = (startMarker: string, endMarker: string): string => {
      const start = source.indexOf(startMarker);
      expect(start).toBeGreaterThan(-1);
      const stop = source.indexOf(endMarker, start);
      expect(stop).toBeGreaterThan(start);
      return strip(source.slice(start, stop));
    };
    const pathsBlock = blockOf("WORKSTATION_PATHS: dict", "ALWAYS_ALLOWED_PREFIXES: tuple");
    const allowedBlock = blockOf("ALWAYS_ALLOWED_PREFIXES: tuple", "def _match_prefix");
    // 只抓**路径字面量**（以 / 开头）；工位 key（"customers" 等）不算路径。
    const PATH_LITERAL = new RegExp('"(' + String.fromCharCode(47) + '[^"]*)"', "g");
    const literals = (text: string) => new Set([...text.matchAll(PATH_LITERAL)].map((m) => m[1]));

    const pyAllPaths = literals(pathsBlock);
    const tsAllPaths = new Set(Object.values(workstationMapSnapshot()).flat());
    expect([...tsAllPaths].sort()).toEqual([...pyAllPaths].sort());

    const pyAllowed = literals(allowedBlock);
    expect([...ALWAYS_ALLOWED_PREFIXES].sort()).toEqual([...pyAllowed].sort());

    // 每个工位 key 也必须一致
    expect(Object.keys(WORKSTATION_PATHS).sort()).toEqual(
      [...pathsBlock.matchAll(/^\s{4}"?([a-z-]+)"?:/gm)].map((m) => m[1]).sort(),
    );
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// API token（kaas_oat_）路径：**不能用 JWT 的 verifyToken 判身份**，否则会静默绕过闸门
// （旧实现：verifyToken 抛错 → catch → 放行 ⇒ API token 不判订阅，属真实绕过口）。
// 这里用「token 创建人」身份（与内核 mintInternalJwt 的 sub=created_by 同口径）重建最小 app 验证。
// ══════════════════════════════════════════════════════════════════════════════

describe("闸门 · API token 身份", () => {
  async function withApiToken(
    userRow: DbRow | null,
    env: ReturnType<typeof makeTestEnv>,
    subscriptionCodes: string[] = [],
  ): Promise<Response> {
    const { Hono } = await import("hono");
    const { workstationGate } = await import("../src/workstation-gate");
    type MiniVars = { Variables: { apiTokenActor: unknown } };
    const mini = new Hono<{ Bindings: ReturnType<typeof makeTestEnv> } & MiniVars>();
    mini.use("*", async (c, next) => {
      // 模拟 scope-map 中间件：API token 已认证，写入 actor（无 JWT claims）。
      c.set("apiTokenActor", { createdBy: 7, teamId: 3, scopes: ["products:read"], tokenId: 1 } as never);
      await next();
    });
    mini.use("*", workstationGate());
    mini.get("/api/v1/quotations", (c) => c.json({ ok: true }));
    resetDb((query) => (query.includes("FROM users WHERE id") && userRow ? [userRow] : []));
    // 注意顺序：resetDb 会把订阅桩复位成「已开通」，所以订阅必须在它之后再设。
    resetSubscriptions(subscriptionCodes);
    return mini.request("/api/v1/quotations", { headers: { Authorization: "Bearer kaas_oat_fake" } }, env);
  }

  it("未开通 ⇒ 404（不再绕过）；已开通 ⇒ 放行；管理员 ⇒ 放行；用户行缺失 ⇒ 兜底放行", async () => {
    const env = makeTestEnv({ AUTH_DB_SPLIT: "on" });

    const denied = await withApiToken(USER, env, []);
    expect(denied.status).toBe(404);
    expect(await denied.json()).toEqual(gateBody);

    const allowed = await withApiToken(USER, env, ["quotes"]);
    expect(allowed.status).toBe(200);

    // 管理员：codesForUser 直接给 full_chain（不看订阅表）
    const admin = await withApiToken({ ...USER, role: "system_admin", account_type: "internal" }, env, []);
    expect(admin.status).toBe(200);

    // 创建人用户行不存在 ⇒ 无从判定 ⇒ 兜底放行（与"工位门控尽力而为"一致）
    const missing = await withApiToken(null, env, []);
    expect(missing.status).toBe(200);
  });
});

describe("闸门行为", () => {
  beforeEach(() => {
    resetDb((query) => (query.includes("FROM users WHERE id") ? [USER] : []));
  });

  it("未开通 ⇒ 404，body 与内核逐字同形", async () => {
    resetSubscriptions([]);
    const res = await call("/api/v1/quotations", envOn());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(gateBody);
  });

  it("已开通（team_subscriptions 有 quotes）⇒ 放行到路由", async () => {
    resetSubscriptions(["quotes"]);
    const res = await call("/api/v1/quotations", envOn());
    expect(res.status).not.toBe(404);
    expect(await res.text()).not.toContain("WORKSTATION_NOT_SUBSCRIBED");
  });

  it("full_chain ⇒ 开通一切工位", async () => {
    resetSubscriptions(["full_chain"]);
    const res = await call("/api/v1/quotations", envOn());
    expect(res.status).not.toBe(404);
  });

  it("放行白名单路径不受闸门影响（未开通也不拦）", async () => {
    resetSubscriptions([]);
    const res = await call("/api/v1/products", envOn());
    expect(await res.text()).not.toContain("WORKSTATION_NOT_SUBSCRIBED");
  });

  it("无 token ⇒ 放行（认证归路由，闸门不越权）", async () => {
    resetSubscriptions([]);
    const res = await call("/api/v1/quotations", envOn(), false);
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain("WORKSTATION_NOT_SUBSCRIBED");
  });

  it("开关 off ⇒ 全放行（闸门归内核，门面不重复判）", async () => {
    resetSubscriptions([]);
    const res = await call("/api/v1/quotations", makeTestEnv());
    expect(await res.text()).not.toContain("WORKSTATION_NOT_SUBSCRIBED");
  });

  it("DB 抛错 ⇒ 放行（与内核兜底一致，不把订阅故障变成全站 500）", async () => {
    resetDb(() => {
      throw new Error("hyperdrive down");
    });
    const res = await call("/api/v1/quotations", envOn());
    expect(await res.text()).not.toContain("WORKSTATION_NOT_SUBSCRIBED");
  });
});
