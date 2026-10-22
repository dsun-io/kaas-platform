// @vitest-environment node
/**
 * 外部单证 MSW 契约（建单时导入已有单证；真源 = worker/src/ws_extras.py:330-424）。
 *
 * ⚠️ 形状以生产为准：GET 列表是**裸数组**（不是 {items}）；POST 只回 {id, file_name}；
 * 下载回真实字节。mock 必须与生产同形，否则前端会在 mock 模式写成生产跑不通的代码。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupServer } from "msw/node";

import { handlers, resetMockData } from "../handlers";

const server = setupServer(...handlers);
const ORIGIN = "http://localhost:3000";
const BASE = `${ORIGIN}/api/v1`;

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

const LIST_KEYS = [
  "id", "doc_type", "file_name", "content_type", "file_size", "order_id",
  "quote_order_id", "inquiry_id", "customer_id", "status", "notes",
  "uploaded_by", "created_at",
].sort();

async function upload(fields: Record<string, string> = {}): Promise<Response> {
  const form = new FormData();
  form.append(
    "file",
    new File([new Uint8Array([1, 2, 3, 4])], "合同扫描件.pdf", {
      type: "application/pdf",
    }),
  );
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  return fetch(`${BASE}/external-docs`, { method: "POST", body: form });
}

async function list(query = ""): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${BASE}/external-docs${query}`);
  return { status: res.status, body: await res.json() };
}

describe("外部单证（external-docs）", () => {
  it("POST multipart → 201 {id, file_name}；GET 返回裸数组且键集与生产一致", async () => {
    const created = await upload({
      doc_type: "contract",
      order_id: "31",
      customer_id: "9",
      notes: "建单时导入",
    });
    expect(created.status).toBe(201);
    const posted = (await created.json()) as Json;
    expect(Object.keys(posted).sort()).toEqual(["file_name", "id"]);
    expect(posted.file_name).toBe("合同扫描件.pdf");

    const res = await list();
    expect(res.status).toBe(200);
    // ⚠️ 裸数组：前端不能写 data.items
    expect(Array.isArray(res.body)).toBe(true);
    const rows = res.body as Json[];
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]!).sort()).toEqual(LIST_KEYS);
    expect(rows[0]!.order_id).toBe(31);
    expect(rows[0]!.doc_type).toBe("contract");
    expect(rows[0]!.status).toBe("draft");
    expect(rows[0]!.file_size).toBe(4);
  });

  it("GET 按 order_id / doc_type 过滤；limit 越界 422", async () => {
    await upload({ order_id: "31", doc_type: "contract" });
    await upload({ order_id: "31", doc_type: "po" });
    await upload({ order_id: "32", doc_type: "contract" });

    const byOrder = await list("?order_id=31");
    expect((byOrder.body as Json[]).length).toBe(2);

    const byType = await list("?order_id=31&doc_type=contract");
    expect((byType.body as Json[]).length).toBe(1);
    expect((byType.body as Json[])[0]!.doc_type).toBe("contract");

    const bad = await list("?limit=501");
    expect(bad.status).toBe(422);
  });

  it("GET /{id}/download 返回真实字节 + 原 content-type", async () => {
    const created = (await (await upload()).json()) as Json;
    const res = await fetch(
      `${BASE}/external-docs/${created.id}/download`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/pdf");
    // 中文名走 RFC 5987：filename*=UTF-8''百分号编码（HTTP 头只能是 latin-1）
    const disposition = res.headers.get("content-disposition") ?? "";
    expect(disposition).toContain("filename*=UTF-8''");
    expect(decodeURIComponent(disposition.split("filename*=UTF-8''")[1]!)).toBe(
      "合同扫描件.pdf",
    );
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3, 4]),
    );

    const missing = await fetch(`${BASE}/external-docs/99999/download`);
    expect(missing.status).toBe(404);
  });

  it("PATCH ?status=issued 生效；非法 status 422；空文件 422 empty_file", async () => {
    const created = (await (await upload()).json()) as Json;
    const patched = await fetch(
      `${BASE}/external-docs/${created.id}?status=issued`,
      { method: "PATCH" },
    );
    expect(patched.status).toBe(200);
    expect(await patched.json()).toEqual({ id: created.id, status: "issued" });

    const bad = await fetch(
      `${BASE}/external-docs/${created.id}?status=oops`,
      { method: "PATCH" },
    );
    expect(bad.status).toBe(422);

    const form = new FormData();
    form.append(
      "file",
      new File([new Uint8Array([])], "empty.pdf", { type: "application/pdf" }),
    );
    const empty = await fetch(`${BASE}/external-docs`, {
      method: "POST",
      body: form,
    });
    expect(empty.status).toBe(422);
    expect(((await empty.json()) as { detail: { error: string } }).detail.error)
      .toBe("empty_file");
  });

  it("DELETE 后列表为空（204）", async () => {
    const created = (await (await upload()).json()) as Json;
    const res = await fetch(`${BASE}/external-docs/${created.id}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(204);
    expect((await list()).body).toEqual([]);
  });
});
