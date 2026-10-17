import { http, HttpResponse } from "msw";
import {
  makeEvent,
  makeTenant,
  makeFeatureFlags,
  MOCK_CUSTOMERS,
  MOCK_CAPABILITIES,
  MOCK_QUOTATIONS,
  MOCK_DEPLOYMENT_AUDITS,
  makeCapability,
  makeSyncJob,
  makeQuotation,
  makeQuoteV2Response,
  makeProductSpecsOptions,
  makeQuotableSpecs,
  normalizeCategoryCode,
} from "./data/factory";
// 工位清单取**唯一真源**，避免 mock 里再抄一份（抄了就迟早漂移）
import { SUBSCRIBABLE_WORKSTATIONS } from "@/lib/workstation/visibility";
import {
  MOCK_EXPORT_FORMULAS,
  MOCK_EXPORT_PRODUCTS,
  MOCK_EXPORT_RATE_SETS,
  MOCK_EXPORT_TERMS_TEMPLATE,
} from "./export-quote-data";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const EVENTS_LIST = Array.from({ length: 12 }, (_, i) =>
  makeEvent({
    event_type: (["audit.access", "capability.update"] as const)[i % 2],
    created_at: new Date(Date.now() - i * 3600000).toISOString(),
    sampled: i % 5 === 0,
  }),
);

// Stateful store for capabilities (supports PATCH mutations)
const capabilitiesStore = new Map<
  string,
  ReturnType<typeof makeCapability>[]
>();
capabilitiesStore.set(
  "cust-lianjia",
  JSON.parse(JSON.stringify(MOCK_CAPABILITIES["cust-lianjia"])),
);
capabilitiesStore.set(
  "cust-client-b",
  JSON.parse(JSON.stringify(MOCK_CAPABILITIES["cust-client-b"])),
);

// Stateful store for feature flags (per-tenant, persists across HMR)
//
// ⚠️ key 必须是**租户号**，不是客户号。
// 消费方 gray-release/page.tsx:39-46 拿 `GET /admin/tenants` 的 `tenant_id` 去查
// `flags?.[t.tenant_id]?.["use_v2"]`（第 45 行）；而该接口返回的是
// `lianjia` / `client-b`（见下面 /admin/tenants handler + factory.ts 的 makeTenant）。
// 后端同口径：orchestrator/app/api/admin.py:197-202 用租户号做 key 返回全量 map，
// 租户号见 tests/conftest.py:87/96（"lianjia" / "client_b"）。
// 原先这里写成 `cust-lianjia` / `cust-client-b`（客户风格的 id）→ 查不到 →
// 灰度页所有开关**恒显示 OFF**，`lianjia 的 use_v2=true` 这条种子数据等于丢了。
const defaultFlags: Record<string, Record<string, boolean>> = {
  lianjia: { use_v2: true, sampling_enabled: true },
  "client-b": { use_v2: false, sampling_enabled: true },
};
let featureFlagsStore: Record<string, Record<string, boolean>> = JSON.parse(
  JSON.stringify(defaultFlags),
);

// Test-only MSW override: forces quote API to return a specific status.
// This variable is module-scoped in the browser bundle — resets on page reload.
// Used exclusively by Playwright E2E contract tests (quote-contract-e2e.spec.ts)
// via POST /api/v1/__test/override-quote-status.
// NOT present in the real backend. NEVER used in production.
let __test_quote_status_override: string | null = null;

// ── Auth（登录态）的假身份 ────────────────────────────────────────────────
// **e2e 登录身份的唯一来源**：`e2e/global-setup.ts` 只写了 `has_token` cookie，
// 用户本身来自这里（webServer 锁定 `NEXT_PUBLIC_API_MODE=mock`）。
//
// 原先 `/auth/me` 与 `/auth/login` **没有 mock**，后果隐蔽：
//   mock 模式下拿不到用户 → `account_type` 缺失 →
//   `auth-context.tsx` 里 `?? "customer"` 把它默认成**非管理员** →
//   所有 `<RouteGuard adminOnly>` 页面渲染「您没有访问此页面的权限」。
//   表现为"一大批 e2e 失败"，而失败清单**正好等于**用 adminOnly 的 7 个页面
//   （/events、/customers、/kb、/settings、/audit-log、/admin/gray-release、/team）。
//   看着像产品缺陷，其实是夹具缺了这块。
//
// 所以这里给**平台管理员**身份（role=system_admin），e2e 才测得到管理页。
const MOCK_ADMIN_USER = {
  user_id: 1,
  email: "admin@kaas.local",
  display_name: "平台管理员",
  account_type: "internal" as const,
  role: "system_admin",
  plan: "enterprise",
  team_id: null,
  team_name: null,
  console_access: true,
};

// ── 可变数据 store（写操作必须**真的**改数据）──────────────────────────────
// 为什么要有这一层：MSW 的 handler 是模块级单例，写操作如果只回一个 201 而不落库，
// "新建客户成功"之后列表/详情还是旧的 —— 断言仍然测不出东西（task-6 要求 3）。
// 种子一律取自 factory 的 MOCK_CUSTOMERS，不在 mock 里再抄一份客户数据。
type MockCustomer = (typeof MOCK_CUSTOMERS)[number];

/** 联系人 —— 字段名照后端 customers.py:426-428（**不含** wechat：后端不收也不回） */
type MockContact = {
  id: number;
  name: string;
  position: string | null;
  phone: string | null;
  email: string | null;
  whatsapp: string | null;
  is_primary: boolean;
};

/** 询盘 —— 字段名照后端 `row_to_inquiry()`
 * （kaas_common/workstation/customer_serializers.py:30-49）。
 * 刻意**不含** `notes`：后端存了但序列化不返回（:37-49），前端也不读（page.tsx:71-81）。 */
type MockInquiry = {
  id: number;
  customer_id: number;
  lead_id: number | null;
  channel: string | null;
  category_id: number | null;
  product_name_raw: string | null;
  quantity: number | null;
  quantity_unit: string | null;
  application: string | null;
  status: string;
  created_at: string;
};

/** 阶段流水 —— 字段名照后端 customers.py:282-286 */
type MockStageLog = {
  id: number;
  from_stage: string | null;
  to_stage: string;
  reason: string | null;
  created_at: string;
};

/** 客户阶段合法值 —— 与后端 enums.py:13 `CUSTOMER_STAGE`、页面
 * `STAGE_LABELS`（page.tsx:21-29）**同值**（7 个，逐字一致），因此这里可以照后端校验。 */
const CUSTOMER_STAGES: readonly string[] = [
  "lead",
  "inquiry",
  "quoted",
  "negotiating",
  "won",
  "lost",
  "inactive",
];

let customersStore: MockCustomer[] = [];
let contactsStore = new Map<number, MockContact[]>();
let inquiriesStore = new Map<number, MockInquiry[]>();
let stageLogStore = new Map<number, MockStageLog[]>();
let registeredEmails = new Set<string>();
let nextCustomerId = 1;
let nextChildId = 1;
let nextUserId = 100;

// ── 平台账号治理 store（admin/accounts · 白名单字段照后端 _account_out）──────
// id=1 与 MOCK_ADMIN_USER 同 id —— e2e 才能测到「停用自己 → 409 SELF_PROTECT」。
// 角色字段是**映射后**的 effective_role（后端 _account_out 的口径）。
type MockAccount = {
  id: number;
  email: string;
  display_name: string | null;
  account_type: string;
  role: string;
  status: string;
  team_id: number | null;
  team_name: string | null;
  console_access: boolean;
  created_at: string;
  updated_at: string;
};

let accountsStore: MockAccount[] = [
  {
    id: 1,
    email: "admin@kaas.local",
    display_name: "平台管理员",
    account_type: "internal",
    role: "system_admin",
    status: "active",
    team_id: null,
    team_name: null,
    console_access: true,
    created_at: "2026-10-01T08:00:00.000Z",
    updated_at: "2026-10-01T08:00:00.000Z",
  },
  {
    id: 2,
    email: "ops@kaas.local",
    display_name: "运营小李",
    account_type: "internal",
    role: "customer_member",
    status: "active",
    team_id: 1,
    team_name: "默认团队",
    console_access: false,
    created_at: "2026-10-02T08:00:00.000Z",
    updated_at: "2026-10-02T08:00:00.000Z",
  },
  {
    id: 3,
    email: "buyer@client-b.com",
    display_name: "买家王经理",
    account_type: "customer",
    role: "customer_owner",
    status: "active",
    team_id: 2,
    team_name: "客户B团队",
    console_access: true,
    created_at: "2026-10-03T08:00:00.000Z",
    updated_at: "2026-10-03T08:00:00.000Z",
  },
];

/** 当前登录管理员（mock 下固定 = MOCK_ADMIN_USER），SELF_PROTECT 判定用。 */
function currentAdminActor(): { id: number } {
  return { id: MOCK_ADMIN_USER.user_id };
}

// ── 报价单 store（quote_orders + 行项 · 报价记录视图用）──────────────────────
// 行项照后端 _row_to_item 白名单；cost_breakdown 是 internal 分解快照
// （mock 的登录身份固定是 internal 管理员，直接返回；customer 剥除由后端负责）。
type MockQuoteItem = {
  id: number;
  quote_order_id: number;
  sku_id: number | null;
  product_name: string;
  spec_snapshot: Record<string, unknown> | null;
  qty: number;
  qty_unit: string;
  unit_price: number | null;
  currency: string;
  line_amount: number | null;
  sort_order: number;
  cost_breakdown: Record<string, unknown> | null;
  created_at: string;
};

type MockQuote = {
  id: number;
  quote_no: string;
  customer_id: number | null;
  customer_name: string | null;
  inquiry_id: number | null;
  status: string;
  currency: string;
  total_amount: number | null;
  created_by: string;
  created_at: string;
  items: MockQuoteItem[];
};

let quotesStore: MockQuote[] = [
  {
    id: 1,
    quote_no: "QUO-20261017-001",
    customer_id: 1,
    customer_name: "联佳丝网",
    inquiry_id: 1,
    status: "sent",
    currency: "USD",
    total_amount: 3612.36,
    created_by: "1",
    created_at: "2026-10-17T02:30:00.000Z",
    items: [
      {
        id: 11,
        quote_order_id: 1,
        sku_id: null,
        product_name: "Field Fence",
        spec_snapshot: {
          specification: "1.5m × 50m × 2.5mm",
          hs_code: "73144100",
          package: 12,
          product_key: "field_fence",
          product_name_zh: "牛栏网",
        },
        qty: 12,
        qty_unit: "ROLLS",
        unit_price: 301.03,
        currency: "USD",
        line_amount: 3612.36,
        sort_order: 0,
        cost_breakdown: {
          view: "internal",
          currency_cny_per_m2: {
            cost_pretax: 8.75,
            profit_amount: 1.2,
            quote_excl_vat: 10.1,
          },
          per_piece: { price_cny: 2100, price_fx: 301.03 },
          pieces: 12,
        },
        created_at: "2026-10-17T02:30:00.000Z",
      },
    ],
  },
];

const nowIso = () => new Date().toISOString();
const optStr = (v: unknown): string | null =>
  typeof v === "string" ? v : null;
/** 深拷贝种子，避免写操作改到 factory 里那份原始数据 */
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function seedContacts(): MockContact[] {
  return [
    {
      id: 1,
      name: "王经理",
      position: "采购经理",
      phone: "+86-138-0000-0001",
      email: "wang@example.com",
      whatsapp: null,
      is_primary: true,
    },
  ].map((c) => ({ ...c, id: nextChildId++ }));
}

function seedInquiries(customerId: number): MockInquiry[] {
  const now = Date.now();
  return [
    {
      id: nextChildId++,
      customer_id: customerId,
      lead_id: null,
      channel: "alibaba",
      category_id: null,
      product_name_raw: "牛栏网 2.5mm × 1.5m",
      quantity: 1000,
      quantity_unit: "m",
      application: "牧场围栏",
      // 已报价的询盘（不是 open）—— 详见 PATCH /stage 处关于 409 二次确认的说明
      status: "quoted",
      created_at: new Date(now - 5 * 86400000).toISOString(),
    },
  ];
}

function seedStageLog(customer: MockCustomer): MockStageLog[] {
  const now = Date.now();
  return [
    {
      id: nextChildId++,
      from_stage: null,
      to_stage: "lead",
      reason: "新建客户",
      created_at: new Date(now - 30 * 86400000).toISOString(),
    },
    {
      id: nextChildId++,
      from_stage: "lead",
      to_stage: customer.stage,
      reason: "收到询盘",
      created_at: new Date(now - 5 * 86400000).toISOString(),
    },
  ];
}

const contactsOf = (id: number): MockContact[] => {
  let list = contactsStore.get(id);
  if (!list) {
    list = [];
    contactsStore.set(id, list);
  }
  return list;
};

const inquiriesOf = (id: number): MockInquiry[] => {
  let list = inquiriesStore.get(id);
  if (!list) {
    list = [];
    inquiriesStore.set(id, list);
  }
  return list;
};

const stageLogsOf = (id: number): MockStageLog[] => {
  let list = stageLogStore.get(id);
  if (!list) {
    list = [];
    stageLogStore.set(id, list);
  }
  return list;
};

/** 客户详情响应体 —— `row_to_customer()` + 三个子资源
 * （后端形状 backend/orchestrator/app/api/customers.py:274-287；
 *  消费方 page.tsx:520 `useCustomerDetail(customer.id)`，面板读 page.tsx:565-591 / 629-740）。 */
function customerDetail(customer: MockCustomer) {
  return {
    ...customer,
    contacts: contactsOf(customer.id),
    inquiries: inquiriesOf(customer.id),
    stage_log: stageLogsOf(customer.id),
  };
}

function customerNotFound(id: unknown) {
  return HttpResponse.json(
    {
      error_code: "TENANT_NOT_FOUND",
      message: "租户配置未找到，请检查设置",
      detail: { customer_id: String(id) },
    },
    { status: 404 },
  );
}

/**
 * 把可变 store 恢复到种子状态。
 *
 * **导出只给测试用**：module-scoped 状态在同一个测试文件内跨用例共享，
 * 不重置会让"前一个用例建的客户"污染后一个用例的计数断言。
 * 浏览器里每次页面加载都会重新求值本模块（worker 重注册），所以生产路径不需要它。
 */
export function resetMockData(): void {
  nextChildId = 1;
  customersStore = clone(MOCK_CUSTOMERS);
  contactsStore = new Map();
  inquiriesStore = new Map();
  stageLogStore = new Map();
  for (const c of customersStore) {
    contactsStore.set(c.id, seedContacts());
    inquiriesStore.set(c.id, seedInquiries(c.id));
    stageLogStore.set(c.id, seedStageLog(c));
  }
  registeredEmails = new Set([MOCK_ADMIN_USER.email.toLowerCase()]);
  nextCustomerId =
    customersStore.reduce((max, c) => Math.max(max, c.id), 0) + 1;
  nextUserId = 100;
}
resetMockData();

export const handlers = [
  // ── 工位订阅快照（原先没有 mock，是**真正的**缺口）─────────────────────
  // 形状**必须**照 `lib/workstation/visibility.ts` 的 `parseMyWorkstationsPayload()`：
  //   · `workstations` 必须是数组，否则整份 payload 被当成"没读到"(null) → 放行
  //   · `has_team` 若不是 boolean → null → **被当成没有团队**
  //   · `is_admin` 为 true 时 `resolveWorkstationAccess` 直接 ok
  //
  // ⚠️ 这里踩过坑（2026-10-11）：先前返回 `{ok:true, workstations:[]}`，
  // 形状**被认识**了但 `has_team` 缺失 → 判为"没有团队" → `no-team`
  // → **所有工位路由被锁死**，e2e 从 10 failed/14 passed 掉到 22/2。
  // 教训：对 fail-open 契约，**"成功的空结果"比"失败"更糟** ——
  // 空结果把"我不知道"改写成了"我确定没有"，方向恰好相反。
  //
  // 正确做法是**如实回答**：mock 登录用户是平台管理员
  // （见 MOCK_ADMIN_USER，role=system_admin），那就回 is_admin + 有团队 + 全工位。
  http.get("/api/v1/me/workstations", () =>
    HttpResponse.json({
      workstations: [...SUBSCRIBABLE_WORKSTATIONS],
      codes: ["full_chain"],
      is_admin: true,
      has_team: true,
    }),
  ),

  // 团队：形状照后端 `_team_out`（id/name/created_by/is_admin/member_count）
  http.get("/api/v1/teams/me", () =>
    HttpResponse.json({
      team: {
        id: 1,
        name: "示例团队",
        created_by: MOCK_ADMIN_USER.user_id,
        is_admin: true,
        member_count: 1,
      },
    }),
  ),

  http.get("/api/v1/auth/me", () => HttpResponse.json(MOCK_ADMIN_USER)),
  http.post("/api/v1/auth/login", () =>
    HttpResponse.json({
      ...MOCK_ADMIN_USER,
      access_token: "mock-access-token",
      token_type: "bearer",
      expires_in: 3600,
    }),
  ),
  http.post("/api/v1/auth/logout", () => HttpResponse.json({ ok: true })),

  // ── Auth · 注册（task-6：原先缺失 ⇒ 放行到网络 ⇒ 自代理永久挂起）─────────
  // 消费方 lib/auth/auth-context.tsx:127-139 `register()`：
  //   · `res.data.access_token` 必须存在（:130 直接写进会话）
  //   · `buildUser(res.data)`（:55-67）要 user_id/email/display_name/account_type/
  //     role/plan/team_id/team_name/console_access 共 8 项
  // 后端 orchestrator/app/api/auth.py:162-281（无 status_code ⇒ 200）：
  //   `_auth_response`（:145-159）= 上面 8 项 + access_token/token_type；
  //   强制 `account_type="customer"`、`plan="free"`（:250-252）；
  //   角色 `"user"`(凭邀请码) / `"owner"`（:245）。
  // 校验口径照后端：email/password/display_name/company_name/product_category 必填
  // （:200-207）、密码 ≥8（:209-210）、邮箱重复 409（:238-240）。
  // 刻意**不**复刻的两项（都只有后端持有真源、且消费方前端已自校验）：
  //   · `product_category` 的 10 值白名单（auth.py:65-76）——前端 CATEGORIES
  //     （register/page.tsx:39-50）与之逐字一致且只能从中选；
  //   · 邀请码/团队名/工位的语义校验（要 DB）——mock 里按"给了就算"处理。
  http.post("/api/v1/auth/register", async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>;
    const email = String(body.email ?? "")
      .trim()
      .toLowerCase();
    const password = String(body.password ?? "");
    const displayName = String(body.display_name ?? "").trim();
    const companyName = String(body.company_name ?? "").trim();
    const productCategory = String(body.product_category ?? "").trim();
    if (
      !email ||
      !password ||
      !displayName ||
      !companyName ||
      !productCategory
    ) {
      return HttpResponse.json(
        {
          error_code: "VALIDATION_ERROR",
          message: "邮箱、密码、姓名、公司名称、主营类型均为必填",
          detail:
            "validation_error: email, password, display_name, company_name, product_category are required",
        },
        { status: 422 },
      );
    }
    if (password.length < 8) {
      return HttpResponse.json(
        {
          error_code: "VALIDATION_ERROR",
          message: "密码至少 8 位",
          detail: "validation_error: Password must be at least 8 characters",
        },
        { status: 422 },
      );
    }
    if (registeredEmails.has(email)) {
      // 后端 auth.py:238-240 同口径（409 conflict）
      return HttpResponse.json(
        {
          error_code: "EMAIL_ALREADY_REGISTERED",
          message: "该邮箱已注册",
          detail: "conflict: Email already registered",
        },
        { status: 409 },
      );
    }
    registeredEmails.add(email);

    const inviteToken = String(body.invite_token ?? "").trim();
    const teamName = String(body.team_name ?? "").trim();
    const userId = nextUserId++;
    const teamId = teamName ? 2 : inviteToken ? 1 : null;
    return HttpResponse.json({
      user_id: userId,
      email,
      display_name: displayName,
      account_type: "customer",
      role: inviteToken ? "user" : "owner",
      plan: "free",
      team_id: teamId,
      team_name: teamName || (inviteToken ? "示例团队" : null),
      console_access: false,
      access_token: `mock-access-token-${userId}`,
      token_type: "bearer",
    });
  }),

  // ⚠️ 同类缺口（**本任务范围外，已在回报里登记**）：`POST /auth/bootstrap-admin`
  // 同样没有 mock，消费方 lib/auth/auth-context.tsx:141-170 + app/setup-admin/page.tsx:49。
  // 不在这里顺手补：task-6 明确只列了 5 个端点，其余缺口应由 lead 统一派活（避免范围蔓延）。

  // ── Test-only MSW override endpoint ──────────────────────────────
  // Exists ONLY in frontend MSW handlers for Playwright / dev contract tests.
  // NOT implemented by the real backend. Must NEVER be used in production.
  // The override is module-scoped and resets on page reload (each test's page.goto).
  // Production build (NEXT_PUBLIC_API_MODE=real) skips MSW entirely;
  // requests to this endpoint would 404 against the real backend.
  // ──────────────────────────────────────────────────────────────────
  http.post("/api/v1/__test/override-quote-status", async ({ request }) => {
    const body = (await request.json()) as { status: string };
    if (body.status) {
      __test_quote_status_override = body.status;
    } else {
      // Empty string or falsy status resets the override
      __test_quote_status_override = null;
    }
    return HttpResponse.json({ ok: true });
  }),

  // ── Events ───────────────────────────────────────────────────────
  http.get("/api/v1/events", ({ request }) => {
    const url = new URL(request.url);
    const errorCode = url.searchParams.get("error");
    if (errorCode === "500") {
      return HttpResponse.json(
        {
          error_code: "INTERNAL_ERROR",
          message: "服务器内部错误，请稍后重试",
          detail: { source: "mock" },
        },
        { status: 500 },
      );
    }
    if (errorCode === "429") {
      return HttpResponse.json(
        { error_code: "RATE_LIMITED", message: "请求过于频繁，请稍后重试" },
        { status: 429 },
      );
    }
    const eventType = url.searchParams.get("event_type");
    const tenantId = url.searchParams.get("tenant_id");
    let filtered = EVENTS_LIST;
    if (eventType)
      filtered = filtered.filter((e) => e.event_type === eventType);
    if (tenantId) filtered = filtered.filter((e) => e.tenant_id === tenantId);
    return HttpResponse.json({
      items: filtered,
      total: filtered.length,
      page: 1,
      page_size: 20,
    });
  }),

  http.post("/api/v1/events", async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>;
    const created = makeEvent({ ...body, event_source: "frontend" } as Record<
      string,
      unknown
    >);
    return HttpResponse.json({ id: created.id }, { status: 201 });
  }),

  // ── Dashboard (matches real backend aggregation) ──────────────────
  http.get("/api/v1/dashboard/summary", ({ request }) => {
    const url = new URL(request.url);
    const range = url.searchParams.get("range") ?? "today";
    const multipliers: Record<string, number> = {
      today: 1,
      "7d": 7,
      "30d": 30,
    };
    const m = multipliers[range] ?? 1;
    return HttpResponse.json({
      range,
      quotations_total: Math.round(42 * m),
      quotations_sampled: Math.round(10 * m),
      active_customers: Math.min(Math.round(3 * m), 8),
      customers_sampled: Math.min(Math.round(2 * m), 5),
      dataset_hits: {
        L1_共通: Math.round(15 * m),
        L2_牛栏网_产品: Math.round(20 * m),
        L3_联佳丝网_牛栏网: Math.round(7 * m),
      },
      token_total: Math.round(125000 * m),
      token_sampled: Math.round(30000 * m),
      p95_latency_ms: +(320 + Math.random() * 40).toFixed(1),
      latency_sampled: Math.round(80 * m),
    });
  }),

  // ── OSS ──────────────────────────────────────────────────────────
  http.post("/api/v1/oss/presign", () => {
    return HttpResponse.json({
      presigned_url: "https://oss.example.com/upload/mock",
      key: `events/mock-${Date.now()}.json`,
    });
  }),

  // ── Customers ────────────────────────────────────────────────────
  // ⚠️ 形状必须对齐后端 `GET /customers`
  // （backend/orchestrator/app/api/customers.py:188-216）：
  //   {items:[row_to_customer...], total, page, page_size}
  // 原先返回**裸数组**，于是两个消费方都读 `data.items` 拿到 undefined：
  //   · 客户管理页 `useCustomerList`（frontend/src/app/(app)/customers/page.tsx:97-110，
  //     渲染处 page.tsx:819/823 读 `listData?.items`）→ 永远「暂无客户」0 行；
  //   · 客户选择器 `useCustomerOptions` / `useCustomerSearch`
  //     （frontend/src/lib/workstation/use-upstream.ts:110-150，消费处
  //      frontend/src/components/customer-picker.tsx:100 `list.data?.items ?? []`）
  //     → 报价/订单/单证的下拉里一个客户都选不到。
  // `q` 过滤照后端 `Customer.name.ilike("%q%")`（customers.py:203-204 + 列表页
  // 搜索框 page.tsx:102 传的 `q`）。
  http.get("/api/v1/customers", ({ request }) => {
    const url = new URL(request.url);
    const q = url.searchParams.get("q")?.trim();
    const stage = url.searchParams.get("stage");
    let filtered = [...customersStore];
    if (q) filtered = filtered.filter((c) => c.company_name.includes(q));
    // stage 过滤照后端 customers.py:205-207（页面暂未传，留作契约完整）
    if (stage) filtered = filtered.filter((c) => c.stage === stage);
    // 排序照后端 `order_by(Customer.updated_at.desc())`（customers.py:212）——
    // 刚建/刚改的客户排在最前，"写进去的东西看得见"才成立
    filtered.sort(
      (a, b) =>
        new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
    );
    // 分页参数与后端 Query(1, ge=1) / Query(20, ge=1, le=200) 同口径
    const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
    const pageSize = Math.min(
      200,
      Math.max(1, Number(url.searchParams.get("page_size")) || 20),
    );
    const start = (page - 1) * pageSize;
    const items = filtered.slice(start, start + pageSize);
    return HttpResponse.json({
      items,
      total: filtered.length,
      page,
      page_size: pageSize,
    });
  }),

  // 详情 = row_to_customer + contacts/inquiries/stage_log（见 customerDetail）。
  // 客户号按数字匹配 —— 列表项 `id` 是 number（factory.ts 的 makeCustomer）。
  http.get("/api/v1/customers/:id", ({ params }) => {
    const customer = customersStore.find((c) => c.id === Number(params.id));
    if (!customer) return customerNotFound(params.id);
    return HttpResponse.json(customerDetail(customer));
  }),

  // ── Customers · 写操作 ────────────────────────────────────────────
  // task-6：这 4 个 handler 原先**完全缺失** ⇒ MSW 放行到网络 ⇒ e2e 下命中 Next 的
  // `/api/v1/*` rewrite，而 rewrite 目标被 playwright.config.ts:54 指回页面源
  // ⇒ **自己代理自己** ⇒ 请求永久挂起（msw-provider.tsx:49-53 记录的那个坑）。
  // 依据 = 消费方源码 + 后端 handler，逐个列在下面每个 handler 上方。

  // POST /customers ← 消费方 page.tsx:169-182（CustomerForm.handleSubmit）
  //   请求体 = 表单 7 字段（company_name/country/address/default_port/credit_level/stage/notes）
  //   后端 customers.py:219-241：201 + `row_to_customer(c)`；stage 默认 "lead" 且必须过枚举
  http.post("/api/v1/customers", async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>;
    const companyName = String(body.company_name ?? "").trim();
    if (!companyName) {
      // 后端由 Pydantic `CustomerCreate.company_name: str` 拦下（customers.py:126）
      return HttpResponse.json(
        {
          error_code: "VALIDATION_ERROR",
          message: "公司名称必填",
          detail: "validation_error: company_name is required",
        },
        { status: 422 },
      );
    }
    const stage = String(body.stage ?? "lead") || "lead";
    if (!CUSTOMER_STAGES.includes(stage)) {
      // ⚠️ 这里**没有**照抄后端 INVALID_ENUM 的对象型 detail（enums.py:93-100 是
      // `{error,code,field,value,allowed}`）：消费方 `errMsg`（page.tsx:124-130）
      // 只认字符串 detail，拿到对象会原样塞进 JSX 直接崩。同一根因详见下面
      // PATCH /stage 处关于 409 的说明。
      return HttpResponse.json(
        {
          error_code: "INVALID_ENUM",
          message: "客户阶段取值非法",
          detail: `invalid_enum_value: customer_stage=${stage}`,
        },
        { status: 422 },
      );
    }
    const at = nowIso();
    const created: MockCustomer = {
      id: nextCustomerId++,
      company_name: companyName,
      country: optStr(body.country),
      address: optStr(body.address),
      default_port: optStr(body.default_port),
      credit_level: optStr(body.credit_level),
      stage,
      notes: optStr(body.notes),
      created_at: at,
      updated_at: at,
    };
    customersStore.push(created);
    contactsStore.set(created.id, []);
    inquiriesStore.set(created.id, []);
    // 后端建客户时写一条 stage_log（customers.py:239 `_log_stage(..., None, stage, "新建客户")`）
    stageLogsOf(created.id).push({
      id: nextChildId++,
      from_stage: null,
      to_stage: stage,
      reason: "新建客户",
      created_at: at,
    });
    return HttpResponse.json(created, { status: 201 });
  }),

  // PATCH /customers/:id/stage ← 消费方 page.tsx:463-478（StageUpdate，只等成功）
  //   请求体 = `{stage, reason?}`（page.tsx:467-470）
  //   后端 customers.py:333-394：200 + `{...row_to_customer, closed_inquiries:[id]}`
  //
  //   ⚠️ 已登记的前端/后端不一致（task-6 要求 2）：
  //   后端在 target ∈ {won,lost} 且名下有 `status='open'` 询盘时**首次请求回 409**
  //   （`{detail:{code:"OPEN_INQUIRIES_EXIST", open_inquiries:[...]}}`，customers.py:367-373），
  //   要求前端二次确认后带 `close_all_open` / `close_inquiry_ids` 重试；而消费方
  //   StageUpdate **从不发这两个字段**，也没有二次确认弹窗，且 `errMsg`（page.tsx:124-130）
  //   会把对象型 `detail` 渲染成 "[object Object]"。
  //   按 task-6「以消费方前端为准」⇒ mock 不回 409，直接 200，但**保留后端的数据语义**
  //   （won/lost 时把 open 询盘一并置为终态，并在响应里回 `closed_inquiries`）。
  http.patch("/api/v1/customers/:id/stage", async ({ params, request }) => {
    const customer = customersStore.find((c) => c.id === Number(params.id));
    if (!customer) return customerNotFound(params.id);
    const body = (await request.json()) as Record<string, unknown>;
    const target = String(body.stage ?? "");
    if (!CUSTOMER_STAGES.includes(target)) {
      // 同 POST /customers：detail 用字符串（消费方 errMsg 只认字符串，见 page.tsx:124-130）
      return HttpResponse.json(
        {
          error_code: "INVALID_ENUM",
          message: "客户阶段取值非法",
          detail: `invalid_enum_value: customer_stage=${target}`,
        },
        { status: 422 },
      );
    }
    const fromStage = customer.stage;
    const at = nowIso();
    const closed: number[] = [];
    if (target === "won" || target === "lost") {
      for (const inq of inquiriesOf(customer.id)) {
        if (inq.status === "open") {
          inq.status = target;
          closed.push(inq.id);
        }
      }
    }
    customer.stage = target;
    customer.updated_at = at;
    stageLogsOf(customer.id).push({
      id: nextChildId++,
      from_stage: fromStage,
      to_stage: target,
      reason: optStr(body.reason),
      created_at: at,
    });
    return HttpResponse.json({ ...customer, closed_inquiries: closed });
  }),

  // POST /customers/:id/contacts ← 消费方 page.tsx:375-395（ContactForm.handleSubmit）
  //   请求体含 `customer_id`（前端冗余传；后端从 path 取，Pydantic 忽略多余字段）
  //   后端 customers.py:399-428：201 + `{id,name,position,phone,email,whatsapp,is_primary}`；
  //   `is_primary=true` 时把该客户其它主联系人降级（customers.py:414-424）
  http.post("/api/v1/customers/:id/contacts", async ({ params, request }) => {
    const customer = customersStore.find((c) => c.id === Number(params.id));
    if (!customer) return customerNotFound(params.id);
    const body = (await request.json()) as Record<string, unknown>;
    const name = String(body.name ?? "").trim();
    if (!name) {
      // 后端 `ContactCreate.name: str` 必填（customers.py:154）
      return HttpResponse.json(
        {
          error_code: "VALIDATION_ERROR",
          message: "联系人姓名必填",
          detail: "validation_error: name is required",
        },
        { status: 422 },
      );
    }
    const list = contactsOf(customer.id);
    const contact: MockContact = {
      id: nextChildId++,
      name,
      position: optStr(body.position),
      phone: optStr(body.phone),
      email: optStr(body.email),
      whatsapp: optStr(body.whatsapp),
      is_primary: body.is_primary === true,
    };
    if (contact.is_primary) {
      for (const other of list) other.is_primary = false;
    }
    list.push(contact);
    return HttpResponse.json(contact, { status: 201 });
  }),

  // POST /customers/:id/inquiries ← 消费方 page.tsx:277-297（InquiryForm.handleSubmit）
  //   后端 customers.py:542-574：201 + `row_to_inquiry(inq)`；新询盘 status='open'（:561）；
  //   客户若还在 lead → 联动进 inquiry 阶段并写 stage_log（:567-571）
  //
  //   ⚠️ 已登记的前端/后端不一致（task-6 要求 2）：
  //   后端 `validate_enum("inquiry_channel", ...)`（customers.py:553）要求渠道 ∈
  //   `("email","whatsapp","alibaba","expo","website","other")` 且**大小写敏感**
  //   （enums.py:25 + enums.py:90），而消费方 InquiryForm 是**自由文本输入**、
  //   placeholder 还写着「渠道（Alibaba / Expo / Web）」（page.tsx:302-306）——
  //   用户照着提示填 "Alibaba" 在 real 模式会被 422 INVALID_ENUM。
  //   按 task-6「以消费方前端为准」⇒ mock **不做渠道枚举校验**，原样收下并回显。
  http.post("/api/v1/customers/:id/inquiries", async ({ params, request }) => {
    const customer = customersStore.find((c) => c.id === Number(params.id));
    if (!customer) return customerNotFound(params.id);
    const body = (await request.json()) as Record<string, unknown>;
    const at = nowIso();
    const rawQty = body.quantity;
    const inquiry: MockInquiry = {
      id: nextChildId++,
      customer_id: customer.id,
      lead_id: null,
      channel: optStr(body.channel),
      category_id: null,
      product_name_raw: optStr(body.product_name_raw),
      quantity:
        rawQty === undefined || rawQty === null || rawQty === ""
          ? null
          : Number(rawQty),
      quantity_unit: optStr(body.quantity_unit),
      application: optStr(body.application),
      status: "open",
      created_at: at,
    };
    inquiriesOf(customer.id).push(inquiry);
    // 询盘驱动客户（后端 customers.py:567-571）
    if (customer.stage === "lead") {
      stageLogsOf(customer.id).push({
        id: nextChildId++,
        from_stage: "lead",
        to_stage: "inquiry",
        reason: "新建询盘 inquiry 联动",
        created_at: at,
      });
      customer.stage = "inquiry";
      customer.updated_at = at;
    }
    return HttpResponse.json(inquiry, { status: 201 });
  }),

  // ── 客户往来记录（docs/CUSTOMER_DOCUMENTS_VIEW.md §3）─────────────
  // 后端该接口尚未实现，这里按设计文档的响应形状先给一份 mock，
  // 让「客户详情 → 往来记录树」在 mock 模式下能被看到与校对。
  // 真实模式下这条 handler 不生效，请求打到后端；读不到时由
  // useCustomerRecords 降级成"暂无往来记录 / 加载失败"。
  // 注意：客户 id 已对齐后端为数字（见 MOCK_CUSTOMERS）；这里对任意 id 都返回同一棵树，
  // 只把 `customer` 节点按真实客户回填（查不到就退化成请求里的 id 文本）。
  // 为什么要回填数字 id：normalizeCustomerRecords 用 asInteger 读 `customer.id`
  // （frontend/src/lib/customer/customer-records.ts:243），字符串 id 会被判成 null。
  // 读的是可变 store：刚新建的客户也能查到（否则详情页"往来记录"会对新客户退化成 #id）。
  http.get("/api/v1/customers/:id/records", ({ params }) => {
    const customer = customersStore.find((c) => c.id === Number(params.id));
    const customerName = customer?.company_name ?? String(params.id ?? "");
    return HttpResponse.json({
      customer: { id: customer?.id ?? null, name: customerName, team_id: 1 },
      counts: { quotes: 2, orders: 2, documents: 6 },
      quotes: [
        {
          id: 4,
          quote_no: "QUO-202609-0004",
          status: "accepted",
          currency: "USD",
          total_amount: 12300,
          created_at: "2026-09-27T14:56:42Z",
          documents: [
            {
              id: 12,
              doc_no: "QUO-202609-0004",
              doc_type: "quotation",
              status: "issued",
            },
          ],
          orders: [
            {
              id: 1,
              order_no: "ORD-202609-0001",
              status: "confirmed",
              currency: "USD",
              total_amount: 12300,
              created_at: "2026-09-28T09:10:00Z",
              documents: [
                {
                  id: 3,
                  doc_no: "PI-202609-0002",
                  doc_type: "pi",
                  status: "draft",
                },
                {
                  id: 2,
                  doc_no: "CI-202609-0001",
                  doc_type: "ci",
                  status: "issued",
                },
              ],
            },
          ],
        },
        {
          id: 3,
          quote_no: "QUO-202609-0003",
          status: "draft",
          currency: "USD",
          total_amount: 8000,
          created_at: "2026-09-26T10:00:00Z",
          documents: [
            {
              id: 11,
              doc_no: "QUO-202609-0003",
              doc_type: "quotation",
              status: "draft",
            },
          ],
          orders: [],
        },
      ],
      direct: {
        orders: [
          {
            id: 9,
            order_no: "ORD-202609-0009",
            status: "shipped",
            currency: "USD",
            total_amount: 5400,
            created_at: "2026-09-20T08:00:00Z",
            documents: [
              {
                id: 21,
                doc_no: "BL-202609-0004",
                doc_type: "bl",
                status: "issued",
              },
            ],
          },
        ],
        documents: [
          {
            id: 22,
            doc_no: "PL-202609-0003",
            doc_type: "pl",
            status: "draft",
          },
        ],
      },
    });
  }),

  http.get("/api/v1/customer/:id/capabilities", ({ params }) => {
    const customerId = params.id as string;
    if (customerId === "unknown") {
      return HttpResponse.json(
        {
          error_code: "TENANT_NOT_FOUND",
          message: "租户配置未找到，请检查设置",
          detail: { tenant_id: "unknown" },
        },
        { status: 404 },
      );
    }
    const caps = capabilitiesStore.get(customerId) ?? [];
    return HttpResponse.json(caps);
  }),

  http.patch(
    "/api/v1/customer/:id/capabilities",
    async ({ params, request }) => {
      const body = (await request.json()) as {
        id: string;
        spec_constraints?: Record<string, unknown>;
        is_active?: boolean;
      };
      const customerCaps = capabilitiesStore.get(params.id as string) ?? [];
      const idx = customerCaps.findIndex((c) => c.id === body.id);
      if (idx === -1) {
        return HttpResponse.json(
          {
            error_code: "QUOTATION_NOT_FOUND",
            message: "报价记录不存在",
            detail: { capability_id: body.id },
          },
          { status: 404 },
        );
      }

      if (body.spec_constraints)
        customerCaps[idx]!.spec_constraints = body.spec_constraints;
      if (body.is_active !== undefined)
        customerCaps[idx]!.is_active = body.is_active;
      customerCaps[idx]!.updated_at = new Date().toISOString();

      const syncJob = makeSyncJob({
        id: `sync-${Date.now()}`,
        status: "pending",
      });
      return HttpResponse.json({
        capability: customerCaps[idx],
        sync_job_id: syncJob.id,
      });
    },
  ),

  // ── Sync Jobs ────────────────────────────────────────────────────
  http.get("/api/v1/sync_jobs/:id", async ({ params }) => {
    await delay(500);
    return HttpResponse.json({
      id: params.id,
      status: "done",
      created_at: new Date(Date.now() - 3000).toISOString(),
      completed_at: new Date().toISOString(),
    });
  }),

  // ── Quotations ───────────────────────────────────────────────────
  http.get("/api/v1/quotations", ({ request }) => {
    const url = new URL(request.url);
    const customerId = url.searchParams.get("customer_id");
    const productCategory = url.searchParams.get("product_category");
    let filtered = MOCK_QUOTATIONS;
    if (customerId)
      filtered = filtered.filter((q) => q.customer_id === customerId);
    if (productCategory)
      filtered = filtered.filter((q) => q.product_category === productCategory);
    filtered.sort(
      (a, b) =>
        new Date(b.effective_from).getTime() -
        new Date(a.effective_from).getTime(),
    );
    return HttpResponse.json({ items: filtered, total: filtered.length });
  }),

  http.post("/api/v1/quotations", async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>;
    const created = makeQuotation({
      ...body,
      id: `q-new-${Date.now()}`,
      quotation_id: `Q-2025-${String(Math.floor(Math.random() * 9999)).padStart(4, "0")}`,
      source: "manual",
      spec_hash: `hash-${Math.random().toString(36).slice(2, 10)}`,
      created_at: new Date().toISOString(),
      effective_from: new Date().toISOString(),
    } as Record<string, unknown>);
    MOCK_QUOTATIONS.unshift(created);
    return HttpResponse.json(
      { id: created.id, spec_hash: created.spec_hash },
      { status: 201 },
    );
  }),

  // ── Product Specs (V2 — aligned with real backend) ───────────────
  http.get("/api/v1/product-specs", ({ request }) => {
    const url = new URL(request.url);
    const category = normalizeCategoryCode(
      url.searchParams.get("product_category") || "niulanwang",
    );
    const quotable = url.searchParams.get("quotable") === "true";
    const specs = makeProductSpecsOptions({ product_category: category });
    // Return different data per category to match real backend
    if (category === "gabion") {
      return HttpResponse.json({
        product_category: "gabion",
        options: {
          product_types: [],
          wire_diameters: ["2.0x1.8", "2.5x2.0"],
          heights: [1.0, 1.5],
          mesh_widths: [],
          mesh_specs: [],
          roll_lengths: [],
          bundle_sizes: [],
        },
        accessory_categories: [],
      });
    }
    // quotable 过滤：从实际 quotable_specs 推导各字段的可用选项
    // 不允许硬编码选项，避免出现"下拉有选项但实际无成本数据"的情况
    if (quotable) {
      const qs = specs.quotable_specs as Array<Record<string, unknown>>;
      const opts = specs.options as Record<string, unknown>;
      if (qs.length === 0) {
        opts.product_types = [];
        opts.wire_diameters = [];
        opts.heights = [];
        opts.mesh_widths = [];
        opts.roll_lengths = [];
      } else {
        opts.product_types = [
          ...new Set(qs.map((s) => s.product_type).filter(Boolean)),
        ].sort() as string[];
        opts.wire_diameters = [
          ...new Set(qs.map((s) => s.wire_diameter).filter(Boolean)),
        ].sort() as string[];
        opts.heights = [
          ...new Set(qs.map((s) => s.height).filter((v) => v != null)),
        ].sort() as number[];
        opts.mesh_widths = [
          ...new Set(qs.map((s) => s.mesh_width).filter((v) => v != null)),
        ].sort() as number[];
        opts.roll_lengths = [
          ...new Set(qs.map((s) => s.roll_length).filter((v) => v != null)),
        ].sort() as number[];
      }
    }
    return HttpResponse.json(specs);
  }),

  // ── Feature Flags (per-tenant) ─────────────────────────────────────
  http.get("/api/v1/admin/feature_flag", () => {
    return HttpResponse.json({ ...featureFlagsStore });
  }),

  http.post("/api/v1/admin/feature_flag", async ({ request }) => {
    const body = (await request.json()) as {
      tenant_id: string;
      flag_key: string;
      enabled: boolean;
      reason: string;
      actor_id: string;
    };

    const tenantFlags = (featureFlagsStore[body.tenant_id] ??= {});
    const before = tenantFlags[body.flag_key] ?? false;
    tenantFlags[body.flag_key] = body.enabled;

    // Append to deployment audit store
    const auditEntry = {
      id: `da-${Date.now()}`,
      action: "feature_flag_change",
      actor_id: body.actor_id,
      resource_type: "feature_flag",
      resource_id: body.flag_key,
      tenant_id: body.tenant_id,
      flag_key: body.flag_key,
      enabled_before: before,
      enabled_after: body.enabled,
      reason: body.reason,
      timestamp: new Date().toISOString(),
    };
    MOCK_DEPLOYMENT_AUDITS.unshift(auditEntry);

    return HttpResponse.json({
      tenant_id: body.tenant_id,
      flag_name: body.flag_key,
      old_value: before,
      new_value: body.enabled,
    });
  }),

  // ── Deployment Audit ─────────────────────────────────────────────
  http.get("/api/v1/admin/deployment_audit", ({ request }) => {
    const url = new URL(request.url);
    const since = url.searchParams.get("since");
    let filtered = MOCK_DEPLOYMENT_AUDITS;
    if (since) {
      const sinceDate = new Date(since).getTime();
      filtered = filtered.filter(
        (a) => new Date(a.timestamp).getTime() >= sinceDate,
      );
    }
    // Return fields matching AuditTimeline expectations
    const items = filtered.slice(0, 200).map((a) => ({
      id: a.id,
      action: a.action ?? "feature_flag_change",
      actor_id: a.actor_id,
      resource_type: a.resource_type,
      resource_id: a.resource_id,
      flag_key: a.flag_key,
      tenant_id: a.tenant_id,
      enabled_before: a.enabled_before,
      enabled_after: a.enabled_after,
      reason: a.reason,
      timestamp: a.timestamp,
    }));
    return HttpResponse.json({
      items,
      total: items.length,
    });
  }),

  // ── Audit Log ────────────────────────────────────────────────────
  http.get("/api/v1/admin/audit-log", ({ request }) => {
    const url = new URL(request.url);
    const action = url.searchParams.get("action");
    const actorId = url.searchParams.get("actor_id");
    const resourceType = url.searchParams.get("resource_type");
    const since = url.searchParams.get("since");
    const until = url.searchParams.get("until");

    let items = [
      ...MOCK_DEPLOYMENT_AUDITS,
      {
        id: "op-1",
        action: "tenant.reload",
        actor_id: "admin-1",
        resource_type: "tenant",
        resource_id: "lianjia",
        reason: "手动刷新租户配置",
        timestamp: new Date(Date.now() - 3600000).toISOString(),
      },
      {
        id: "op-2",
        action: "capability.update",
        actor_id: "admin-1",
        resource_type: "capability",
        resource_id: "cap-001",
        reason: "更新牛栏网丝径约束范围",
        timestamp: new Date(Date.now() - 7200000).toISOString(),
      },
      {
        id: "op-3",
        action: "quotation.create",
        actor_id: "admin-1",
        resource_type: "quotation",
        resource_id: "q-new-001",
        reason: "手动录入报价 Q-2025-0011",
        timestamp: new Date(Date.now() - 14400000).toISOString(),
      },
      {
        id: "op-4",
        action: "oss.upload",
        actor_id: "system",
        resource_type: "oss",
        resource_id: "events/2025-04-01.json",
        reason: "事件归档上传至 OSS",
        timestamp: new Date(Date.now() - 86400000).toISOString(),
      },
      {
        id: "op-5",
        action: "tenant.reload",
        actor_id: "admin-1",
        resource_type: "tenant",
        resource_id: "client-b",
        reason: "新增客户 B 租户配置",
        timestamp: new Date(Date.now() - 2 * 86400000).toISOString(),
      },
    ];

    if (action) items = items.filter((e) => e.action === action);
    if (actorId) items = items.filter((e) => e.actor_id === actorId);
    if (resourceType)
      items = items.filter((e) => e.resource_type === resourceType);
    if (since) {
      const sinceDate = new Date(since).getTime();
      items = items.filter((e) => new Date(e.timestamp).getTime() >= sinceDate);
    }
    if (until) {
      const untilDate = new Date(until).getTime();
      items = items.filter((e) => new Date(e.timestamp).getTime() <= untilDate);
    }

    items.sort(
      (a, b) =>
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
    );
    return HttpResponse.json({ items, total: items.length });
  }),

  // ── Tenants / Reload ─────────────────────────────────────────────
  http.get("/api/v1/admin/tenants", () => {
    return HttpResponse.json({
      tenants: [
        makeTenant({ tenant_id: "lianjia", name: "联佳丝网", is_active: true }),
        makeTenant({
          tenant_id: "client-b",
          name: "备选客户 B",
          is_active: true,
        }),
      ],
    });
  }),

  http.post("/api/v1/admin/tenants/reload", () => {
    return HttpResponse.json({
      reloaded_count: 2,
      active_tenants: [
        {
          tenant_id: "lianjia",
          display_name: "联佳丝网",
          locale: "zh-CN",
          region: "cn-north",
        },
        {
          tenant_id: "client-b",
          display_name: "备选客户 B",
          locale: "zh-CN",
          region: "cn-south",
        },
      ],
    });
  }),

  // ── 报价单（quote_orders · 报价记录视图）──────────────────────────────────
  // 列表不返回行项（防 N+1，与后端一致）；详情才带 items。
  http.get("/api/v1/quotes", ({ request }) => {
    const url = new URL(request.url);
    const status = url.searchParams.get("status");
    let items = quotesStore.slice().sort((a, b) => b.id - a.id);
    if (status) items = items.filter((q) => q.status === status);
    return HttpResponse.json({
      items: items.map(({ items: _rows, ...q }) => ({
        ...q,
        item_count: _rows.length,
      })),
      total: items.length,
      page: 1,
      page_size: Number(url.searchParams.get("page_size")) || 50,
    });
  }),

  // 历史参考价：从报价单 store 真实聚合（同客户 + 同产品行项的单价统计）
  http.get("/api/v1/quotes/reference-price", ({ request }) => {
    const url = new URL(request.url);
    const customerId = Number(url.searchParams.get("customer_id"));
    const productName = url.searchParams.get("product_name") ?? "";
    const days = Math.min(
      Math.max(Number(url.searchParams.get("days")) || 180, 1),
      730,
    );
    const prices: number[] = [];
    let lastAt: string | null = null;
    for (const q of quotesStore) {
      if (q.customer_id !== customerId) continue;
      for (const it of q.items) {
        if (it.product_name !== productName || it.unit_price == null) continue;
        prices.push(it.unit_price);
        if (!lastAt || q.created_at > lastAt) lastAt = q.created_at;
      }
    }
    prices.sort((a, b) => a - b);
    const n = prices.length;
    const avg = n ? prices.reduce((a, b) => a + b, 0) / n : null;
    const median =
      n % 2 === 1
        ? (prices[(n - 1) / 2] ?? null)
        : n
          ? ((prices[n / 2 - 1] ?? 0) + (prices[n / 2] ?? 0)) / 2
          : null;
    return HttpResponse.json({
      customer_id: customerId,
      product_name: productName,
      days,
      spec_matched: false,
      count: n,
      avg,
      min: n ? prices[0] : null,
      max: n ? prices[n - 1] : null,
      median,
      last_at: lastAt,
    });
  }),

  http.get("/api/v1/quotes/:id", ({ params }) => {
    const quote = quotesStore.find((q) => q.id === Number(params.id));
    if (!quote) {
      return HttpResponse.json(
        { detail: { error: "not_found" } },
        { status: 404 },
      );
    }
    const { items, ...q } = quote;
    return HttpResponse.json({ ...q, item_count: items.length, items });
  }),

  // ── 平台账号治理（admin/accounts · 契约见 docs/ACCOUNT_GOVERNANCE_HANDOVER §②）──  // 写操作必须**真的**改 store：停用/恢复后列表与详情要跟着变，否则 e2e 断言失效。
  // 白名单字段照后端 _account_out：绝不含 password_hash / token。
  http.get("/api/v1/admin/accounts", ({ request }) => {
    const url = new URL(request.url);
    const limit = Math.min(
      Math.max(Number(url.searchParams.get("limit")) || 500, 1),
      1000,
    );
    const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0);
    return HttpResponse.json({
      accounts: accountsStore
        .slice()
        .sort((a, b) => a.id - b.id)
        .slice(offset, offset + limit),
      total: accountsStore.length,
    });
  }),

  http.patch("/api/v1/admin/accounts/:id", async ({ params, request }) => {
    const account = accountsStore.find((a) => a.id === Number(params.id));
    if (!account) {
      return HttpResponse.json(
        { detail: { error: "not_found" } },
        { status: 404 },
      );
    }
    const body = (await request.json()) as { status?: string };
    const target = String(body.status ?? "")
      .trim()
      .toLowerCase();
    if (target !== "active" && target !== "disabled") {
      return HttpResponse.json(
        {
          detail: {
            error: "validation_error",
            message: "status must be active|disabled",
          },
        },
        { status: 422 },
      );
    }
    // mock 口径与后端一致：SELF_PROTECT / LAST_ADMIN 均 409（e2e 才能测到这两个分支）
    const actor = currentAdminActor();
    if (target === "disabled") {
      if (account.id === actor.id) {
        return HttpResponse.json(
          { detail: { error: "conflict", code: "SELF_PROTECT" } },
          { status: 409 },
        );
      }
      if (
        account.status === "active" &&
        (account.role === "system_admin" || account.role === "admin")
      ) {
        const remaining = accountsStore.filter(
          (a) =>
            a.status === "active" &&
            (a.role === "system_admin" || a.role === "admin"),
        ).length;
        if (remaining <= 1) {
          return HttpResponse.json(
            { detail: { error: "conflict", code: "LAST_ADMIN" } },
            { status: 409 },
          );
        }
      }
    }
    account.status = target;
    account.updated_at = nowIso();
    return HttpResponse.json({ account });
  }),

  // ── 出口报价（task-11 · M1 最小集 · P0）─────────────────────────────────
  //
  // 为什么必须有这几条：它们是 `/quotes`（默认 tab = 产品报价）**首屏必然发出**的请求。
  // 没有 handler 时 MSW 按 `onUnhandledRequest:"warn"` 放行到网络
  // （msw-provider.tsx:83）⇒ 命中 Next dev 的 `/api/v1/*` rewrite
  // （playwright.config.ts:54 把 BASE_API 指回页面源）⇒ **自己代理自己**
  // ⇒ 请求永不结束（msw-provider.tsx:14-19/49-53 记录过这条链）。
  //
  // ⚠️ `formulas` **不是可选项**：`products` 一旦返回条目，
  // `quote-line-card.tsx:108-110` 的 `effectiveProduct` 就从 `""` 变成具体 key，
  // `useProductFormulas` 的 `enabled: !!productKey`（use-export-quote-calc.ts:48）随即成立
  // ⇒ **立刻发出 formulas 请求**。只补 products 会把挂死从 `products` 挪到 `formulas`。
  //
  // 形状与数值全部来自后端真源（见 `./export-quote-data.ts` 头部说明），不是手编。
  http.get("/api/v1/export-quote/products", () => {
    return HttpResponse.json({
      products: MOCK_EXPORT_PRODUCTS,
      total: MOCK_EXPORT_PRODUCTS.length,
    });
  }),

  // 消费方：`quote-line-card.tsx:110` `useProductFormulas(effectiveProduct, true)`
  //（`with_columns=true` ⇒ 请求会带 `?with_columns=true`，MSW 默认忽略 query）
  http.get(
    "/api/v1/export-quote/products/:productKey/formulas",
    ({ params }) => {
      const formulas = MOCK_EXPORT_FORMULAS[String(params.productKey)];
      if (!formulas) {
        // 与后端 `_get_product_or_404`（export_quote.py:422-429）同语义：
        // 未注册产品 404 `unknown_product` —— 不是挂死，也不是空对象
        return HttpResponse.json(
          {
            error: "unknown_product",
            message: `未注册的产品模型 '${String(params.productKey)}'`,
          },
          { status: 404 },
        );
      }
      return HttpResponse.json(formulas);
    },
  ),

  // 消费方：`quote-workbench-view.tsx:157`；渲染只读 `code` / `name`（`:616-619`）
  http.get("/api/v1/export-quote/rate-sets", () => {
    return HttpResponse.json({
      rate_sets: MOCK_EXPORT_RATE_SETS,
      total: MOCK_EXPORT_RATE_SETS.length,
    });
  }),

  // 消费方：`quote-workbench-view.tsx:158` → `:188-189`（quote_as）、`:195`（items 键）、
  // `:849-866`（ladder / items 渲染）+ `quotes/lib/terms-amortize.ts:67-83`
  //（base / quote_as / weight_field / ladder / items）
  http.get("/api/v1/export-quote/terms/template", () => {
    return HttpResponse.json(MOCK_EXPORT_TERMS_TEMPLATE);
  }),

  // ── P1（有余力才做的那一档）：客户税率档案 ────────────────────────────────
  //
  // 消费方：`use-quote-profiles.ts:31-44`（`enabled: !!productKey`）→
  // `quote-workbench-view.tsx:267,270`（`profilesQuery.data?.profiles ?? []`）。
  // **首屏不触发**（初始 `newLineDraft()` 的 productKey 为空，`quote-line-card.tsx:67`；
  // 选中产品后 `line.productKey` 才有值）⇒ 它只差"用户选一次产品"就会发出。
  //
  // 为什么这里**只回空表**：档案是**用户自己存的**数据，mock 里没有比"这个客户还
  // 没存过档案"更真实的起点；凭空造几条档案反而会让页面显示不存在的税率组合
  //（本项目对"编数据"零容忍）。空表在界面上就是"该客户暂无档案"的既有空态。
  // 形状依据：`shared/contracts/export-quote.ts:321-329`（`QuoteProfileListSchema`）。
  http.get("/api/v1/export-quote/quote-profiles", ({ request }) => {
    const productKey =
      new URL(request.url).searchParams.get("product_key") ?? "";
    return HttpResponse.json({
      scope: "own",
      product_key: productKey,
      profiles: [],
    });
  }),
];
