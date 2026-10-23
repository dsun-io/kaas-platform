// @vitest-environment node
/**
 * 历史订单导入（C29）的 **MSW 契约测试** —— mock 的 preview/commit 必须与内核
 * `imports_api.py` 同口径，否则"mock 能演示、生产导不进去"。
 *
 * 形状真源：`docs/IMPORT_ORDERS_PLAN_2026-10-23.md` §3（2026-10-23 与后端确认）：
 *   · 错误信封**嵌套**：`{"detail": {error, code, …}}`（HTTPException(detail=…) 惯例）
 *   · 422 IMPORT_HAS_ERRORS：`detail.rows = [{index, errors}]`，index **从 1 开始**
 *   · 409 IMPORT_DUPLICATE_ORDER_NO：`detail.order_nos = [原始单号…]`
 *   · 预览 200：customer / columns / rows[{index,ok,data,errors}] / summary
 *   · 提交 201：created / ids / order_nos
 *
 * 钉住的关键语义：
 *   1. 预览**零写入**（写库是提交那一步的事）；
 *   2. 有错行 ⇒ 422 且**零写入**（全有或全无）；
 *   3. 撞库 ⇒ 409 且**零写入**；
 *   4. 成功提交真的进 store（随后 GET /orders 看得到），且保住原始 order_no、
 *      `source_type='direct'`、`inquiry_id=null`、金额缺省 NULL（不伪造 0）。
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

interface PreviewRow {
  index: number;
  ok: boolean;
  data: Json | null;
  errors: string[];
}

interface PreviewBody {
  customer: { id: number; name: string | null };
  columns: string[];
  rows: PreviewRow[];
  summary: {
    total: number;
    ok: number;
    error: number;
    existing_order_nos: string[];
  };
}

interface CommitBody {
  created: number;
  ids: number[];
  order_nos: string[];
}

interface FailureBody {
  detail: Json;
}

/** 当前订单总数（`ordersStore` 是模块级 store、resetMockData 不清它 ⇒ 断言用「增量」）。 */
async function orderCount(): Promise<number> {
  const res = await fetch(`${BASE}/orders?page=1&page_size=200`);
  const body = (await res.json()) as { total: number };
  return body.total;
}

async function postPreview(
  csv: string,
  customerId: string | number = 1,
  filename = "history-orders.csv",
): Promise<{ status: number; body: PreviewBody & Partial<FailureBody> }> {
  const form = new FormData();
  form.append("file", new File([csv], filename, { type: "text/csv" }));
  form.append("customer_id", String(customerId));
  const res = await fetch(`${BASE}/imports/orders/preview`, {
    method: "POST",
    body: form,
  });
  return {
    status: res.status,
    body: (await res.json()) as PreviewBody & Partial<FailureBody>,
  };
}

async function postCommit(
  csv: string,
  customerId: string | number = 1,
  filename = "history-orders.csv",
): Promise<{ status: number; body: Json }> {
  const form = new FormData();
  form.append("file", new File([csv], filename, { type: "text/csv" }));
  form.append("customer_id", String(customerId));
  const res = await fetch(`${BASE}/imports/orders`, {
    method: "POST",
    body: form,
  });
  return { status: res.status, body: (await res.json()) as Json };
}

const HEADER = "order_no,order_date,status,currency,total_amount,notes";
const OK_CSV = [
  HEADER,
  "SO-1001,2026-05-01,completed,USD,1200.5,首批",
  "SO-1002,2026-05-03,,,,",
].join("\n");

describe("POST /imports/orders/preview", () => {
  it("正常：返回 customer/columns/rows/summary，且**零写入**", async () => {
    const before = await orderCount();
    const { status, body } = await postPreview(OK_CSV);

    expect(status).toBe(200);
    expect(body.customer).toEqual({ id: 1, name: "联佳丝网" });
    expect(body.columns).toEqual([
      "order_no",
      "order_date",
      "status",
      "currency",
      "total_amount",
      "notes",
    ]);
    expect(body.rows).toHaveLength(2);
    // 第 1 行原样：状态/币种/金额都取自 CSV
    expect(body.rows[0]).toMatchObject({
      index: 1,
      ok: true,
      errors: [],
      data: {
        order_no: "SO-1001",
        order_date: "2026-05-01",
        status: "completed",
        currency: "USD",
        total_amount: 1200.5,
        notes: "首批",
      },
    });
    // 第 2 行：缺省 status=pending / currency=USD，金额 NULL（**不伪造 0**）
    expect(body.rows[1]).toMatchObject({
      index: 2,
      ok: true,
      data: {
        order_no: "SO-1002",
        status: "pending",
        currency: "USD",
        total_amount: null,
        notes: null,
      },
    });
    expect(body.summary).toEqual({
      total: 2,
      ok: 2,
      error: 0,
      existing_order_nos: [],
    });
    // 预览不写库
    expect(await orderCount()).toBe(before);
  });

  it("坏日期 / 坏枚举 / 文件内重复：逐行 errors 可见，summary 计数正确", async () => {
    const csv = [
      HEADER,
      "SO-2001,2026-02-30,,,,",
      "SO-2002,2026-05-01,不存在的状态,USD,,",
      "SO-2002,2026-05-02,,XYZ,,",
    ].join("\n");
    const { status, body } = await postPreview(csv);

    expect(status).toBe(200);
    expect(body.rows[0]?.ok).toBe(false);
    expect(body.rows[0]?.data).toBeNull();
    expect(body.rows[0]?.errors.join(" ")).toContain("order_date 不是合法日期");
    // 文案与内核逐字一致（用户在生产上看到的就是这句）
    expect(body.rows[1]?.errors.join(" ")).toContain("status 非法：允许");
    expect(body.rows[2]?.errors.join(" ")).toContain("currency 非法：允许");
    expect(body.summary).toMatchObject({ total: 3, ok: 0, error: 3 });
  });

  it("空文件 ⇒ 422 IMPORT_EMPTY_FILE", async () => {
    const { status, body } = await postPreview("");
    expect(status).toBe(422);
    expect(body.detail).toMatchObject({
      error: "validation",
      code: "IMPORT_EMPTY_FILE",
    });
  });

  it("缺必填列 ⇒ 422 IMPORT_MISSING_COLUMNS（列出缺了哪列）", async () => {
    const { status, body } = await postPreview("order_no\nSO-1");
    expect(status).toBe(422);
    expect(body.detail).toMatchObject({
      error: "validation",
      code: "IMPORT_MISSING_COLUMNS",
      columns: ["order_date"],
    });
  });

  it("只有表头没有数据行 ⇒ 422 IMPORT_NO_ROWS（预览与提交都拒）", async () => {
    const preview = await postPreview(HEADER + "\n");
    expect(preview.status).toBe(422);
    expect(preview.body.detail).toMatchObject({
      error: "validation",
      code: "IMPORT_NO_ROWS",
    });

    const commit = await postCommit(HEADER + "\n");
    expect(commit.status).toBe(422);
    expect((commit.body as unknown as FailureBody).detail).toMatchObject({
      code: "IMPORT_NO_ROWS",
    });
  });

  it("未知列忽略但通过：preview.warnings 说明「被忽略」，不阻断导入", async () => {
    const { status, body } = await postPreview(
      "order_no,order_date,shipping_port\nSO-7001,2026-05-01,Shanghai\n",
    );
    expect(status).toBe(200);
    expect(body.columns).toEqual(["order_no", "order_date"]);
    expect((body as { warnings?: string[] }).warnings).toEqual([
      "未知列已忽略：shipping_port",
    ]);
    expect(body.summary).toMatchObject({ ok: 1, error: 0 });
  });

  it("客户不存在 ⇒ 404 CUSTOMER_NOT_FOUND", async () => {
    const { status, body } = await postPreview(OK_CSV, 999);
    expect(status).toBe(404);
    expect(body.detail).toMatchObject({
      error: "not_found",
      code: "CUSTOMER_NOT_FOUND",
    });
  });

  it("撞库单号：预览标为错误行并进 summary.existing_order_nos", async () => {
    const first = await postCommit(
      [HEADER, "SO-3001,2026-05-01,,,,"].join("\n"),
    );
    expect(first.status).toBe(201);

    const { status, body } = await postPreview(
      [HEADER, "SO-3001,2026-05-02,,,,", "SO-3002,2026-05-03,,,,"].join("\n"),
    );
    expect(status).toBe(200);
    expect(body.rows[0]?.ok).toBe(false);
    expect(body.rows[0]?.errors.join(" ")).toContain("已存在于本租户");
    expect(body.summary.existing_order_nos).toEqual(["SO-3001"]);
    expect(body.summary).toMatchObject({ total: 2, ok: 1, error: 1 });
  });
});

describe("POST /imports/orders", () => {
  it("成功：201 created/ids/order_nos，真写 store 且保住原始单号与历史补录口径", async () => {
    const before = await orderCount();
    const { status, body } = await postCommit(OK_CSV);

    expect(status).toBe(201);
    const commit = body as unknown as CommitBody;
    expect(commit.created).toBe(2);
    expect(commit.order_nos).toEqual(["SO-1001", "SO-1002"]);
    expect(commit.ids).toHaveLength(2);
    expect(new Set(commit.ids).size).toBe(2);

    expect(await orderCount()).toBe(before + 2);

    const list = (await (
      await fetch(`${BASE}/orders?page=1&page_size=200`)
    ).json()) as {
      items: Json[];
    };
    const created = list.items.find((item) => item.order_no === "SO-1001");
    expect(created).toMatchObject({
      order_no: "SO-1001",
      order_date: "2026-05-01",
      status: "completed",
      currency: "USD",
      total_amount: 1200.5,
      notes: "首批",
      customer_id: 1,
      customer_name: "联佳丝网",
      source_type: "direct",
      inquiry_id: null,
    });
    // 金额缺省 NULL，不伪造 0
    const noAmount = list.items.find((item) => item.order_no === "SO-1002");
    expect(noAmount?.total_amount).toBeNull();
  });

  it("有错行 ⇒ 422 IMPORT_HAS_ERRORS（rows index 从 1），且整批零写入", async () => {
    const before = await orderCount();
    const { status, body } = await postCommit(
      [HEADER, "SO-4001,2026-05-01,,,,", "SO-4002,不是日期,,,,"].join("\n"),
    );

    expect(status).toBe(422);
    const detail = (body as unknown as FailureBody).detail;
    expect(detail).toMatchObject({
      error: "validation",
      code: "IMPORT_HAS_ERRORS",
    });
    const rows = detail.rows as Array<{ index: number; errors: string[] }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.index).toBe(2);
    expect(rows[0]?.errors.join(" ")).toContain("order_date");
    // 全有或全无：合法的那一行也不能落库
    expect(await orderCount()).toBe(before);
  });

  it("撞库 ⇒ 409 IMPORT_DUPLICATE_ORDER_NO（order_nos 原文），整批回滚", async () => {
    const first = await postCommit(
      [HEADER, "SO-5001,2026-05-01,,,,"].join("\n"),
    );
    expect(first.status).toBe(201);
    const afterFirst = await orderCount();

    const { status, body } = await postCommit(
      [HEADER, "SO-5002,2026-05-02,,,,", "SO-5001,2026-05-03,,,,"].join("\n"),
    );
    expect(status).toBe(409);
    const detail = (body as unknown as FailureBody).detail;
    expect(detail).toMatchObject({
      error: "conflict",
      code: "IMPORT_DUPLICATE_ORDER_NO",
      order_nos: ["SO-5001"],
    });
    // 同批另一条合法行也不能落库（全批回滚）
    expect(await orderCount()).toBe(afterFirst);
  });

  it("预览零写入但提交写库：同一份 CSV 连导两次，第二次 409", async () => {
    const csv = [HEADER, "SO-6001,2026-05-01,,,,"].join("\n");
    const preview = await postPreview(csv);
    expect(preview.status).toBe(200);
    expect(preview.body.summary).toMatchObject({ ok: 1, error: 0 });

    const first = await postCommit(csv);
    expect(first.status).toBe(201);

    const second = await postCommit(csv);
    expect(second.status).toBe(409);
    expect((second.body as unknown as FailureBody).detail.order_nos).toEqual([
      "SO-6001",
    ]);
  });
});
