import type { EventType } from "@contracts/events";

export function makeEvent(
  overrides?: Partial<{
    id: string;
    event_type: EventType;
    schema_version: number;
    tenant_id: string;
    actor_id: string;
    session_id: string;
    trace_id: string;
    event_source: "frontend" | "backend";
    payload: unknown;
    created_at: string;
    sampled: boolean;
  }>,
) {
  return {
    id: `evt-${Math.random().toString(36).slice(2, 10)}`,
    event_type: "chat.turn" as EventType,
    schema_version: 1,
    tenant_id: "liankai",
    actor_id: "user-1",
    session_id: "sess-1",
    trace_id: "trace-1",
    event_source: "backend" as const,
    payload: {
      session_id: "sess-1",
      raw_text: "客户问：牛栏网 2.5mm 1000米报价",
      agent_id: "agent-1",
      customer_id: "cust-1",
      response_text: "报价已生成",
      llm_model: "gpt-4o",
      llm_tokens_in: 150,
      llm_tokens_out: 80,
    },
    created_at: new Date().toISOString(),
    sampled: false,
    ...overrides,
  };
}

export function makeDashboardSummary(
  overrides?: Partial<{
    range: string;
    quotations_total: number;
    quotations_sampled: number;
    active_customers: number;
    customers_sampled: number;
    dataset_hits: Record<string, number>;
    token_total: number;
    token_sampled: number;
    p95_latency_ms: number;
    latency_sampled: number;
  }>,
) {
  return {
    range: "today",
    quotations_total: 42,
    quotations_sampled: 10,
    active_customers: 8,
    customers_sampled: 3,
    dataset_hits: { L1_共通: 15, L2_牛栏网_产品: 20, L3_联凯_牛栏网: 7 },
    token_total: 125000,
    token_sampled: 30000,
    p95_latency_ms: 320,
    latency_sampled: 80,
    ...overrides,
  };
}

export function makeTenant(
  overrides?: Partial<{
    tenant_id: string;
    name: string;
    is_active: boolean;
  }>,
) {
  return {
    tenant_id: "liankai",
    name: "联凯五金",
    is_active: true,
    ...overrides,
  };
}

export function makeFeatureFlags(overrides?: Record<string, boolean>) {
  return { use_v2: false, sampling_enabled: true, ...overrides };
}

// ── Round 3 additions ──────────────────────────────────────────────

export function makeCustomer(
  overrides?: Partial<{
    customer_id: string;
    customer_name: string;
    category_count: number;
    updated_at: string;
    locale: string;
    region: string;
  }>,
) {
  return {
    customer_id: "cust-liankai",
    customer_name: "联佳五金",
    category_count: 2,
    updated_at: new Date().toISOString(),
    locale: "zh-CN",
    region: "cn-north",
    ...overrides,
  };
}

export function makeCapability(
  overrides?: Partial<{
    id: string;
    customer_id: string;
    product_category: string;
    spec_constraints: Record<string, unknown>;
    is_active: boolean;
    updated_at: string;
  }>,
) {
  return {
    id: `cap-${Math.random().toString(36).slice(2, 8)}`,
    customer_id: "cust-liankai",
    product_category: "牛栏网",
    spec_constraints: { 丝径: "1.5-4.0", 网孔: "50x50-100x100", 包塑: true },
    is_active: true,
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

export function makeQuotation(
  overrides?: Partial<{
    id: string;
    quotation_id: string;
    customer_id: string;
    product_category: string;
    product_spec: Record<string, unknown>;
    quantity: number;
    unit_price: number | null;
    status: "matched" | "estimated" | "spec_not_supported";
    source: "quotations_db" | "L1_L2_formula" | "manual";
    spec_hash: string;
    confidence: "high" | "medium" | "low";
    discount: number;
    notes: string;
    effective_from: string;
    created_at: string;
  }>,
) {
  return {
    id: `q-${Math.random().toString(36).slice(2, 10)}`,
    quotation_id: `Q-${new Date().getFullYear()}-${String(Math.floor(Math.random() * 9999)).padStart(4, "0")}`,
    customer_id: "cust-liankai",
    product_category: "牛栏网",
    product_spec: { 丝径: "2.5mm", 网孔: "75x75", 包塑: "PVC" },
    quantity: 1000,
    unit_price: 3.85,
    status: "matched" as const,
    source: "quotations_db" as const,
    spec_hash: `hash-${Math.random().toString(36).slice(2, 10)}`,
    confidence: "high" as const,
    discount: 0,
    notes: "",
    effective_from: new Date().toISOString(),
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

export function makeDeploymentAudit(
  overrides?: Partial<{
    id: string;
    action: string;
    actor_id: string;
    resource_type: string;
    resource_id: string;
    flag_key: string;
    enabled_before: boolean;
    enabled_after: boolean;
    reason: string;
    timestamp: string;
  }>,
) {
  return {
    id: `audit-${Math.random().toString(36).slice(2, 8)}`,
    action: "update",
    actor_id: "admin-1",
    resource_type: "feature_flag",
    resource_id: "use_v2",
    flag_key: "use_v2",
    enabled_before: false,
    enabled_after: true,
    reason: "灰度测试通过，全量发布",
    timestamp: new Date(
      Date.now() - Math.random() * 7 * 86400000,
    ).toISOString(),
    ...overrides,
  };
}

export function makeSyncJob(
  overrides?: Partial<{
    id: string;
    status: "pending" | "running" | "done" | "failed";
    created_at: string;
    completed_at: string | null;
  }>,
) {
  return {
    id: `sync-${Math.random().toString(36).slice(2, 8)}`,
    status: "pending" as const,
    created_at: new Date().toISOString(),
    completed_at: null,
    ...overrides,
  };
}

// ── Pre-built mock datasets ─────────────────────────────────────────

export const MOCK_CUSTOMERS = [
  makeCustomer({
    customer_id: "cust-liankai",
    customer_name: "联佳五金",
    category_count: 2,
  }),
  makeCustomer({
    customer_id: "cust-client-b",
    customer_name: "备选客户 B",
    category_count: 1,
  }),
];

export const MOCK_CAPABILITIES: Record<
  string,
  ReturnType<typeof makeCapability>[]
> = {
  "cust-liankai": [
    makeCapability({
      id: "cap-001",
      customer_id: "cust-liankai",
      product_category: "牛栏网",
      spec_constraints: { 丝径: "1.5-4.0", 网孔: "50x50-100x100", 包塑: true },
    }),
    makeCapability({
      id: "cap-002",
      customer_id: "cust-liankai",
      product_category: "立柱",
      spec_constraints: { 高度: "1.5-3.0m", 材质: "热镀锌", 直径: "48-60mm" },
    }),
  ],
  "cust-client-b": [
    makeCapability({
      id: "cap-003",
      customer_id: "cust-client-b",
      product_category: "石笼网",
      spec_constraints: { 丝径: "2.0-3.0", 网孔: "60x80" },
    }),
  ],
};

export const MOCK_QUOTATIONS = [
  makeQuotation({
    id: "q-01",
    quotation_id: "Q-2025-0001",
    status: "matched",
    unit_price: 3.85,
    source: "quotations_db",
    confidence: "high",
    effective_from: new Date(Date.now() - 3600000).toISOString(),
  }),
  makeQuotation({
    id: "q-02",
    quotation_id: "Q-2025-0002",
    status: "estimated",
    unit_price: 4.2,
    source: "L1_L2_formula",
    confidence: "medium",
    effective_from: new Date(Date.now() - 7200000).toISOString(),
  }),
  makeQuotation({
    id: "q-03",
    quotation_id: "Q-2025-0003",
    status: "matched",
    unit_price: 2.95,
    source: "quotations_db",
    confidence: "high",
    product_category: "立柱",
    product_spec: { 高度: "2.0m", 材质: "热镀锌" },
    effective_from: new Date(Date.now() - 10800000).toISOString(),
  }),
  makeQuotation({
    id: "q-04",
    quotation_id: "Q-2025-0004",
    status: "spec_not_supported",
    unit_price: null,
    source: "L1_L2_formula",
    confidence: "low",
    effective_from: new Date(Date.now() - 14400000).toISOString(),
  }),
  makeQuotation({
    id: "q-05",
    quotation_id: "Q-2025-0005",
    status: "matched",
    unit_price: 5.1,
    source: "manual",
    confidence: "high",
    notes: "客户定制，加急",
    effective_from: new Date(Date.now() - 18000000).toISOString(),
  }),
  makeQuotation({
    id: "q-06",
    quotation_id: "Q-2025-0006",
    status: "estimated",
    unit_price: 3.5,
    source: "L1_L2_formula",
    confidence: "low",
    customer_id: "cust-client-b",
    product_category: "石笼网",
    product_spec: { 丝径: "2.5mm", 网孔: "60x80" },
    effective_from: new Date(Date.now() - 21600000).toISOString(),
  }),
  makeQuotation({
    id: "q-07",
    quotation_id: "Q-2025-0007",
    status: "matched",
    unit_price: 4.45,
    source: "quotations_db",
    confidence: "high",
    effective_from: new Date(Date.now() - 25200000).toISOString(),
  }),
  makeQuotation({
    id: "q-08",
    quotation_id: "Q-2025-0008",
    status: "estimated",
    unit_price: 4.8,
    source: "L1_L2_formula",
    confidence: "medium",
    discount: 5,
    notes: "批量折扣",
    effective_from: new Date(Date.now() - 28800000).toISOString(),
  }),
  makeQuotation({
    id: "q-09",
    quotation_id: "Q-2025-0009",
    status: "matched",
    unit_price: 3.2,
    source: "quotations_db",
    confidence: "high",
    effective_from: new Date(Date.now() - 32400000).toISOString(),
  }),
  makeQuotation({
    id: "q-10",
    quotation_id: "Q-2025-0010",
    status: "estimated",
    unit_price: 4.0,
    source: "L1_L2_formula",
    confidence: "medium",
    effective_from: new Date(Date.now() - 36000000).toISOString(),
  }),
];

// ── V2 Quote mock data (aligned with real seed data) ─────────────────

export function makeTierItem(
  overrides?: Partial<{
    label: string;
    unit_price: number;
    subtotal: number;
    total: number;
  }>,
) {
  return {
    label: "标准",
    unit_price: 190.61,
    subtotal: 19061.25,
    total: 19061.25,
    ...overrides,
  };
}

export function makeQuoteV2Response(
  overrides?: Partial<{
    status: string;
    product_category: string;
    main_line: Record<string, unknown>;
    accessory_lines: Record<string, unknown>[];
    freight: Record<string, unknown> | null;
    totals: Record<string, number>;
    notes: string[];
    copyable_script: string;
  }>,
) {
  const specSummary =
    "牛栏网 | 上疏下密 | 2.5x2.0丝径 | 1.5m高 | 15.0m网宽 | 50.0m长";
  const tiers = [
    { label: "低", unit_price: 182.33, subtotal: 18232.5, total: 18232.5 },
    { label: "标准", unit_price: 190.61, subtotal: 19061.25, total: 19061.25 },
    { label: "高", unit_price: 198.9, subtotal: 19890.0, total: 19890.0 },
  ];
  return {
    status: "matched",
    product_category: "牛栏网",
    main_line: {
      product_category: "牛栏网",
      spec_summary: specSummary,
      quantity: 100,
      unit: "卷",
      weight_kg: 32.5,
      tiers,
      status: "matched",
    },
    accessory_lines: [],
    freight: null,
    totals: { low: 18232.5, standard: 19061.25, high: 19890.0 },
    notes: [
      "已匹配规格: 牛栏网 | 上疏下密 | 2.5x2.0丝径 | 1.5m高 | 15.0m网宽 | 50.0m长",
      "命中客户成本价: 5.1 CNY/kg",
      "基于利润率 (低110%/标准115%/高120%) 计算",
    ],
    copyable_script: `【牛栏网报价单】\n\n产品: 牛栏网 | 上疏下密 | 2.5x2.0丝径 | 1.5m高 | 15.0m网宽 | 50.0m长\n数量: 100 卷\n单卷重量: 32.5 kg\n总重量: 3250.0 kg\n\n报价梯度（元/卷）:\n  低: 182.33 元/卷，合计 18232.5 元\n  标准: 190.61 元/卷，合计 19061.25 元\n  高: 198.9 元/卷，合计 19890.0 元\n\n合计:\n  低配: 18232.5 元\n  标准: 19061.25 元\n  高配: 19890.0 元\n\n---\n以上报价为系统自动生成，仅供客户参考，实际成交价以合同为准。\n如需调整数量、规格或配送地址，请与您的专属客服联系。`,
    ...overrides,
  };
}

export function makeProductSpecsOptions(
  overrides?: Partial<{
    product_category: string;
    options: Record<string, unknown>;
    accessory_categories: string[];
  }>,
) {
  return {
    product_category: "牛栏网",
    options: {
      product_types: ["上疏下密", "环扣"],
      wire_diameters: ["2.0x1.8", "2.5x2.0"],
      heights: [1.5, 1.8],
      mesh_widths: [15.0],
      mesh_specs: [],
      roll_lengths: [50.0],
      bundle_sizes: [],
    },
    accessory_categories: ["立柱"],
    ...overrides,
  };
}

export const MOCK_DEPLOYMENT_AUDITS = [
  makeDeploymentAudit({
    id: "da-1",
    flag_key: "use_v2",
    enabled_before: false,
    enabled_after: true,
    reason: "灰度测试通过",
    timestamp: new Date(Date.now() - 86400000).toISOString(),
  }),
  makeDeploymentAudit({
    id: "da-2",
    flag_key: "use_v2",
    enabled_before: true,
    enabled_after: false,
    reason: "发现 bug 回滚",
    timestamp: new Date(Date.now() - 2 * 86400000).toISOString(),
  }),
  makeDeploymentAudit({
    id: "da-3",
    flag_key: "sampling_enabled",
    enabled_before: true,
    enabled_after: false,
    reason: "采样性能影响评估",
    timestamp: new Date(Date.now() - 3 * 86400000).toISOString(),
  }),
  makeDeploymentAudit({
    id: "da-4",
    flag_key: "use_v2",
    enabled_before: false,
    enabled_after: true,
    reason: "修复后重新灰度",
    timestamp: new Date(Date.now() - 4 * 86400000).toISOString(),
  }),
  makeDeploymentAudit({
    id: "da-5",
    flag_key: "sampling_enabled",
    enabled_before: false,
    enabled_after: true,
    reason: "采样恢复正常",
    timestamp: new Date(Date.now() - 5 * 86400000).toISOString(),
  }),
];
