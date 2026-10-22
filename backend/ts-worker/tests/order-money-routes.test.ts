/**
 * 订单金额 / 收款计划 / 实收登记 / 订单附件（设计 §13.3 · 2026-10-22，TS 门面）。
 *
 * 门面只做鉴权/参数校验/SQL 直译，业务口径必须与 Python 内核一致：
 * - POST /orders：amount_breakdown 四项 + payment_plan[] 同事务建订单/行项/收款计划/应收；
 * - GET /orders/{id}：amount_breakdown + items + payment_schedules(+received_amount) + receipts；
 * - GET/POST /orders/{id}/receipts：登记后重算期次（pending/partial/paid）与应收；
 * - GET/POST /orders/{id}/files、POST /payment-receipts/{id}/files（multipart）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import app from "../src/index";
import { createToken } from "../src/session";
import { FIXED_SECRET, dbCallsContaining, resetDb, TEST_ENV, type DbRow } from "./helpers";

vi.mock("../src/db", () => import("./db-mock"));

function userRow(overrides: Partial<DbRow> = {}): DbRow {
  return {
    id: 5, email: "owner@qa.test", display_name: "Owner",
    account_type: "customer", role: "owner", status: "active",
    team_id: 7, console_access: false, plan: "free", is_tenant_admin: false,
    ...overrides,
  };
}

const CUSTOMER_ROW: DbRow = {
  id: 9, name: "Acme", company_name: "Acme", stage: "active",
  team_id: 7, owner_id: "5", owner_scope: "private",
  created_at: new Date("2026-10-01T00:00:00Z"),
  updated_at: new Date("2026-10-01T00:00:00Z"),
};

const ORDER_ROW: DbRow = {
  id: 31, order_no: "ORD-US-ACM-20261022000000", customer_id: 9,
  customer_name: "Acme", status: "pending", currency: "USD",
  total_amount: "10600", amount_breakdown: {
    goods_amount: 10000, freight_amount: 400,
    insurance_amount: 100, other_amount: 100,
  },
  order_date: null, delivery_date: null, notes: null, fx_rate: null,
  fx_rate_date: null, created_at: new Date("2026-10-22T00:00:00Z"),
  owner_id: "5", owner_scope: "private", team_id: 7,
  incoterm: null, payment_terms: null, port_of_loading: null,
  port_of_destination: null, shipping_marks: null, country_of_origin: null,
};

const SCHEDULE_ROW: DbRow = {
  id: 41, order_id: 31, trade_doc_id: null, schedule_type: "deposit",
  ratio: "0.3", amount: "3180", currency: "USD", due_date: null,
  actual_date: null, status: "pending", fx_rate: null,
  exchange_gain_loss: null, notes: null,
  created_at: new Date("2026-10-22T00:00:00Z"),
};

const RECEIPT_ROW: DbRow = {
  id: 51, order_id: 31, schedule_id: 41, amount: "1000", currency: "USD",
  received_date: new Date("2026-10-22T00:00:00Z"), fx_rate: null,
  file_id: null, notes: null, created_at: new Date("2026-10-22T02:00:00Z"),
};

const RECEIVABLE_ROW: DbRow = {
  id: 61, order_id: 31, currency: "USD", total_amount: "10600",
  fx_rate: null, fx_rate_date: null, base_currency: "CNY", base_amount: null,
  received_amount: "0", exchange_gain_loss: null, status: "unpaid",
  created_at: new Date("2026-10-22T00:00:00Z"),
};

const FILE_ROW: DbRow = {
  id: 71, tenant_id: "default", team_id: 7, owner_type: "order",
  owner_id: "31", kind: "other", media_kind: null, name: "合同 · xxx.pdf",
  storage: "inline", object_key: null, file_name: "xxx.pdf",
  content_type: "application/pdf", file_size: 3, sha256: null,
  version: 1, supersedes_id: null, is_current: true, is_primary: false,
  sort_order: 0, uploaded_by: "5", created_at: new Date("2026-10-22T00:00:00Z"),
};

async function authToken(user: DbRow = userRow()): Promise<{ token: string; user: DbRow }> {
  return { token: await createToken(user.id as number, FIXED_SECRET), user };
}

function authed(token: string, init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: {
      Authorization: "Bearer " + token,
      ...(init.headers as Record<string, string> | undefined ?? {}),
    },
  };
}

beforeEach(() => resetDb(() => []));

describe("POST /orders：金额构成 + 收款计划（同一事务）", () => {
  it("amount_breakdown 四项 + 30/70 计划 → 订单/计划/应收三处写入", async () => {
    const { token, user } = await authToken();
    resetDb((query) => {
      if (query.includes("FROM users WHERE id")) return [user];
      if (query.includes("FROM customers c WHERE")) return [CUSTOMER_ROW];
      if (query.includes("SELECT 1 FROM orders WHERE tenant_id") && query.includes("order_no")) return [];
      if (query.startsWith("INSERT INTO orders")) {
        return [{ ...ORDER_ROW, order_no: "ORD-US-ACM-20261022000000" }];
      }
      return [];
    });
    const res = await app.request("/api/v1/orders", authed(token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        customer_id: 9,
        currency: "USD",
        items: [{ product_name: "牛栏网", qty: 10, qty_unit: "m", unit_price: 1000 }],
        amount_breakdown: {
          goods_amount: 10000, freight_amount: 400,
          insurance_amount: 100, other_amount: 100,
        },
        payment_plan: [
          { schedule_type: "deposit", ratio: 0.3 },
          { schedule_type: "balance", ratio: 0.7 },
        ],
      }),
    }), TEST_ENV);

    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.total_amount).toBe(10600);
    expect(body.amount_breakdown).toEqual({
      goods_amount: 10000, freight_amount: 400,
      insurance_amount: 100, other_amount: 100,
    });

    const orderInsert = dbCallsContaining("INSERT INTO orders")[0]!;
    expect(orderInsert.query).toContain("amount_breakdown");
    expect(orderInsert.query).toContain("$20::jsonb");
    expect(JSON.parse(String(orderInsert.params[19])).freight_amount).toBe(400);
    expect(orderInsert.params).toContain(10600);

    const schedules = dbCallsContaining("INSERT INTO payment_schedules");
    expect(schedules).toHaveLength(2);
    expect(schedules[0]!.params[4]).toBe(3180); // 10600 × 0.3
    expect(schedules[1]!.params[4]).toBe(7420);

    const receivable = dbCallsContaining("INSERT INTO receivables");
    expect(receivable).toHaveLength(1);
    expect(receivable[0]!.params[3]).toBe(10600);
    expect(receivable[0]!.query).toContain("'unpaid'");
  });

  it("ratio 合计 > 100% → 422 PAYMENT_PLAN_RATIO_EXCEEDS 且不落库", async () => {
    const { token, user } = await authToken();
    resetDb((query) => {
      if (query.includes("FROM users WHERE id")) return [user];
      if (query.includes("FROM customers c WHERE")) return [CUSTOMER_ROW];
      if (query.includes("SELECT 1 FROM orders WHERE tenant_id") && query.includes("order_no")) return [];
      if (query.includes("FROM quote_orders WHERE")) return [];
      return [];
    });
    const res = await app.request("/api/v1/orders", authed(token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        customer_id: 9,
        payment_plan: [
          { schedule_type: "deposit", ratio: 0.6 },
          { schedule_type: "balance", ratio: 0.6 },
        ],
      }),
    }), TEST_ENV);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { detail: { code: string } };
    expect(body.detail.code).toBe("PAYMENT_PLAN_RATIO_EXCEEDS");
    expect(dbCallsContaining("INSERT INTO orders")).toHaveLength(0);
  });
});

describe("GET /orders/{id}：详情带 receipts 与每期 received_amount", () => {
  it("历史 paid 无 receipts 的期次按金额显示；有 receipts 的按期次合计", async () => {
    const { token, user } = await authToken();
    resetDb((query) => {
      if (query.includes("FROM users WHERE id")) return [user];
      if (query.includes("SELECT * FROM orders WHERE tenant_id")) return [ORDER_ROW];
      if (query.includes("FROM order_items")) return [];
      if (query.includes("FROM entity_links")) return [];
      if (query.includes("FROM payment_schedules")) {
        return [SCHEDULE_ROW, { ...SCHEDULE_ROW, id: 42, amount: "7420", status: "paid" }];
      }
      if (query.includes("FROM receivables")) return [RECEIVABLE_ROW];
      if (query.includes("FROM payment_receipts")) return [RECEIPT_ROW];
      return [];
    });
    const res = await app.request("/api/v1/orders/31", authed(token), TEST_ENV);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.amount_breakdown).toEqual(ORDER_ROW.amount_breakdown);
    const schedules = body.payment_schedules as Record<string, unknown>[];
    expect(schedules[0]!.received_amount).toBe(1000);
    // 历史 paid 且无 receipts ⇒ 实收按该期金额（「历史收款（无截图）」）
    expect(schedules[1]!.received_amount).toBe(7420);
    const receipts = body.receipts as Record<string, unknown>[];
    expect(receipts).toHaveLength(1);
    expect(Object.keys(receipts[0]!).sort()).toEqual([
      "amount", "created_at", "currency", "file_id", "fx_rate", "id",
      "notes", "order_id", "received_date", "schedule_id",
    ].sort());
  });
});

describe("实收登记：POST /orders/{id}/receipts 重算期次 + 应收", () => {
  it("部分收款 → 期次 partial、应收 partial", async () => {
    const { token, user } = await authToken();
    resetDb((query) => {
      if (query.includes("FROM users WHERE id")) return [user];
      if (query.includes("SELECT * FROM orders WHERE tenant_id")) return [ORDER_ROW];
      if (query.includes("SELECT 1 FROM payment_schedules")) return [{ ok: 1 }];
      if (query.startsWith("INSERT INTO payment_receipts")) return [RECEIPT_ROW];
      if (query.includes("SELECT id, amount, status FROM payment_schedules")) return [SCHEDULE_ROW];
      if (query.includes("SELECT schedule_id, amount FROM payment_receipts")) return [RECEIPT_ROW];
      if (query.includes("SELECT id, total_amount FROM receivables")) return [RECEIVABLE_ROW];
      return [];
    });
    const res = await app.request("/api/v1/orders/31/receipts", authed(token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ schedule_id: 41, amount: 1000, received_date: "2026-10-22" }),
    }), TEST_ENV);
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.schedule_id).toBe(41);
    expect(body.amount).toBe(1000);

    const statusUpdate = dbCallsContaining("UPDATE payment_schedules SET status")[0]!;
    expect(statusUpdate.params[2]).toBe("partial");
    const recvUpdate = dbCallsContaining("UPDATE receivables SET received_amount")[0]!;
    expect(recvUpdate.params[2]).toBe(1000);
    expect(recvUpdate.params[3]).toBe("partial");
  });

  it("未分配收款（无 schedule_id）只进应收；schedule_id 校验与后端同码", async () => {
    const { token, user } = await authToken();
    resetDb((query) => {
      if (query.includes("FROM users WHERE id")) return [user];
      if (query.includes("SELECT * FROM orders WHERE tenant_id")) return [ORDER_ROW];
      if (query.startsWith("INSERT INTO payment_receipts")) return [{ ...RECEIPT_ROW, schedule_id: null }];
      if (query.includes("SELECT id, amount, status FROM payment_schedules")) return [SCHEDULE_ROW];
      if (query.includes("SELECT schedule_id, amount FROM payment_receipts")) {
        return [{ ...RECEIPT_ROW, schedule_id: null, amount: "500" }];
      }
      if (query.includes("SELECT id, total_amount FROM receivables")) return [RECEIVABLE_ROW];
      return [];
    });
    const res = await app.request("/api/v1/orders/31/receipts", authed(token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount: 500, received_date: "2026-10-22" }),
    }), TEST_ENV);
    expect(res.status).toBe(201);
    expect(dbCallsContaining("UPDATE payment_schedules SET status")).toHaveLength(0);
    expect(dbCallsContaining("UPDATE receivables SET received_amount")[0]!.params[2]).toBe(500);

    const bad = await app.request("/api/v1/orders/31/receipts", authed(token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount: 0, received_date: "2026-10-22" }),
    }), TEST_ENV);
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as { detail: { code: string } }).detail.code)
      .toBe("INVALID_RECEIPT_AMOUNT");
  });
});

describe("multipart：订单附件 / 到账截图", () => {
  it("POST /orders/{id}/files（kind=other）+ GET 列表", async () => {
    const { token, user } = await authToken();
    resetDb((query) => {
      if (query.includes("FROM users WHERE id")) return [user];
      if (query.includes("SELECT * FROM orders WHERE tenant_id")) return [ORDER_ROW];
      if (query.startsWith("INSERT INTO file_objects")) return [FILE_ROW];
      if (query.includes("FROM file_objects")) return [FILE_ROW];
      return [];
    });
    const form = new FormData();
    form.append("file", new File([new Uint8Array([1, 2, 3])], "contract.pdf",
      { type: "application/pdf" }));
    form.append("name", "合同 · xxx.pdf");
    const res = await app.request("/api/v1/orders/31/files", authed(token, {
      method: "POST",
      body: form,
    }), TEST_ENV);
    expect(res.status).toBe(201);
    const file = (await res.json()) as Record<string, unknown>;
    expect(file.owner_type).toBe("order");
    expect(file.kind).toBe("other");
    const insert = dbCallsContaining("INSERT INTO file_objects")[0]!;
    expect(insert.params).toContain("order");
    expect(insert.params).toContain("31");

    const list = await app.request("/api/v1/orders/31/files", authed(token), TEST_ENV);
    expect(list.status).toBe(200);
    expect(((await list.json()) as { items: unknown[] }).items).toHaveLength(1);
  });

  it("POST /payment-receipts/{id}/files：截图挂到实收登记 file_id", async () => {
    const { token, user } = await authToken();
    resetDb((query) => {
      if (query.includes("FROM users WHERE id")) return [user];
      if (query.includes("SELECT * FROM payment_receipts WHERE tenant_id=$1 AND id=$2")) {
        return [RECEIPT_ROW];
      }
      if (query.includes("SELECT * FROM orders WHERE tenant_id")) return [ORDER_ROW];
      if (query.startsWith("INSERT INTO file_objects")) {
        return [{ ...FILE_ROW, owner_type: "payment_receipt", owner_id: "51" }];
      }
      return [];
    });
    const form = new FormData();
    form.append("file", new File([new Uint8Array([9])], "shot.png", { type: "image/png" }));
    const res = await app.request("/api/v1/payment-receipts/51/files", authed(token, {
      method: "POST",
      body: form,
    }), TEST_ENV);
    expect(res.status).toBe(201);
    const update = dbCallsContaining("UPDATE payment_receipts SET file_id")[0]!;
    expect(update.params[2]).toBe(71);
  });
});

describe("询盘多产品（TS 门面）", () => {
  it("POST /customers/{id}/inquiries：items 落库 + 第一行同步旧字段", async () => {
    const { token, user } = await authToken();
    resetDb((query) => {
      if (query.includes("FROM users WHERE id")) return [user];
      if (query.includes("FROM customers c WHERE")) return [CUSTOMER_ROW];
      if (query.includes("SELECT 1 FROM cust_inquiries WHERE tenant_id")) return [];
      if (query.includes("INSERT INTO cust_inquiries")) {
        return [{
          id: 81, customer_id: 9, inquiry_no: "INQ-US-ACM-1", lead_id: null,
          channel: "email", category_id: null, product_name_raw: "牛栏网",
          quantity: "500", quantity_unit: "m", application: "牧场",
          status: "unquoted", stage: "inquiry", created_at: new Date(),
          items: [
            { product_name_raw: "牛栏网", quantity: 500, quantity_unit: "m", application: "牧场" },
            { product_name_raw: "勾花网", quantity: 100 },
          ],
          owner_id: "5", owner_scope: "private", team_id: 7,
        }];
      }
      return [];
    });
    const res = await app.request("/api/v1/customers/9/inquiries", authed(token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channel: "email",
        items: [
          { product_name_raw: "牛栏网", quantity: 500, quantity_unit: "m", application: "牧场" },
          { product_name_raw: "勾花网", quantity: 100 },
        ],
      }),
    }), TEST_ENV);
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect((body.items as unknown[]).length).toBe(2);
    expect(body.product_name_raw).toBe("牛栏网");

    const insert = dbCallsContaining("INSERT INTO cust_inquiries")[0]!;
    expect(insert.query).toContain("items");
    const itemsParam = insert.params.find(
      (p) => typeof p === "string" && p.startsWith("[{"),
    ) as string;
    expect(JSON.parse(itemsParam)).toHaveLength(2);
  });

  it("PATCH /inquiries/{id}：items 更新 + 旧字段同步", async () => {
    const { token, user } = await authToken();
    const inquiryRow: DbRow = {
      id: 81, customer_id: 9, inquiry_no: "INQ-US-ACM-1", lead_id: null,
      channel: "email", category_id: null, product_name_raw: "旧产品",
      quantity: "1", quantity_unit: null, application: null,
      status: "unquoted", stage: "inquiry", created_at: new Date(),
      items: [], owner_id: "5", owner_scope: "private", team_id: 7,
    };
    resetDb((query) => {
      if (query.includes("FROM users WHERE id")) return [user];
      if (query.includes("SELECT * FROM cust_inquiries WHERE id")) return [inquiryRow];
      if (query.startsWith("UPDATE cust_inquiries SET")) {
        return [{
          ...inquiryRow, product_name_raw: "鹿网", quantity: "3",
          items: [{ product_name_raw: "鹿网", quantity: 3, quantity_unit: "set" }],
        }];
      }
      return [];
    });
    const res = await app.request("/api/v1/inquiries/81", authed(token, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: [{ product_name_raw: "鹿网", quantity: 3, quantity_unit: "set" }],
      }),
    }), TEST_ENV);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect((body.items as Record<string, unknown>[])[0]!.product_name_raw).toBe("鹿网");

    const update = dbCallsContaining("UPDATE cust_inquiries SET")[0]!;
    expect(update.query).toContain("items = ");
    expect(update.query).toContain("::jsonb");
    expect(update.params).toContain("鹿网");
    expect(update.params).toContain(3);
  });
});
