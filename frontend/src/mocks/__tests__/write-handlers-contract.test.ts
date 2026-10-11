/**
 * task-6 回归测试：5 个**写操作 handler** 必须被 MSW 接住，**不再放行到网络**。
 *
 * 为什么"被接住"这件事本身就是要断言的核心：
 *   这三个客户的写接口原先**没有 handler** ⇒ MSW 按 `onUnhandledRequest` 放行 ⇒
 *   e2e（playwright.config.ts:41/54，MODE=mock 且 API_BASE 指回页面源）下命中
 *   Next 的 `/api/v1/*` rewrite ⇒ **自己代理自己** ⇒ 请求永不结束
 *   （msw-provider.tsx:49-53 记录的那个坑）。
 *   本文件用 `setupServer` + `onUnhandledRequest: "error"`：**只要有一个端点没 handler，
 *   请求就会以 "Cannot bypass a request when using the error strategy" 失败** ——
 *   所以"拿到 201/200"就是"没有放行到网络"的证明。修复前本文件必然失败。
 *
 * 第二个断言目标是**写操作真的改了数据**（要求 3）：建完客户能在列表/详情看到，
 * 加完联系人/询盘能在详情看到，改完阶段列表跟着变。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupServer } from "msw/node";

import { handlers, resetMockData } from "../handlers";

const server = setupServer(...handlers);
// handlers 用相对路径，MSW 按当前 origin 解析；jsdom 默认 origin 是 localhost:3000
const BASE = "http://localhost:3000/api/v1";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
// module-scoped store 在用例间共享：不重置会被"上一个用例建的客户"污染
beforeEach(() => resetMockData());

const JSON_HEADERS = { "Content-Type": "application/json" };

function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
}

function patch(path: string, body: unknown): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
}

type CustomerRow = {
  id: number;
  company_name: string;
  stage: string;
  created_at: string;
  updated_at: string;
  contacts: Array<{ id: number; name: string; is_primary: boolean }>;
  inquiries: Array<{ id: number; customer_id: number; status: string }>;
  stage_log: Array<{ id: number; from_stage: string | null; to_stage: string }>;
};

type CustomerList = { items: CustomerRow[]; total: number };

describe("POST /api/v1/customers ← page.tsx:169-182（CustomerForm）", () => {
  it("201 + row_to_customer 形状，且列表/详情真的看得到", async () => {
    const res = await post("/customers", {
      company_name: "新客户 C",
      country: "DE",
      address: "",
      default_port: "Hamburg",
      credit_level: "C",
      stage: "lead",
      notes: "",
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as CustomerRow;
    expect(typeof created.id).toBe("number");
    expect(created.company_name).toBe("新客户 C");
    expect(created.stage).toBe("lead");
    expect(Number.isNaN(new Date(created.updated_at).getTime())).toBe(false);

    // 列表：总量 +1，且新客户因 updated_at desc 排在最前
    const list = (await (await fetch(`${BASE}/customers`)).json()) as CustomerList;
    expect(list.total).toBe(3);
    expect(list.items[0]!.company_name).toBe("新客户 C");

    // 详情：新客户的子资源是空数组（不是 undefined），并有一条"新建客户"流水
    const detail = (await (
      await fetch(`${BASE}/customers/${created.id}`)
    ).json()) as CustomerRow;
    expect(detail.contacts).toEqual([]);
    expect(detail.inquiries).toEqual([]);
    expect(detail.stage_log.length).toBe(1);
    expect(detail.stage_log[0]!.to_stage).toBe("lead");
  });

  it("company_name 为空 → 422（对齐后端 CustomerCreate 必填）", async () => {
    const res = await post("/customers", { company_name: "  " });
    expect(res.status).toBe(422);
  });
});

describe("PATCH /api/v1/customers/:id/stage ← page.tsx:463-478（StageUpdate）", () => {
  it("200 改阶段 + 写流水 + 回 closed_inquiries", async () => {
    const res = await patch("/customers/2/stage", {
      stage: "quoted",
      reason: "已报价",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as CustomerRow & {
      closed_inquiries: number[];
    };
    expect(body.stage).toBe("quoted");
    expect(body.closed_inquiries).toEqual([]);

    const detail = (await (
      await fetch(`${BASE}/customers/2`)
    ).json()) as CustomerRow;
    expect(detail.stage).toBe("quoted");
    expect(detail.stage_log[detail.stage_log.length - 1]!.to_stage).toBe(
      "quoted",
    );
  });

  it("阶段非法 → 422", async () => {
    const res = await patch("/customers/2/stage", { stage: "not-a-stage" });
    expect(res.status).toBe(422);
  });
});

describe("POST /api/v1/customers/:id/contacts ← page.tsx:375-395（ContactForm）", () => {
  it("201 + 联系人形状，且详情里能看到、主联系人被正确降级", async () => {
    const res = await post("/customers/1/contacts", {
      customer_id: 1,
      name: "李四",
      phone: "123",
      is_primary: true,
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as {
      id: number;
      name: string;
      position: string | null;
      phone: string | null;
      is_primary: boolean;
    };
    // 形状照后端 customers.py:426-428（无 wechat）
    expect(typeof created.id).toBe("number");
    expect(created).toMatchObject({
      name: "李四",
      position: null,
      phone: "123",
      email: null,
      whatsapp: null,
      is_primary: true,
    });

    const detail = (await (
      await fetch(`${BASE}/customers/1`)
    ).json()) as CustomerRow;
    expect(detail.contacts.length).toBe(2);
    const primaries = detail.contacts.filter((c) => c.is_primary);
    expect(primaries.length).toBe(1);
    expect(primaries[0]!.name).toBe("李四");
  });
});

describe("POST /api/v1/customers/:id/inquiries ← page.tsx:277-297（InquiryForm）", () => {
  it("201 + row_to_inquiry 形状，status=open，且 lead 客户联动进 inquiry", async () => {
    // 客户 2 的种子阶段是 lead
    const res = await post("/customers/2/inquiries", {
      customer_id: 2,
      // 渠道是**自由文本**：mock 刻意不做枚举校验（见 handlers.ts 该 handler 上方说明）
      channel: "Alibaba",
      product_name_raw: "石笼网 2.5mm",
      quantity: 500,
      quantity_unit: "卷",
      application: "河道护坡",
    });
    expect(res.status).toBe(201);
    const inq = (await res.json()) as {
      id: number;
      customer_id: number;
      channel: string | null;
      quantity: number | null;
      status: string;
    };
    expect(inq.customer_id).toBe(2);
    expect(inq.channel).toBe("Alibaba");
    expect(inq.quantity).toBe(500);
    expect(inq.status).toBe("open"); // 后端 customers.py:561

    const detail = (await (
      await fetch(`${BASE}/customers/2`)
    ).json()) as CustomerRow;
    expect(detail.inquiries.length).toBe(2);
    expect(detail.stage).toBe("inquiry"); // 后端 :567-571 的联动
  });
});

describe("POST /api/v1/auth/register ← auth-context.tsx:127-139", () => {
  it("200 + access_token + buildUser 需要的全部字段", async () => {
    const res = await post("/auth/register", {
      email: "new@kaas.local",
      password: "secret123",
      display_name: "新用户",
      company_name: "新公司",
      product_category: "fencing",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    // auth-context.tsx:130 直接把它写进会话 —— 必须是 string
    expect(typeof body.access_token).toBe("string");
    // buildUser（auth-context.tsx:55-67）逐项读取的 8 个字段
    for (const key of [
      "user_id",
      "email",
      "display_name",
      "account_type",
      "role",
      "plan",
      "team_id",
      "team_name",
      "console_access",
    ]) {
      expect(body, `缺少 buildUser 需要的字段 ${key}`).toHaveProperty(key);
    }
    // 后端强制 customer + free（auth.py:250-252）
    expect(body.account_type).toBe("customer");
    expect(body.plan).toBe("free");
    expect(body.email).toBe("new@kaas.local");
  });

  it("同一邮箱重复注册 → 409（对齐后端 auth.py:238-240）", async () => {
    const payload = {
      email: "dup@kaas.local",
      password: "secret123",
      display_name: "重复",
      company_name: "重复公司",
      product_category: "fencing",
    };
    expect((await post("/auth/register", payload)).status).toBe(200);
    expect((await post("/auth/register", payload)).status).toBe(409);
  });

  it("密码不足 8 位 → 422", async () => {
    const res = await post("/auth/register", {
      email: "short@kaas.local",
      password: "1234567",
      display_name: "短",
      company_name: "短公司",
      product_category: "fencing",
    });
    expect(res.status).toBe(422);
  });
});

describe("5 个端点一次性验证：全部被 handler 接住（无一个放行到网络）", () => {
  it("依次拿到 201/200，而不是未匹配请求的失败", async () => {
    const results = await Promise.all([
      post("/customers", { company_name: "X", stage: "lead" }),
      patch("/customers/1/stage", { stage: "negotiating" }),
      post("/customers/1/contacts", { name: "X" }),
      post("/customers/1/inquiries", { channel: "email" }),
      post("/auth/register", {
        email: "z@kaas.local",
        password: "secret123",
        display_name: "Z",
        company_name: "Z",
        product_category: "fencing",
      }),
    ]);
    expect(results.map((r) => r.status)).toEqual([201, 200, 201, 201, 200]);
  });
});
