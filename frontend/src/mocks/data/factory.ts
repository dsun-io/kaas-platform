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
    tenant_id: "lianjia",
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
    dataset_hits: { L1_共通: 15, L2_牛栏网_产品: 20, L3_联佳丝网_牛栏网: 7 },
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
    tenant_id: "lianjia",
    name: "联佳丝网",
    is_active: true,
    ...overrides,
  };
}

export function makeFeatureFlags(overrides?: Record<string, boolean>) {
  return { use_v2: false, sampling_enabled: true, ...overrides };
}

// ── Round 3 additions ──────────────────────────────────────────────

/**
 * 客户行 —— 形状**逐字对齐**后端 `row_to_customer()`：
 *   backend/kaas_common/workstation/customer_serializers.py:10-27
 *   → id / company_name / country / address / default_port / credit_level /
 *     stage / notes / created_at / updated_at
 *
 * 为什么不能再用旧的 `{customer_id, customer_name, category_count, locale, region}`：
 *   页面契约是 `Customer`（frontend/src/app/(app)/customers/page.tsx:48-59），
 *   按 `c.id` / `c.company_name` / `c.stage` / `c.country` / `c.default_port` /
 *   `c.updated_at` 渲染卡片（page.tsx:822-842）。旧字段名一个都对不上，
 *   客户列表在 mock 模式下恒为 0 行。
 *   `id` 必须是 number：前端把它直接插进 `GET /customers/{id}`（page.tsx:117）
 *   与 `/customers/{id}/records`（lib/customer/use-customer-records.ts:44），
 *   后端该主键是 BIGINT（backend/orchestrator/app/api/customers.py:246）。
 */
export function makeCustomer(
  overrides?: Partial<{
    id: number;
    company_name: string;
    country: string | null;
    address: string | null;
    default_port: string | null;
    credit_level: string | null;
    /** 展示阶段：active / inactive / ordered（ordered 由开启中的订单推导） */
    stage: string;
    /** 手动状态：active / inactive（客户页「更新阶段」回填） */
    manual_stage?: string;
    notes: string | null;
    created_at: string;
    updated_at: string;
  }>,
) {
  return {
    id: 1,
    company_name: "联佳丝网",
    country: "CN",
    address: null,
    default_port: "Shanghai",
    credit_level: "A",
    // 客户阶段（2026-10-18）：只有 active / inactive / ordered 三个 key。
    stage: "active",
    manual_stage: "active",
    notes: null,
    created_at: new Date(Date.now() - 30 * 86400000).toISOString(),
    updated_at: new Date(Date.now() - 2 * 3600000).toISOString(),
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
    customer_id: "cust-lianjia",
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
    customer_id: "cust-lianjia",
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
    tenant_id: string;
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
    tenant_id: "lianjia",
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
    id: 1,
    company_name: "联佳丝网",
    country: "CN",
    default_port: "Shanghai",
    credit_level: "A",
    stage: "active",
    manual_stage: "active",
    // 两个种子的 updated_at 必须**不同**：列表按 updated_at desc 排序
    // （后端 customers.py:212），时间戳相同则排序不稳定、用例断言会飘。
    updated_at: new Date(Date.now() - 3600000).toISOString(),
  }),
  makeCustomer({
    id: 2,
    company_name: "备选客户 B",
    country: "US",
    default_port: "Los Angeles",
    credit_level: "B",
    // 第二个种子用「沉寂」覆盖手动状态分支
    stage: "inactive",
    manual_stage: "inactive",
    updated_at: new Date(Date.now() - 3 * 86400000).toISOString(),
  }),
];

export const MOCK_CAPABILITIES: Record<
  string,
  ReturnType<typeof makeCapability>[]
> = {
  "cust-lianjia": [
    makeCapability({
      id: "cap-001",
      customer_id: "cust-lianjia",
      product_category: "牛栏网",
      spec_constraints: { 丝径: "1.5-4.0", 网孔: "50x50-100x100", 包塑: true },
    }),
    makeCapability({
      id: "cap-002",
      customer_id: "cust-lianjia",
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
  // 使用模拟成本模型：成本单价 × 重量 × 利润率，与真实后端计算逻辑一致
  const weightKg = 32.5;
  const quantity = 100;
  const simulatedCostPerKg = 5.1;
  const baseCost = +(simulatedCostPerKg * weightKg).toFixed(2); // 165.75
  const marginRates = { low: 1.1, standard: 1.15, high: 1.2 };
  const tiers = (["低", "标准", "高"] as const).map((label) => {
    const key = label === "低" ? "low" : label === "标准" ? "standard" : "high";
    const margin = marginRates[key];
    const unitPrice = +(baseCost * margin).toFixed(2);
    return {
      label,
      margin_rate: margin,
      unit_price: unitPrice,
      subtotal: +(unitPrice * quantity).toFixed(2),
      total: +(unitPrice * quantity).toFixed(2),
    };
  });
  const specSummary =
    "牛栏网 | 上疏下密 | 2.0x1.8丝径 | 1.5m高 | 15.0m网宽 | 50.0m长";
  return {
    status: "matched",
    product_category: "牛栏网",
    main_line: {
      product_category: "牛栏网",
      spec_summary: specSummary,
      quantity,
      unit: "卷",
      weight_kg: weightKg,
      base_cost: baseCost,
      tiers,
      status: "matched",
    },
    accessory_lines: [],
    freight: null,
    totals: {
      low: tiers[0]!.total,
      standard: tiers[1]!.total,
      high: tiers[2]!.total,
    },
    notes: [
      `已匹配规格: ${specSummary}`,
      `成本基准: ${simulatedCostPerKg} CNY/kg × ${weightKg} kg = ${baseCost} 元/卷`,
      "基于利润率 (低110%/标准115%/高120%) 计算",
    ],
    copyable_script: `【牛栏网报价单】\n\n产品: ${specSummary}\n数量: ${quantity} 卷\n单卷重量: ${weightKg} kg\n总重量: ${(weightKg * quantity).toFixed(1)} kg\n\n报价梯度（元/卷）:\n  逼单方案: ${tiers[0]!.unit_price} 元/卷，合计 ${tiers[0]!.total} 元\n  让利方案: ${tiers[1]!.unit_price} 元/卷，合计 ${tiers[1]!.total} 元\n  优选方案: ${tiers[2]!.unit_price} 元/卷，合计 ${tiers[2]!.total} 元\n\n合计:\n  逼单方案: ${tiers[0]!.total} 元\n  让利方案: ${tiers[1]!.total} 元\n  优选方案: ${tiers[2]!.total} 元\n\n---\n以上报价为系统自动生成，仅供客户参考，实际成交价以合同为准。\n如需调整数量、规格或配送地址，请与您的专属客服联系。`,
    ...overrides,
  };
}

/** 品类归一化：code / 中文标签双收 → 统一返回 code。
 * 对齐真实后端 normalize_category（category_normalizer.py）的约定，
 * 修复 mock 只认中文标签、前端按 code 传参导致的品类匹配失效。 */
const CATEGORY_CODE_BY_INPUT: Record<string, string> = {
  niulanwang: "niulanwang",
  gouhuawang: "gouhuawang",
  post: "post",
  gabion: "gabion",
  牛栏网: "niulanwang",
  勾花网: "gouhuawang",
  立柱: "post",
  石笼网: "gabion",
};

export function normalizeCategoryCode(input: string): string {
  return CATEGORY_CODE_BY_INPUT[input.trim()] ?? input.trim();
}

/** 模拟 quotable_specs（有成本数据的完整规格组合列表，前端用于 tuple 匹配 + cascading）。 */
export function makeQuotableSpecs(productCategory: string) {
  if (normalizeCategoryCode(productCategory) !== "niulanwang") return [];

  // 尺寸类已改为**自由数值参数**（丝径/网高/间距/卷长随手填），
  // 不再有"规格轴取值清单"可枚举 —— 所以这里只给一组**代表性样例**，
  // 用于驱动旧扁平模型的 tuple 匹配与级联，**不代表真实可选空间**。
  // 真实规格空间见 `GET /export-quote/products/field_fence/formulas`。
  const wires = ["2.0x2.0", "2.5x2.5", "2.5x2.0"];
  const heights = [1.2, 1.5];
  const spacings = [10, 15];
  const result: Array<{
    product_type: string;
    wire_diameter: string;
    height: number;
    mesh_width: number;
    mesh_spec: null;
    roll_length: number;
  }> = [];
  for (const w of wires) {
    // 卷长是自由数值（默认 100m/卷）；旧扁平模型仍按方案给 50/100 两种样例
    const rollLength = w === "2.5x2.5" ? 50 : 100;
    for (const h of heights) {
      for (const s of spacings) {
        result.push({
          product_type: "拧编型上疏下密",
          wire_diameter: w,
          height: h,
          // 旧扁平模型把这个字段当竖丝间距用（cm）
          mesh_width: s,
          mesh_spec: null,
          roll_length: rollLength,
        });
      }
    }
  }
  return result;
}

export function makeProductSpecsOptions(
  overrides?: Partial<{
    product_category: string;
    options: Record<string, unknown>;
    quotable_specs: Array<Record<string, unknown>>;
    accessory_categories: string[];
  }>,
) {
  // 默认 options 仅包含有成本数据的规格组合，与 quotable_specs 一致
  const specs = makeQuotableSpecs("niulanwang");
  return {
    product_category: "niulanwang",
    options: {
      product_types: ["拧编型上疏下密"],
      wire_diameters: [...new Set(specs.map((s) => s.wire_diameter))],
      heights: [...new Set(specs.map((s) => s.height))],
      mesh_widths: [...new Set(specs.map((s) => s.mesh_width))],
      mesh_specs: [],
      roll_lengths: [...new Set(specs.map((s) => s.roll_length))],
      bundle_sizes: [],
    },
    quotable_specs: specs,
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
