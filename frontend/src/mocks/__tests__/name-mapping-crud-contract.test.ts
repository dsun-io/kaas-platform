// @vitest-environment node
/**
 * 品名对照 CRUD mock 契约（B2 · 2026-10-23）
 *
 * 形状真源：\`backend/worker/src/main.py:2030-2135\`（GET 列表 / PATCH / DELETE，
 * POST 与 name-lookup 保留）。与 \`longtail-handlers-contract.test.ts\` 同口径：
 * \`setupServer\` + \`onUnhandledRequest:"error"\` ⇒ 拿到 200/201/204 就是"没有放行到网络"的证明；
 * 每个 describe 断言**形状**与**写操作真的改 store**（GET 立刻能读到）。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupServer } from "msw/node";

import { handlers, resetMockData } from "../handlers";

const server = setupServer(...handlers);
const ORIGIN = "http://localhost:3000";
const BASE = ORIGIN + "/api/v1";
const JSON_HEADERS = { "Content-Type": "application/json" };

beforeAll(() => {
  Object.defineProperty(globalThis, "location", {
    value: { href: ORIGIN + "/" },
    configurable: true,
  });
  server.listen({ onUnhandledRequest: "error" });
});
afterAll(() => server.close());
beforeEach(() => resetMockData());

interface Row {
  id: number;
  category_id: number | null;
  region_code: string;
  lang: string;
  local_name: string;
  alt_names: string[];
  hs_code: string | null;
  is_verified: boolean;
  source: string;
  created_at: string;
}

interface Page {
  items: Row[];
  total: number;
  page: number;
  page_size: number;
}

async function getJson<T>(path: string): Promise<{ status: number; body: T }> {
  const res = await fetch(BASE + path);
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

async function sendJson<T>(
  path: string,
  method: "POST" | "PATCH" | "DELETE",
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const res = await fetch(BASE + path, {
    method,
    headers: JSON_HEADERS,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

async function create(overrides: Record<string, unknown> = {}) {
  const res = await sendJson<Row>("/market/name-mappings", "POST", {
    region_code: "FR",
    lang: "zh",
    local_name: "勾花网",
    ...overrides,
  });
  expect(res.status).toBe(201);
  return res.body;
}

describe("GET /market/name-mappings（分页 + 筛选；main.py:2030-2070）", () => {
  it("空 q → 返回最近记录（种子 2 条，verified/created_at 倒序）", async () => {
    const res = await getJson<Page>("/market/name-mappings");
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.page).toBe(1);
    expect(res.body.page_size).toBe(20);
    expect(res.body.items.map((r) => r.id)).toEqual([1, 2]);
    expect(res.body.items[0]!.local_name).toBe("Doppelstabmattenzaun");
    // 行形状：POST 契约字段齐全（前端表格要 hs_code/alt_names/is_verified）
    expect(res.body.items[0]).toMatchObject({
      region_code: "DE-NW",
      lang: "de",
      alt_names: ["Doppelstabzaun", "Stabmatte"],
      hs_code: "7314490000",
      is_verified: true,
    });
  });

  it("分页：page/page_size 透传，total 是过滤后总数（不是本页条数）", async () => {
    const page2 = await getJson<Page>(
      "/market/name-mappings?page=2&page_size=1",
    );
    expect(page2.body.total).toBe(2);
    expect(page2.body.page).toBe(2);
    expect(page2.body.page_size).toBe(1);
    expect(page2.body.items).toHaveLength(1);
    expect(page2.body.items[0]!.id).toBe(2);
  });

  it("q 命中品名或别名（ILIKE）；region_code 大小写不敏感；lang 精确", async () => {
    const byName = await getJson<Page>("/market/name-mappings?q=chain");
    expect(byName.body.total).toBe(1);
    expect(byName.body.items[0]!.id).toBe(2);

    const byAlias = await getJson<Page>("/market/name-mappings?q=Cyclone");
    expect(byAlias.body.items.map((r) => r.id)).toEqual([2]);

    const byRegion = await getJson<Page>(
      "/market/name-mappings?region_code=de-nw",
    );
    expect(byRegion.body.items.map((r) => r.id)).toEqual([1]);

    const byLang = await getJson<Page>("/market/name-mappings?lang=de");
    expect(byLang.body.items.map((r) => r.id)).toEqual([1]);

    const noHit = await getJson<Page>(
      "/market/name-mappings?q=nothing-matches",
    );
    expect(noHit.body.total).toBe(0);
    expect(noHit.body.items).toEqual([]);
  });

  it("写库与列表共用 store：POST 的行立刻能被 GET / q / name-lookup 命中", async () => {
    const created = await create({
      local_name: "grillage soudé",
      is_verified: true,
    });
    const all = await getJson<Page>("/market/name-mappings");
    expect(all.body.total).toBe(3);
    // 排序 is_verified DESC, created_at DESC：新行 verified + 最新 ⇒ 排最前
    expect(all.body.items[0]!.id).toBe(created.id);

    const searched = await getJson<Page>("/market/name-mappings?q=grillage");
    expect(searched.body.items.map((r) => r.id)).toEqual([created.id]);

    // name-lookup 也读同一个 store（旧实现只读静态种子，刚建的对对照搜不到）
    const lookup = await getJson<Row[]>("/market/name-lookup?q=grillage");
    expect(lookup.body.map((r) => r.id)).toEqual([created.id]);
    const noQuery = await getJson<unknown>("/market/name-lookup");
    expect(noQuery.status).toBe(422);
  });
});

describe("POST /market/name-mappings（契约不变）", () => {
  it("缺 region_code/lang/local_name → 422；同 (category, region, lang) → 409", async () => {
    const missing = await sendJson<unknown>("/market/name-mappings", "POST", {
      region_code: "FR",
    });
    expect(missing.status).toBe(422);

    await create({ category_id: 3, region_code: "DE", lang: "zh" });
    const conflict = await sendJson<unknown>("/market/name-mappings", "POST", {
      category_id: 3,
      region_code: "de",
      lang: "zh",
      local_name: "另一条",
    });
    expect(conflict.status).toBe(409);
  });
});

describe("PATCH /market/name-mappings/{id}（部分字段；main.py:2072-2120）", () => {
  it("改部分字段 → 返回更新后行，GET 立刻读到；未传字段不变", async () => {
    const patched = await sendJson<Row>("/market/name-mappings/2", "PATCH", {
      local_name: "chain link fence pro",
      is_verified: false,
    });
    expect(patched.status).toBe(200);
    expect(patched.body.local_name).toBe("chain link fence pro");
    expect(patched.body.is_verified).toBe(false);
    expect(patched.body.region_code).toBe("US-CA"); // 未传不变
    expect(patched.body.alt_names).toEqual(["cyclone fence", "wire fence"]);

    const list = await getJson<Page>("/market/name-mappings?q=pro");
    expect(list.body.items.map((r) => r.id)).toEqual([2]);
  });

  it('空 body → 422（对齐后端 "No fields to update"）', async () => {
    const res = await sendJson<{ detail: string }>(
      "/market/name-mappings/2",
      "PATCH",
      {},
    );
    expect(res.status).toBe(422);
    expect(res.body.detail).toBe("No fields to update");
  });

  it("不存在 → 404 NAME_MAPPING_NOT_FOUND", async () => {
    const res = await sendJson<{ detail: { code: string } }>(
      "/market/name-mappings/999",
      "PATCH",
      { local_name: "x" },
    );
    expect(res.status).toBe(404);
    expect(res.body.detail.code).toBe("NAME_MAPPING_NOT_FOUND");
  });

  it("唯一键冲突 → 409 NAME_MAPPING_EXISTS（category_id 非空时）", async () => {
    await create({ category_id: 3, region_code: "DE", lang: "zh" });
    const second = await create({
      category_id: 4,
      region_code: "DE",
      lang: "zh",
    });
    const res = await sendJson<{ detail: { code: string } }>(
      "/market/name-mappings/" + second.id,
      "PATCH",
      { category_id: 3 },
    );
    expect(res.status).toBe(409);
    expect(res.body.detail.code).toBe("NAME_MAPPING_EXISTS");
  });
});

describe("DELETE /market/name-mappings/{id}（main.py:2121-2135）", () => {
  it("删除 → 204，列表 total 减少；再删 → 404", async () => {
    const res = await sendJson<null>("/market/name-mappings/1", "DELETE");
    expect(res.status).toBe(204);
    expect(res.body).toBeNull();

    const list = await getJson<Page>("/market/name-mappings");
    expect(list.body.total).toBe(1);
    expect(list.body.items.map((r) => r.id)).toEqual([2]);

    const again = await sendJson<{ detail: { code: string } }>(
      "/market/name-mappings/1",
      "DELETE",
    );
    expect(again.status).toBe(404);
    expect(again.body.detail.code).toBe("NAME_MAPPING_NOT_FOUND");
  });

  it("resetMockData() 回种子（删掉的种子行会回来）", async () => {
    await sendJson<null>("/market/name-mappings/1", "DELETE");
    resetMockData();
    const list = await getJson<Page>("/market/name-mappings");
    expect(list.body.total).toBe(2);
    expect(list.body.items.map((r) => r.id)).toEqual([1, 2]);
  });
});
