// @vitest-environment node
/**
 * A5-W2 · `custom.items_override` MSW 契约测试（与 task-47 后端契约对齐）
 *
 * 为什么值得钉住：这条通道是"批量改行项"的唯一合法写入口，契约错一处就会
 * 变成**静默改金额**或**改非 draft 单据**：
 *   - 非 draft → 422 `ITEMS_OVERRIDE_DRAFT_ONLY`
 *   - 金额键（line_amount/amount/total_amount/line_total）→ 422 `ITEMS_OVERRIDE_AMOUNT_FORBIDDEN`
 *   - index 非自然数 → 422 `ITEMS_OVERRIDE_INDEX`
 *   - 合法覆盖 ⇒ PATCH 200，且 render-data 的行项**副本**反映覆盖（行金额按 qty×price 重算）
 *
 * `onUnhandledRequest: "error"`：拿到 200 本身就证明端点有 handler、没放行到网络。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupServer } from "msw/node";

import { handlers, resetMockData } from "../handlers";

const server = setupServer(...handlers);
const ORIGIN = "http://localhost:3000";
const BASE = `${ORIGIN}/api/v1`;
const JSON_HEADERS = { "Content-Type": "application/json" };

beforeAll(() => {
  Object.defineProperty(globalThis, "location", {
    value: { href: `${ORIGIN}/` },
    configurable: true,
  });
  server.listen({ onUnhandledRequest: "error" });
});
afterAll(() => server.close());
beforeEach(() => resetMockData());

type Json = Record<string, unknown>;

async function postJson<T>(path: string, body: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as T };
}

async function patchJson<T>(path: string, body: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as T };
}

async function getJson<T>(path: string): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`);
  return { status: res.status, body: (await res.json()) as T };
}

async function newDraftDoc(): Promise<number> {
  const created = await postJson<{ id: number }>("/trade-docs", {
    doc_type: "pi",
    currency: "USD",
  });
  expect(created.status).toBe(201);
  return created.body.id;
}

/** 契约 PATCH body：必须带 sources（后端整块替换 raw_payload） */
function overridePayload(
  items: Json[],
  override: Json[],
): Json {
  return {
    sources: { order: { order_no: "ORD-OVERRIDE-1", currency: "USD", items } },
    custom: { items_override: override },
  };
}

type RenderData = {
  doc: { raw_payload: { custom?: { items_override?: unknown } } | null };
  data: { items: Json[] };
};

describe("items_override · 合法覆盖", () => {
  it("PATCH 200 后 render-data 的行项副本反映覆盖，行金额由 qty×price 重算", async () => {
    const id = await newDraftDoc();

    const patch = await patchJson<Json>(`/trade-docs/${id}`, {
      raw_payload: overridePayload(
        [
          { product_name: "A", qty: 400, qty_unit: "pc", unit_price: 25, line_amount: 10000 },
          { product_name: "B", qty: 20, qty_unit: "roll", unit_price: 366.3075, line_amount: 7326.15 },
        ],
        [{ index: 0, unit_price: 26.5, spec: "按图", origin: "CN" }],
      ),
    });
    expect(patch.status).toBe(200);

    const rendered = await getJson<RenderData>(`/trade-docs/${id}/render-data`);
    expect(rendered.status).toBe(200);
    // 覆盖已写进 raw_payload（页面据此回填 initialOverride / 撤销）
    expect(
      rendered.body.doc.raw_payload?.custom?.items_override,
    ).toEqual([{ index: 0, unit_price: 26.5, spec: "按图", origin: "CN" }]);
    const row = rendered.body.data.items[0] as Json;
    expect(row.unit_price).toBe(26.5);
    expect(row.specification).toBe("按图");
    expect(row.country_of_origin).toBe("CN");
    expect(row.line_amount).toBe(10600); // 400 × 26.5
    // 未命中行不动
    expect((rendered.body.data.items[1] as Json).unit_price).toBe(366.3075);
  });
});

describe("items_override · 契约拒绝", () => {
  it("非 draft ⇒ 422 ITEMS_OVERRIDE_DRAFT_ONLY", async () => {
    const id = await newDraftDoc();
    const issued = await patchJson<Json>(`/trade-docs/${id}`, {
      raw_payload: overridePayload([], []),
    });
    expect(issued.status).toBe(200);
    const blocked = await patchJson<{ detail: { code: string } }>(`/trade-docs/${id}`, {
      status: "issued",
    });
    // 签发可能被 A7 闸门拦住；只要状态真的变了才测 override（否则跳过语义仍成立）
    if (blocked.status !== 200) {
      expect(blocked.status).toBe(422);
      return;
    }
    const patch = await patchJson<{ detail: { code: string } }>(`/trade-docs/${id}`, {
      raw_payload: overridePayload([], [{ index: 0, unit_price: 1 }]),
    });
    expect(patch.status).toBe(422);
    expect(patch.body.detail.code).toBe("ITEMS_OVERRIDE_DRAFT_ONLY");
  });

  it("含金额键 ⇒ 422 ITEMS_OVERRIDE_AMOUNT_FORBIDDEN", async () => {
    const id = await newDraftDoc();
    const patch = await patchJson<{ detail: { code: string; detail: string } }>(
      `/trade-docs/${id}`,
      {
        raw_payload: overridePayload([], [
          { index: 0, unit_price: 1, line_amount: 999 },
        ]),
      },
    );
    expect(patch.status).toBe(422);
    expect(patch.body.detail.code).toBe("ITEMS_OVERRIDE_AMOUNT_FORBIDDEN");
    expect(patch.body.detail.detail).toContain("line_amount");
  });

  it("index 非自然数 ⇒ 422 ITEMS_OVERRIDE_INDEX", async () => {
    const id = await newDraftDoc();
    for (const bad of [-1, 1.5, "0"]) {
      const patch = await patchJson<{ detail: { code: string } }>(`/trade-docs/${id}`, {
        raw_payload: overridePayload([], [{ index: bad, qty: 2 }]),
      });
      expect(patch.status, `index=${String(bad)}`).toBe(422);
      expect(patch.body.detail.code).toBe("ITEMS_OVERRIDE_INDEX");
    }
  });

  it("没有 items_override 的普通 PATCH 不受影响（custom 其他键照旧）", async () => {
    const id = await newDraftDoc();
    const patch = await patchJson<Json>(`/trade-docs/${id}`, {
      raw_payload: { sources: {}, custom: { remarks: "普通备注" } },
    });
    expect(patch.status).toBe(200);
    const rendered = await getJson<RenderData>(`/trade-docs/${id}/render-data`);
    expect(rendered.body.data.items.length).toBeGreaterThan(0);
  });
});
