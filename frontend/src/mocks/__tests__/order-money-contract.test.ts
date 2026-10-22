// @vitest-environment node
/**
 * 订单金额 / 收款计划 / 实收登记 / 到账截图 + 询盘多产品（设计 §13.3 · 2026-10-22）
 * MSW 契约测试 —— 形状真源 = worker main.py + 共享序列化（order_serializers /
 * customer_serializers），逐条钉住 mock 与后端口径一致，避免"mock 能演示、生产不行"。
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

async function get<T>(path: string): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`);
  return { status: res.status, body: (await res.json()) as T };
}

async function post<T>(
  path: string,
  body: unknown,
): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as T };
}

const RECEIPT_KEYS = [
  "id",
  "order_id",
  "schedule_id",
  "amount",
  "currency",
  "received_date",
  "fx_rate",
  "file_id",
  "notes",
  "created_at",
].sort();

describe("询盘多产品（设计 §5）", () => {
  it("POST 带 items：第一行同步旧字段，响应 items 完整", async () => {
    const res = await post<Json>("/customers/1/inquiries", {
      channel: "email",
      items: [
        {
          product_key: "field_fence",
          product_name_raw: "牛栏网",
          quantity: 1000,
          quantity_unit: "m",
          application: "牧场",
        },
        { product_name_raw: "勾花网", quantity: 200, quantity_unit: "m" },
      ],
    });
    expect(res.status).toBe(201);
    const items = res.body.items as Json[];
    expect(items).toHaveLength(2);
    expect(items[1]!.product_name_raw).toBe("勾花网");
    // 旧标量字段 = 第一行（旧报表/链式分析不用改）
    expect(res.body.product_name_raw).toBe("牛栏网");
    expect(res.body.quantity).toBe(1000);
  });

  it("GET 客户详情：历史询盘（items 为空）用旧字段合成一行", async () => {
    const res = await get<{ inquiries: Json[] }>("/customers/1");
    expect(res.status).toBe(200);
    for (const inquiry of res.body.inquiries) {
      const items = inquiry.items as Json[];
      expect(Array.isArray(items)).toBe(true);
      expect(items.length).toBeGreaterThan(0);
    }
  });

  it("PATCH items：同步旧字段并在列表里可见", async () => {
    const created = await post<Json>("/customers/1/inquiries", {
      items: [{ product_name_raw: "旧产品", quantity: 1 }],
    });
    const res = await fetch(`${BASE}/inquiries/${created.body.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: [{ product_name_raw: "鹿网", quantity: 3, quantity_unit: "set" }],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Json;
    expect((body.items as Json[])[0]!.product_name_raw).toBe("鹿网");
    expect(body.product_name_raw).toBe("鹿网");
    expect(body.quantity).toBe(3);
  });
});

describe("建单金额构成 + 收款计划（设计 §13.3）", () => {
  it("amount_breakdown 四项 + 30/70 计划：总额、计划金额、应收台账立即生成", async () => {
    const created = await post<Json>("/orders", {
      customer_id: 1,
      currency: "USD",
      items: [
        {
          product_name: "牛栏网",
          qty: 10,
          qty_unit: "m",
          unit_price: 1000,
        },
      ],
      amount_breakdown: {
        goods_amount: 10000,
        freight_amount: 400,
        insurance_amount: 100,
        other_amount: 100,
      },
      payment_plan: [
        { schedule_type: "deposit", ratio: 0.3 },
        { schedule_type: "balance", ratio: 0.7, notes: "发货前" },
      ],
    });
    expect(created.status).toBe(201);
    expect(created.body.total_amount).toBe(10600);
    expect(created.body.amount_breakdown).toEqual({
      goods_amount: 10000,
      freight_amount: 400,
      insurance_amount: 100,
      other_amount: 100,
    });

    const detail = await get<Json>(`/orders/${created.body.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.amount_breakdown).toEqual(created.body.amount_breakdown);
    expect((detail.body.items as Json[]).length).toBe(1);
    const schedules = detail.body.payment_schedules as Json[];
    expect(schedules).toHaveLength(2);
    expect(schedules[0]!.amount).toBe(3180);
    expect(schedules[1]!.amount).toBe(7420);
    expect(schedules[0]!.received_amount).toBe(0);
    expect(schedules[0]!.status).toBe("pending");
    expect(detail.body.receipts).toEqual([]);

    const receivables = await get<{ items: Json[] }>("/receivables?page_size=200");
    const row = receivables.body.items.find(
      (r) => r.order_id === created.body.id,
    );
    expect(row?.total_amount).toBe(10600);
    expect(row?.status).toBe("unpaid");
  });

  it("ratio 合计 > 100% ⇒ 422 PAYMENT_PLAN_RATIO_EXCEEDS 且不建单", async () => {
    const before = await get<{ total: number }>("/orders");
    const res = await post<{ detail: Json }>("/orders", {
      customer_id: 1,
      payment_plan: [
        { schedule_type: "deposit", ratio: 0.6 },
        { schedule_type: "balance", ratio: 0.6 },
      ],
    });
    expect(res.status).toBe(422);
    expect(res.body.detail.code).toBe("PAYMENT_PLAN_RATIO_EXCEEDS");
    const after = await get<{ total: number }>("/orders");
    expect(after.body.total).toBe(before.body.total);
  });
});

async function createOrderWithPlan(): Promise<Json> {
  const created = await post<Json>("/orders", {
    customer_id: 1,
    currency: "USD",
    items: [{ product_name: "牛栏网", qty: 10, unit_price: 1000 }],
    amount_breakdown: { goods_amount: 10000 },
    payment_plan: [{ schedule_type: "deposit", ratio: 0.3 }],
  });
  expect(created.status).toBe(201);
  return created.body;
}

describe("实收登记（设计 §13.3）", () => {
  it("部分收款 ⇒ 期次 partial、应收 partial；允许同一期多次", async () => {
    const order = await createOrderWithPlan();
    const detail = await get<Json>(`/orders/${order.id}`);
    const schedule = (detail.body.payment_schedules as Json[])[0]!;

    const first = await post<Json>(`/orders/${order.id}/receipts`, {
      schedule_id: schedule.id,
      amount: 1000,
      received_date: "2026-10-22",
    });
    expect(first.status).toBe(201);
    expect(Object.keys(first.body).sort()).toEqual(RECEIPT_KEYS);
    expect(first.body.schedule_id).toBe(schedule.id);

    const afterFirst = await get<Json>(`/orders/${order.id}`);
    const s1 = (afterFirst.body.payment_schedules as Json[])[0]!;
    expect(s1.status).toBe("partial");
    expect(s1.received_amount).toBe(1000);

    // 同一期再收一笔 → 期次收清 paid
    const second = await post<Json>(`/orders/${order.id}/receipts`, {
      schedule_id: schedule.id,
      amount: 2000,
      received_date: "2026-10-23",
    });
    expect(second.status).toBe(201);
    const afterSecond = await get<Json>(`/orders/${order.id}`);
    const s2 = (afterSecond.body.payment_schedules as Json[])[0]!;
    expect(s2.status).toBe("paid");
    expect(s2.received_amount).toBe(3000);
    expect((afterSecond.body.receipts as Json[]).length).toBe(2);

    const receivables = await get<{ items: Json[] }>("/receivables?page_size=200");
    const row = receivables.body.items.find((r) => r.order_id === order.id);
    expect(row?.received_amount).toBe(3000);
    expect(row?.status).toBe("partial"); // 订单总额 10000，未收清
  });

  it("schedule_id 为空 = 未分配收款：只进应收实收，不改期次", async () => {
    const order = await createOrderWithPlan();
    const res = await post<Json>(`/orders/${order.id}/receipts`, {
      amount: 500,
      received_date: "2026-10-22",
    });
    expect(res.status).toBe(201);
    expect(res.body.schedule_id).toBeNull();

    const detail = await get<Json>(`/orders/${order.id}`);
    const schedule = (detail.body.payment_schedules as Json[])[0]!;
    expect(schedule.status).toBe("pending");
    expect(schedule.received_amount).toBe(0);

    const receivables = await get<{ items: Json[] }>("/receivables?page_size=200");
    const row = receivables.body.items.find((r) => r.order_id === order.id);
    expect(row?.received_amount).toBe(500);
    expect(row?.status).toBe("partial");
  });

  it("金额/日期/期次校验与后端同码", async () => {
    const order = await createOrderWithPlan();
    const badAmount = await post<{ detail: Json }>(
      `/orders/${order.id}/receipts`,
      { amount: 0, received_date: "2026-10-22" },
    );
    expect(badAmount.status).toBe(422);
    expect(badAmount.body.detail.code).toBe("INVALID_RECEIPT_AMOUNT");

    const noDate = await post<{ detail: Json }>(
      `/orders/${order.id}/receipts`,
      { amount: 10 },
    );
    expect(noDate.status).toBe(422);
    expect(noDate.body.detail.code).toBe("RECEIVED_DATE_REQUIRED");

    const wrongSchedule = await post<{ detail: Json }>(
      `/orders/${order.id}/receipts`,
      { schedule_id: 999999, amount: 10, received_date: "2026-10-22" },
    );
    expect(wrongSchedule.status).toBe(422);
    expect(wrongSchedule.body.detail.code).toBe("SCHEDULE_NOT_IN_ORDER");
  });
});

describe("订单附件 / 到账截图（multipart）", () => {
  it("订单附件可传可列；到账截图挂到实收登记 file_id", async () => {
    const order = await createOrderWithPlan();

    const empty = await get<{ items: Json[] }>(`/orders/${order.id}/files`);
    expect(empty.body.items).toEqual([]);

    const form = new FormData();
    form.append(
      "file",
      new File([new Uint8Array([1, 2, 3])], "合同.pdf", {
        type: "application/pdf",
      }),
    );
    form.append("name", "合同 · 采购合同.pdf");
    const uploaded = await fetch(`${BASE}/orders/${order.id}/files`, {
      method: "POST",
      body: form,
    });
    expect(uploaded.status).toBe(201);
    const file = (await uploaded.json()) as Json;
    expect(file.owner_type).toBe("order");
    expect(file.kind).toBe("other");
    expect(file.name).toBe("合同 · 采购合同.pdf");

    const listed = await get<{ items: Json[] }>(`/orders/${order.id}/files`);
    expect(listed.body.items).toHaveLength(1);

    const receipt = await post<Json>(`/orders/${order.id}/receipts`, {
      amount: 100,
      received_date: "2026-10-22",
    });
    const shotForm = new FormData();
    shotForm.append(
      "file",
      new File([new Uint8Array([9, 9])], "到账.png", { type: "image/png" }),
    );
    const shot = await fetch(
      `${BASE}/payment-receipts/${receipt.body.id}/files`,
      { method: "POST", body: shotForm },
    );
    expect(shot.status).toBe(201);
    const shotFile = (await shot.json()) as Json;
    expect(shotFile.owner_type).toBe("payment_receipt");

    const receipts = await get<{ items: Json[] }>(
      `/orders/${order.id}/receipts`,
    );
    expect(receipts.body.items[0]!.file_id).toBe(shotFile.id);

    // 截图字节可回读（前端用 GET /file-objects/{id}/content 显示）
    const content = await fetch(`${BASE}/file-objects/${shotFile.id}/content`);
    expect(content.status).toBe(200);
  });
});

describe("产品工位原始 spec（mock 完整度）", () => {
  it("三个内置产品都带完整 spec（derived/numeric_inputs/packaging/hs_codes）", async () => {
    for (const key of ["chain_link", "field_fence", "deer_net"]) {
      const res = await get<{ spec: Json }>(
        `/export-quote/products/${key}/spec`,
      );
      expect(res.status).toBe(200);
      const spec = res.body.spec;
      expect(spec.key).toBe(key);
      expect(Array.isArray(spec.derived)).toBe(true);
      expect((spec.derived as Json[]).length).toBeGreaterThan(0);
      expect(Array.isArray(spec.numeric_inputs)).toBe(true);
      expect(Array.isArray(spec.hs_codes)).toBe(true);
      // packaging 可能为空数组，但键必须在（产品工位按存在判读）
      expect(Array.isArray(spec.packaging)).toBe(true);
    }
  });
});
