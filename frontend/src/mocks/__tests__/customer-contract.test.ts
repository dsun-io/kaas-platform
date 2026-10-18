/**
 * mock 契约回归测试 —— 钉住 2026-10-11 修掉的真实缺陷。
 *
 * 1) 客户（本文件主体）
 *    `GET /api/v1/customers` 原先返回**裸数组**、元素是 `{customer_id, customer_name}`；
 *    而页面契约是 `{items:[{id, company_name, ...}]}`（后端 backend/orchestrator/app/api/
 *    customers.py:215 的 `{items, total}`）。后果是 mock 模式下客户列表恒为 0 行，
 *    客户选择器也一个候选都没有。
 * 2) 灰度开关
 *    `GET /api/v1/admin/feature_flag` 的 key 原先写成客户风格 id
 *    （`cust-lianjia`/`cust-client-b`），而消费方按 `tenant_id`
 *    （`lianjia`/`client-b`）查 → 灰度页开关恒显示 OFF。
 *
 * 这里用**同一份 handlers**（浏览器 worker 用的就是它）跑 MSW node server，
 * 断言响应形状 + 页面实际用到的字段，而不是断言实现细节。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupServer } from "msw/node";

import { handlers } from "../handlers";

const server = setupServer(...handlers);
// handlers 里写的是相对路径（`/api/v1/...`），MSW 按**当前 origin** 解析 —
// jsdom 的默认 origin 是 http://localhost:3000，所以这里必须用同一个 origin。
const BASE = "http://localhost:3000/api/v1";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());

/** 页面 `Customer`（src/app/(app)/customers/page.tsx:48-59）里渲染时要用的字段 */
type CustomerRow = {
  id: number;
  company_name: string;
  country: string | null;
  default_port: string | null;
  stage: string;
  updated_at: string;
};

type CustomerList = {
  items: CustomerRow[];
  total: number;
  page: number;
  page_size: number;
};

describe("mock GET /api/v1/customers（页面: page.tsx:819/823；选择器: customer-picker.tsx:100）", () => {
  it("返回分页对象而不是裸数组，且字段名与页面一致", async () => {
    const res = await fetch(`${BASE}/customers`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as CustomerList;

    // 裸数组时代这里会是 undefined —— 正是"0 行"的根因
    expect(Array.isArray(body)).toBe(false);
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBeGreaterThanOrEqual(1);
    expect(body.total).toBe(body.items.length);

    for (const c of body.items) {
      expect(typeof c.id).toBe("number"); // 数字主键：直接拼进 /customers/{id}
      expect(typeof c.company_name).toBe("string");
      expect(typeof c.stage).toBe("string");
      // 页面渲染 `new Date(c.updated_at).toLocaleDateString()`，必须是可解析的日期串
      expect(Number.isNaN(new Date(c.updated_at).getTime())).toBe(false);
    }
  });

  it("q 过滤照后端 ilike（customers.py:203-204）", async () => {
    const hit = (await (
      await fetch(`${BASE}/customers?q=${encodeURIComponent("联佳")}`)
    ).json()) as CustomerList;
    expect(hit.items.length).toBe(1);
    expect(hit.items[0]!.company_name).toContain("联佳");

    const miss = (await (
      await fetch(`${BASE}/customers?q=${encodeURIComponent("不存在的客户")}`)
    ).json()) as CustomerList;
    expect(miss.items).toEqual([]);
    expect(miss.total).toBe(0);
  });

  it("分页参数按后端 Query 口径回显", async () => {
    const body = (await (
      await fetch(`${BASE}/customers?page=1&page_size=1`)
    ).json()) as CustomerList;
    expect(body.page).toBe(1);
    expect(body.page_size).toBe(1);
    expect(body.items.length).toBe(1);
    expect(body.total).toBe(2);
  });
});

describe("mock GET /api/v1/customers/:id（页面: page.tsx:520-757）", () => {
  it("详情 = row_to_customer + contacts/inquiries/stage_log", async () => {
    const res = await fetch(`${BASE}/customers/1`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as CustomerRow & {
      contacts: Array<{ id: number; name: string; is_primary: boolean }>;
      inquiries: Array<{ id: number; customer_id: number; status: string }>;
      stage_log: Array<{ id: number; to_stage: string }>;
    };

    expect(body.id).toBe(1);
    expect(body.company_name).toBe("联佳丝网");
    // 面板信息页读这四项（page.tsx:565-591）
    expect(typeof body.country).toBe("string");
    expect(typeof body.default_port).toBe("string");
    expect(typeof body.stage).toBe("string");
    // 面板的 tab 计数与列表都读数组，不能是 undefined
    expect(body.contacts.length).toBeGreaterThanOrEqual(1);
    expect(body.inquiries.length).toBeGreaterThanOrEqual(1);
    expect(body.stage_log.length).toBeGreaterThanOrEqual(1);
    expect(body.inquiries[0]!.customer_id).toBe(1);
  });

  it("不存在的客户号回 404", async () => {
    const res = await fetch(`${BASE}/customers/9999`);
    expect(res.status).toBe(404);
  });
});

describe("mock GET /api/v1/customers/:id/records（normalizeCustomerRecords）", () => {
  it("customer.id 是数字，normalizeCustomerRecords 才能读出 id", async () => {
    const body = (await (await fetch(`${BASE}/customers/1/records`)).json()) as {
      customer: { id: number | null; name: string };
      quotes: unknown[];
    };
    expect(body.customer.id).toBe(1);
    expect(body.customer.name).toBe("联佳丝网");
    // customer-records.ts:243 `customerId: asInteger(customerRaw.id)`；
    // 修复前 mock 给的是字符串 "1"，会被判成 null
    expect(Number.isInteger(body.customer.id)).toBe(true);
  });
});

describe("mock 客户写操作（2026-10-18：新建 / 编辑 / 阶段 / 删除）", () => {
  it("新建 → 编辑 → 手改阶段 → 删除 全链路形状对齐后端", async () => {
    const created = await (
      await fetch(`${BASE}/customers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ company_name: "契约测试客户", stage: "active" }),
      })
    ).json();
    expect(created.stage).toBe("active");
    expect(created.manual_stage).toBe("active");
    const id = created.id as number;

    // 编辑档案（PATCH /customers/:id）—— 不含 stage
    const edited = await (
      await fetch(`${BASE}/customers/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ company_name: "契约测试客户（改名）", country: "DE" }),
      })
    ).json();
    expect(edited.company_name).toBe("契约测试客户（改名）");
    expect(edited.country).toBe("DE");
    // 档案编辑不改阶段
    expect(edited.manual_stage).toBe("active");

    // 手动阶段：只有活跃 / 沉寂
    const staged = await (
      await fetch(`${BASE}/customers/${id}/stage`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stage: "inactive" }),
      })
    ).json();
    expect(staged.stage).toBe("inactive");
    expect(staged.manual_stage).toBe("inactive");

    // 已下单是推导值，不允许手写
    const bad = await fetch(`${BASE}/customers/${id}/stage`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stage: "ordered" }),
    });
    expect(bad.status).toBe(422);

    // 删除：列表里消失
    const del = await fetch(`${BASE}/customers/${id}`, { method: "DELETE" });
    expect(del.status).toBe(204);
    const list = (await (await fetch(`${BASE}/customers`)).json()) as CustomerList;
    expect(list.items.some((c) => c.id === id)).toBe(false);
  });

  it("客户阶段下拉的 key 只能是 active / inactive（页面 STAGE_LABELS 同值）", async () => {
    const flags = (await (
      await fetch(`${BASE}/enums`)
    ).json()) as Record<string, string[]>;
    expect(flags.customer_stage).toEqual(["active", "inactive", "ordered"]);
  });
});

describe("mock 灰度开关按**租户号**做 key（gray-release/page.tsx:39-46）", () => {
  it("每个租户都能在 feature_flag map 里查到自己的开关", async () => {
    const tenants = (await (await fetch(`${BASE}/admin/tenants`)).json()) as {
      tenants: Array<{ tenant_id: string; name: string }>;
    };
    const flags = (await (
      await fetch(`${BASE}/admin/feature_flag`)
    ).json()) as Record<string, Record<string, boolean>>;

    expect(tenants.tenants.length).toBeGreaterThanOrEqual(1);
    for (const t of tenants.tenants) {
      // 修复前 key 是 "cust-lianjia"/"cust-client-b" → 这里查出来是 undefined
      // → 灰度页 `flags?.[t.tenant_id]?.["use_v2"] ?? false` 恒为 OFF
      expect(flags[t.tenant_id]).toBeDefined();
    }
    // 种子意图：lianjia 的 use_v2 是开的（后端 tests/conftest.py:93 同值）
    expect(flags["lianjia"]?.use_v2).toBe(true);
  });
});
