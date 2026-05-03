import { http, HttpResponse, delay } from "msw";
import {
  makeEvent,
  makeDashboardSummary,
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
} from "./data/factory";

const EVENTS_LIST = Array.from({ length: 12 }, (_, i) =>
  makeEvent({
    event_type: (
      [
        "chat.turn",
        "quote.request",
        "quote.response",
        "audit.access",
        "capability.update",
        "kb.edit",
      ] as const
    )[i % 6],
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
  "cust-liankai",
  JSON.parse(JSON.stringify(MOCK_CAPABILITIES["cust-liankai"])),
);
capabilitiesStore.set(
  "cust-client-b",
  JSON.parse(JSON.stringify(MOCK_CAPABILITIES["cust-client-b"])),
);

// Stateful store for feature flags
let featureFlagsStore = { use_v2: false, sampling_enabled: true };

// Test-only MSW override: forces quote API to return a specific status.
// This variable is module-scoped in the browser bundle — resets on page reload.
// Used exclusively by Playwright E2E contract tests (quote-contract-e2e.spec.ts)
// via POST /api/v1/__test/override-quote-status.
// NOT present in the real backend. NEVER used in production.
let __test_quote_status_override: string | null = null;

export const handlers = [
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

  // ── Dashboard ────────────────────────────────────────────────────
  http.get("/api/v1/dashboard/summary", ({ request }) => {
    const url = new URL(request.url);
    const range = url.searchParams.get("range") ?? "today";
    const ranges: Record<string, ReturnType<typeof makeDashboardSummary>> = {
      today: makeDashboardSummary({ range: "today", quotations_total: 42 }),
      "7d": makeDashboardSummary({
        range: "7d",
        quotations_total: 310,
        quotations_sampled: 75,
      }),
      "30d": makeDashboardSummary({
        range: "30d",
        quotations_total: 1240,
        quotations_sampled: 300,
      }),
    };
    return HttpResponse.json(ranges[range] ?? ranges.today);
  }),

  // ── OSS ──────────────────────────────────────────────────────────
  http.post("/api/v1/oss/presign", () => {
    return HttpResponse.json({
      presigned_url: "https://oss.example.com/upload/mock",
      key: `events/mock-${Date.now()}.json`,
    });
  }),

  // ── Customers ────────────────────────────────────────────────────
  http.get("/api/v1/customers", () => {
    return HttpResponse.json(MOCK_CUSTOMERS);
  }),

  http.get("/api/v1/customers/:id", ({ params }) => {
    const customer = MOCK_CUSTOMERS.find((c) => c.customer_id === params.id);
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
    return HttpResponse.json(customer);
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

  http.post("/api/v1/quotation", async ({ request }) => {
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
    const category = url.searchParams.get("product_category") || "牛栏网";
    const specs = makeProductSpecsOptions({ product_category: category });
    // Return different data per category to match real backend
    if (category === "石笼网") {
      return HttpResponse.json({
        product_category: "石笼网",
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
    return HttpResponse.json(specs);
  }),

  // ── Quote main API (V2 — aligned with real backend) ─────────────
  http.post("/api/v1/quote", async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>;

    // Tenant check — real backend returns error field + status
    const tenantId = request.headers.get("X-Tenant-Id");
    if (!tenantId) {
      return HttpResponse.json(
        {
          error: "tenant_unauthorized",
          message: "X-Tenant-Id header is required",
        },
        { status: 401 },
      );
    }
    if (tenantId !== "liankai" && tenantId !== "client_b") {
      return HttpResponse.json(
        {
          error: "invalid_tenant",
          message: `Tenant '${tenantId}' not found or disabled`,
        },
        { status: 403 },
      );
    }

    const category = body.product_category as string | undefined;
    if (!category) {
      return HttpResponse.json(
        { error: "validation_error", message: "product_category is required" },
        { status: 422 },
      );
    }

    // Category support check (real backend validates product_category)
    const supportedCategories = ["牛栏网", "立柱"];
    if (!supportedCategories.includes(category)) {
      return HttpResponse.json({
        status: "unsupported_category",
        product_category: category,
        main_line: {
          product_category: category,
          spec_summary: "",
          quantity: 1,
          unit: "卷",
          weight_kg: null,
          tiers: [],
          status: "unavailable",
        },
        accessory_lines: [],
        freight: null,
        totals: { low: 0.0, standard: 0.0, high: 0.0 },
        notes: [`暂不支持品类: ${category}，仅支持 牛栏网`],
        copyable_script: `【牛栏网报价 - 暂不支持品类】\n\n产品: ${category}\n\n说明:\n  - 暂不支持品类: ${category}，仅支持 牛栏网\n\n---\n请联系管理员处理，或尝试调整规格参数后重新报价。`,
      });
    }

    // Simulate specific error states:
    // - query param ?status=xxx (manual browser testing)
    // - __test_quote_status_override (Playwright contract tests, see override endpoint above)
    const url = new URL(request.url);
    const forceStatus =
      url.searchParams.get("status") || __test_quote_status_override;

    if (forceStatus === "no_match") {
      return HttpResponse.json({
        status: "no_match",
        product_category: category,
        main_line: {
          product_category: category,
          spec_summary: "",
          quantity: 1,
          unit: "卷",
          weight_kg: null,
          tiers: [],
          status: "unavailable",
        },
        accessory_lines: [],
        freight: null,
        totals: { low: 0.0, standard: 0.0, high: 0.0 },
        notes: [`未找到 ${category} 匹配的规格记录`],
        copyable_script: `【牛栏网报价 - 规格未匹配】\n\n产品: ${category}\n\n说明:\n  - 未找到 ${category} 匹配的规格记录\n\n---\n请联系管理员处理，或尝试调整规格参数后重新报价。`,
      });
    }

    if (forceStatus === "too_many") {
      return HttpResponse.json({
        status: "too_many",
        product_category: category,
        main_line: {
          product_category: category,
          spec_summary: "",
          quantity: (body.quantity as number) || 1,
          unit: "卷",
          weight_kg: null,
          tiers: [],
          status: "unavailable",
        },
        accessory_lines: [],
        freight: null,
        totals: { low: 0.0, standard: 0.0, high: 0.0 },
        notes: ["找到 3 条匹配记录，请细化筛选条件"],
        copyable_script: `【牛栏网报价 - 规格匹配过多】\n\n产品: ${category}\n\n说明:\n  - 找到 3 条匹配记录，请细化筛选条件\n\n---\n请联系管理员处理，或尝试调整规格参数后重新报价。`,
      });
    }

    if (forceStatus === "cost_pending") {
      return HttpResponse.json({
        status: "cost_pending",
        product_category: category,
        main_line: {
          product_category: category,
          spec_summary: "牛栏网 | 上疏下密 | 2.5x2.0丝径",
          quantity: (body.quantity as number) || 100,
          unit: "卷",
          weight_kg: 32.5,
          tiers: [],
          status: "unavailable",
        },
        accessory_lines: [],
        freight: null,
        totals: { low: 0.0, standard: 0.0, high: 0.0 },
        notes: ["规格匹配成功", "该规格成本待维护，暂不能自动报价（mock）"],
        copyable_script: `【牛栏网报价 - 价格待录入】\n\n产品: 牛栏网 | 上疏下密 | 2.5x2.0丝径\n\n说明:\n  - 规格匹配成功\n  - 该规格成本待维护，暂不能自动报价（mock）\n\n---\n请联系管理员处理，或尝试调整规格参数后重新报价。`,
      });
    }

    if (forceStatus === "unsupported") {
      return HttpResponse.json({
        status: "unsupported_category",
        product_category: category,
        main_line: {
          product_category: category,
          spec_summary: "",
          quantity: 1,
          unit: "卷",
          weight_kg: null,
          tiers: [],
          status: "unavailable",
        },
        accessory_lines: [],
        freight: null,
        totals: { low: 0.0, standard: 0.0, high: 0.0 },
        notes: [`暂不支持品类: ${category}，仅支持 牛栏网`],
        copyable_script: `【牛栏网报价 - 暂不支持品类】\n\n产品: ${category}\n\n说明:\n  - 暂不支持品类: ${category}，仅支持 牛栏网\n\n---\n请联系管理员处理，或尝试调整规格参数后重新报价。`,
      });
    }

    // --- matched response (mimics real backend) ---
    const quantity = (body.quantity as number) || 100;
    const wireDiam = (body.wire_diameter as string) || "2.5x2.0";
    const prodType = (body.product_type as string) || "上疏下密";
    const h = (body.height as number) || 1.5;
    const weightKg = 32.5;
    const specSummary = `牛栏网 | ${prodType} | ${wireDiam}丝径 | ${h}m高 | 15.0m网宽 | 50.0m长`;

    const tiers = [
      {
        label: "低",
        unit_price: 182.33,
        subtotal: Math.round(182.33 * quantity * 100) / 100,
        total: Math.round(182.33 * quantity * 100) / 100,
      },
      {
        label: "标准",
        unit_price: 190.61,
        subtotal: Math.round(190.61 * quantity * 100) / 100,
        total: Math.round(190.61 * quantity * 100) / 100,
      },
      {
        label: "高",
        unit_price: 198.9,
        subtotal: Math.round(198.9 * quantity * 100) / 100,
        total: Math.round(198.9 * quantity * 100) / 100,
      },
    ];

    // Accessories
    interface AccessoryLineItem {
      product_category: string;
      spec_summary: string;
      quantity: number;
      unit: string;
      total: number;
      status: string;
    }
    let accessoryLines: AccessoryLineItem[] = [];
    const hasAccessories =
      body.accessories &&
      Array.isArray(body.accessories) &&
      body.accessories.length > 0;
    if (hasAccessories) {
      accessoryLines = (body.accessories as Record<string, unknown>[]).map(
        (acc) => {
          const productCategory = String(acc.product_category || "立柱");
          return {
            product_category: productCategory,
            spec_summary: `${productCategory} | 直边 | 1.8m | 10支/捆`,
            quantity: Number(acc.quantity) || 1,
            unit: "个",
            total: (Number(acc.quantity) || 1) * 180.0,
            status: "matched",
          };
        },
      );
    }

    // Freight
    let freightInfo: Record<string, unknown> | null = null;
    const hasFreight =
      body.province &&
      typeof body.province === "string" &&
      body.province.length > 0;
    if (hasFreight) {
      const totalWeight = weightKg * quantity;
      const freightAmount = Math.round(totalWeight * 1.5 * 100) / 100;
      freightInfo = {
        province: body.province as string,
        chosen: { carrier: "顺丰干配", amount: freightAmount },
        options: [
          { carrier: "顺丰干配", amount: freightAmount },
          {
            carrier: "顺丰零担",
            amount: Math.round(freightAmount * 1.3 * 100) / 100,
          },
        ],
        status: "matched",
      };
    }

    const freightAmount = freightInfo?.chosen
      ? ((freightInfo.chosen as Record<string, unknown>).amount as number)
      : 0;
    const totals = {
      low: Math.round((182.33 * quantity + freightAmount) * 100) / 100,
      standard: Math.round((190.61 * quantity + freightAmount) * 100) / 100,
      high: Math.round((198.9 * quantity + freightAmount) * 100) / 100,
    };

    return HttpResponse.json({
      status: "matched",
      product_category: category,
      main_line: {
        product_category: category,
        spec_summary: specSummary,
        quantity,
        unit: "卷",
        weight_kg: weightKg,
        tiers,
        status: "matched",
      },
      accessory_lines: accessoryLines,
      freight: freightInfo,
      totals,
      notes: [
        `已匹配规格: ${specSummary}`,
        "命中客户成本价: 5.1 CNY/kg",
        "基于利润率 (低110%/标准115%/高120%) 计算",
        ...(hasFreight
          ? ["已计算运费: 顺丰干配 " + freightAmount + " 元"]
          : []),
      ],
      copyable_script: `【牛栏网报价单】\n\n产品: ${specSummary}\n数量: ${quantity} 卷\n单卷重量: ${weightKg} kg\n总重量: ${weightKg * quantity} kg\n\n报价梯度（元/卷）:\n  低: 182.33 元/卷，合计 ${tiers[0]!.total} 元\n  标准: 190.61 元/卷，合计 ${tiers[1]!.total} 元\n  高: 198.9 元/卷，合计 ${tiers[2]!.total} 元\n${hasAccessories ? `\n配件:\n  ${accessoryLines.map((a) => `${a.spec_summary} x ${a.quantity}${a.unit} = ${a.total} 元`).join("\n  ")}\n` : ""}${hasFreight ? `\n运费 (${String(body.province)}): 顺丰干配 ${freightAmount} 元\n` : ""}\n合计:\n  低配: ${totals.low} 元\n  标准: ${totals.standard} 元\n  高配: ${totals.high} 元\n\n---\n以上报价为系统自动生成，仅供客户参考，实际成交价以合同为准。\n如需调整数量、规格或配送地址，请与您的专属客服联系。`,
    });
  }),

  // ── Feature Flags ────────────────────────────────────────────────
  http.get("/api/v1/admin/feature_flag", () => {
    return HttpResponse.json({ ...featureFlagsStore });
  }),

  http.post("/api/v1/admin/feature_flag", async ({ request }) => {
    const body = (await request.json()) as {
      flag_key: string;
      enabled: boolean;
      reason: string;
      actor_id: string;
    };
    const before =
      featureFlagsStore[body.flag_key as keyof typeof featureFlagsStore] ??
      false;
    (featureFlagsStore as Record<string, boolean>)[body.flag_key] =
      body.enabled;
    const after = body.enabled;
    return HttpResponse.json({ flag_key: body.flag_key, before, after });
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
    return HttpResponse.json({
      items: filtered.slice(0, 200),
      total: filtered.length,
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
        resource_id: "liankai",
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
    return HttpResponse.json([
      makeTenant({ tenant_id: "liankai", name: "联凯五金", is_active: true }),
      makeTenant({
        tenant_id: "client-b",
        name: "备选客户 B",
        is_active: true,
      }),
    ]);
  }),

  http.post("/api/v1/admin/tenants/reload", () => {
    return HttpResponse.json({
      reloaded_count: 2,
      active_tenants: [
        {
          tenant_id: "liankai",
          display_name: "联凯五金",
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
