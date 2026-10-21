/**
 * files 域路由测试（真源 = backend/worker/src/ws_files.py）。
 *
 * 重点：
 * - 无 token → 401（envelope 与 Python _get_current_user 一致）；
 * - 无团队的非管理员 → 403 NO_TEAM（Q6 团队可见性闸门，管理员豁免）；
 * - 列表成功形状 {items:[...]} + 团队谓词 AND team_id=$3；
 * - render-content 令牌校验失败 → 401 RENDER_TOKEN_INVALID（不触库）；
 * - PATCH sort_order 越界 → 422 SORT_ORDER_OUT_OF_RANGE。
 */
import { createHmac } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import app from "../src/index";
import { createToken } from "../src/session";
import { FIXED_SECRET, dbCallsContaining, dbState, resetDb, TEST_ENV, type DbRow } from "./helpers";

vi.mock("../src/db", () => import("./db-mock"));

function userRow(overrides: Partial<DbRow> = {}): DbRow {
  return {
    id: 5,
    email: "owner@qa.test",
    display_name: "Owner",
    account_type: "customer",
    role: "owner",
    status: "active",
    team_id: 7,
    console_access: false,
    plan: "free",
    is_tenant_admin: false,
    ...overrides,
  };
}

async function request(path: string, user: DbRow | null, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (user !== null) {
    const token = await createToken(user.id as number, FIXED_SECRET);
    headers.set("Authorization", "Bearer " + token);
  }
  return app.request(path, { ...init, headers }, TEST_ENV);
}

beforeEach(() => {
  resetDb(() => []);
});

describe("GET /api/v1/file-objects", () => {
  it("无 token → 401 Authentication required", async () => {
    const res = await request("/api/v1/file-objects?owner_type=product", null);

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      detail: { error: "unauthorized", message: "Authentication required" },
    });
  });

  it("无团队的非管理员 → 403 NO_TEAM（管理员才豁免团队谓词）", async () => {
    const user = userRow({ team_id: null });
    resetDb((query) => (query.includes("FROM users WHERE id") ? [user] : []));

    const res = await request("/api/v1/file-objects?owner_type=product", user);

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ detail: { error: "forbidden", code: "NO_TEAM" } });
    // 只发生了 requireUser 的 users 查询，没有触达 file_objects
    expect(dbState.calls).toHaveLength(1);
  });

  it("有团队 → 200，items 按 _row_to_file 投影（int 归一旦 created_at 转 iso）", async () => {
    const user = userRow();
    resetDb((query) => {
      if (query.includes("FROM users WHERE id")) return [user];
      if (query.includes("FROM file_objects")) {
        return [{
          id: "12",
          tenant_id: "default",
          team_id: "7",
          owner_type: "product",
          owner_id: "p1",
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
          uploaded_by: "5",
          created_at: new Date("2026-10-01T03:04:05Z"),
        }];
      }
      return [];
    });

    const res = await request("/api/v1/file-objects?owner_type=product&kind=product_photo", user);

    expect(res.status).toBe(200);
    const body = await res.json() as { items: DbRow[] };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      id: 12,
      team_id: 7,
      file_size: 2048,
      version: 1,
      sort_order: 0,
      created_at: "2026-10-01T03:04:05.000+00:00",
    });
    // 团队谓词（Q6）：next_index = 参数个数(4: tenant/owner_type/owner_id/kind) + 1
    const listCall = dbCallsContaining("FROM file_objects")[0]!;
    expect(listCall.query).toContain("AND team_id=$5");
    expect(listCall.params).toEqual(["default", "product", null, "product_photo", 7]);
  });
});

describe("GET /api/v1/file-objects/{file_id}/render-content", () => {
  it("令牌非法 → 401 RENDER_TOKEN_INVALID（不触库）", async () => {
    const res = await app.request("/api/v1/file-objects/5/render-content?t=bad", {}, TEST_ENV);

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      detail: {
        error: "unauthorized",
        code: "RENDER_TOKEN_INVALID",
        message: "渲染资源令牌无效或已过期",
      },
    });
    expect(dbState.calls).toHaveLength(0);
  });

  it("令牌合法 → 200 且原样返回字节（inline 落点）", async () => {
    const exp = Math.floor(Date.now() / 1000) + 600;
    const sig = createHmac("sha256", FIXED_SECRET).update("file:5:" + String(exp)).digest("hex");
    resetDb((query) => (query.includes("FROM file_objects")
      ? [{ content_type: "image/png", file_name: "a.png", content: new TextEncoder().encode("png-bytes"), object_key: null, storage: "inline" }]
      : []));

    const res = await app.request(
      "/api/v1/file-objects/5/render-content?t=" + String(exp) + "." + sig, {}, TEST_ENV,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(await res.text()).toBe("png-bytes");
  });
});

describe("PATCH /api/v1/file-objects/{file_id}", () => {
  it("sort_order 越界 → 422 SORT_ORDER_OUT_OF_RANGE", async () => {
    const user = userRow();
    resetDb((query) => {
      if (query.includes("FROM users WHERE id")) return [user];
      if (query.includes("FROM file_objects")) {
        return [{ id: 12, team_id: 7, owner_type: "product", owner_id: "p1", kind: "product_photo" }];
      }
      return [];
    });

    const res = await request("/api/v1/file-objects/12", user, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sort_order: 10000 }),
    });

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      detail: {
        error: "validation",
        code: "SORT_ORDER_OUT_OF_RANGE",
        detail: "排序值需在 0 ~ 9999 之间",
      },
    });
  });

  it("文件不存在（团队过滤后为空）→ 404 FILE_NOT_FOUND", async () => {
    const user = userRow();
    resetDb((query) => (query.includes("FROM users WHERE id") ? [user] : []));

    const res = await request("/api/v1/file-objects/99", user, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "新名字" }),
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      detail: { error: "not_found", code: "FILE_NOT_FOUND" },
    });
  });
});
