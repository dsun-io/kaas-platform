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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 客户详情响应体 —— `row_to_customer()` + 三个子资源。
 *
 * 后端形状：backend/orchestrator/app/api/customers.py:274-287
 *   `{...row_to_customer(c), contacts, inquiries, stage_log}`
 *   · contacts 字段名见 customers.py:276-280（id/name/position/phone/email/whatsapp/is_primary）
 *   · inquiries 见 customer_serializers.row_to_inquiry()（id/customer_id/lead_id/channel/
 *     category_id/product_name_raw/quantity/quantity_unit/application/status/created_at）
 *   · stage_log 见 customers.py:282-286（id/from_stage/to_stage/reason/created_at）
 *
 * 消费方：frontend/src/app/(app)/customers/page.tsx:520 `useCustomerDetail(customer.id)`，
 * 面板在 page.tsx:565-591 读 country/credit_level/address/default_port/stage/notes，
 * 在 page.tsx:528-529 / 629-740 读 contacts / inquiries / stage_log 的 length 与内容。
 * 子资源一律挂**数字客户号**（后端是 BIGINT），与列表项 `id` 同源。
 */
function makeCustomerDetail(customer: (typeof MOCK_CUSTOMERS)[number]) {
  const now = Date.now();
  return {
    ...customer,
    contacts: [
      {
        id: 1,
        name: "王经理",
        position: "采购经理",
        phone: "+86-138-0000-0001",
        email: "wang@example.com",
        whatsapp: null,
        is_primary: true,
      },
    ],
    inquiries: [
      {
        id: 1,
        customer_id: customer.id,
        lead_id: null,
        channel: "alibaba",
        category_id: null,
        product_name_raw: "牛栏网 2.5mm × 1.5m",
        quantity: 1000,
        quantity_unit: "m",
        application: "牧场围栏",
        status: "quoted",
        created_at: new Date(now - 5 * 86400000).toISOString(),
      },
    ],
    stage_log: [
      {
        id: 1,
        from_stage: null,
        to_stage: "lead",
        reason: "新建客户",
        created_at: new Date(now - 30 * 86400000).toISOString(),
      },
      {
        id: 2,
        from_stage: "lead",
        to_stage: customer.stage,
        reason: "收到询盘",
        created_at: new Date(now - 5 * 86400000).toISOString(),
      },
    ],
  };
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
const defaultFlags: Record<string, Record<string, boolean>> = {
  "cust-lianjia": { use_v2: true, sampling_enabled: true },
  "cust-client-b": { use_v2: false, sampling_enabled: true },
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
    const filtered = q
      ? MOCK_CUSTOMERS.filter((c) => c.company_name.includes(q))
      : MOCK_CUSTOMERS;
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

  // 详情 = row_to_customer + contacts/inquiries/stage_log（见 makeCustomerDetail）。
  // 客户号按数字匹配 —— 列表项 `id` 是 number（factory.ts 的 makeCustomer）。
  http.get("/api/v1/customers/:id", ({ params }) => {
    const customer = MOCK_CUSTOMERS.find((c) => c.id === Number(params.id));
    if (!customer) {
      return HttpResponse.json(
        {
          error_code: "TENANT_NOT_FOUND",
          message: "租户配置未找到，请检查设置",
          detail: { customer_id: params.id },
        },
        { status: 404 },
      );
    }
    return HttpResponse.json(makeCustomerDetail(customer));
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
  http.get("/api/v1/customers/:id/records", ({ params }) => {
    const customer = MOCK_CUSTOMERS.find((c) => c.id === Number(params.id));
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
];
