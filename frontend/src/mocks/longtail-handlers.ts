/**
 * 长尾域 MSW handler（C18 · 2026-10-20）
 *
 * 覆盖审计里"未 mock"的剩余域：intel / market / spec-config / admin 属性提案 /
 * ai-providers / auth forgot-reset / shipments / research / leadgen / outreach /
 * pricing-data / fx-rates / 报价 calculate+import+explain。
 *
 * 口径（与 `handlers.ts` 的 P1 组一致）：
 *  · 每条响应形状**对照 `backend/worker/src/**` 的序列化/契约**（注释里标了真源）；
 *  · 写操作**真改 store**，并由 `persistence.ts` 按请求映射落 localStorage（C5）；
 *  · 不凭空造字段；后端没有的字段宁可不给（前端会按缺省值降级）。
 *
 * 单独成文件的原因：`handlers.ts` 已经 4700+ 行，长尾域之间互不依赖，
 * 放一处便于按域阅读/维护；`handlers.ts` 末尾用 `...longtailHandlers` 拼进同一份 handler 列表。
 */
import { http, HttpResponse } from "msw";

import {
  MOCK_EXPORT_FORMULAS,
  MOCK_EXPORT_PRODUCTS,
} from "./export-quote-data";
import { registerMockCollection } from "./persistence";

const nowIso = () => new Date().toISOString();
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const optStr = (v: unknown): string | null =>
  typeof v === "string" ? v : null;
const asRecord = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};

// 页面用的 id 序号（与 handlers.ts 的计数器分开，避免互相踩号）
let longtailSeq = 1000;

// ════════════════════════════════════════════════════════════════════════════
// 1) intel（情报：船运记录 / 贸易统计 / 采集通道）
// 形状真源：main.py:867-1040（`_row_to_dict` 直出整行 / channels 分组）
// ════════════════════════════════════════════════════════════════════════════

type MockIntelShipment = Record<string, unknown> & { id: number };

const INTEL_SHIPMENT_SEEDS: MockIntelShipment[] = [
  {
    id: 1,
    tenant_id: "default",
    shipper: "ANPING KAAS WIRE MESH CO., LTD.",
    ship_date: "2026-09-18",
    carrier: "COSCO",
    notify_party: "SAME AS CONSIGNEE",
    origin_port: "Tianjin",
    origin_country: "CN",
    dest_port: "Hamburg",
    dest_country: "DE",
    consignee: "HANSA FENCE GMBH",
    product_desc: "Galvanized chain link fence, 50x50mm, 2.5mm",
    product_desc_norm: "chain link fence",
    hs_code: "7314490000",
    category_id: null,
    qty: 120,
    qty_unit: "ROLLS",
    gross_weight_kg: 18600,
    net_weight_kg: 17800,
    volume_cbm: 42,
    container_no: "CSNU1234567",
    container_type: "40HQ",
    bl_no: "COSU987654321",
    voyage_no: "V.026E",
    declared_value: 28650,
    currency: "USD",
    marks: "KAAS/HAMBURG/1-120",
    remarks: null,
    shipment_type: "export",
    incoterm: "FOB",
    freight_prepaid: true,
    source_channel: "manual_csv",
    source_ref: "intel-sample.csv",
    is_verified: true,
    created_by: "1",
    created_at: "2026-10-01T08:00:00.000Z",
    updated_at: "2026-10-01T08:00:00.000Z",
  },
  {
    id: 2,
    tenant_id: "default",
    shipper: "HEBEI WIREWORKS CO.",
    ship_date: "2026-09-25",
    carrier: "MAERSK",
    notify_party: null,
    origin_port: "Qingdao",
    origin_country: "CN",
    dest_port: "Los Angeles",
    dest_country: "US",
    consignee: "PACIFIC FENCE SUPPLY INC.",
    product_desc: "PVC coated welded mesh panels",
    product_desc_norm: "welded mesh panel",
    hs_code: "7314200000",
    category_id: null,
    qty: 800,
    qty_unit: "PCS",
    gross_weight_kg: 12400,
    net_weight_kg: 11800,
    volume_cbm: 31,
    container_no: null,
    container_type: "40GP",
    bl_no: "MAEU112233445",
    voyage_no: "V.118W",
    declared_value: 19900,
    currency: "USD",
    marks: null,
    remarks: "sample row",
    shipment_type: "export",
    incoterm: "CIF",
    freight_prepaid: true,
    source_channel: "manual_crawler",
    source_ref: null,
    is_verified: false,
    created_by: "1",
    created_at: "2026-10-02T08:00:00.000Z",
    updated_at: "2026-10-02T08:00:00.000Z",
  },
];

let intelShipmentsStore: MockIntelShipment[] = [];

/** 贸易统计 / 采集运行 / 通道都是只读展示数据（无写端点会改它们，故不持久化）。 */
const INTEL_TRADE_STATS = [
  {
    id: 1,
    hs_code: "7314490000",
    period: "2026-Q2",
    reporter_country: "DE",
    partner_country: "CN",
    trade_flow: "import",
    qty: 18600,
    qty_unit: "kg",
    value_usd: 28650,
  },
  {
    id: 2,
    hs_code: "7314200000",
    period: "2026-Q2",
    reporter_country: "US",
    partner_country: "CN",
    trade_flow: "import",
    qty: 12400,
    qty_unit: "kg",
    value_usd: 19900,
  },
];

const INTEL_ADAPTER_RUNS = [
  {
    id: 1,
    tenant_id: "default",
    status: "success",
    started_at: "2026-10-01T07:00:00.000Z",
    finished_at: "2026-10-01T07:02:00.000Z",
    items_processed: 120,
    items_inserted: 118,
    error_message: null,
  },
  {
    id: 2,
    tenant_id: "default",
    status: "failed",
    started_at: "2026-10-02T07:00:00.000Z",
    finished_at: "2026-10-02T07:00:30.000Z",
    items_processed: 0,
    items_inserted: 0,
    error_message: "upstream timeout",
  },
];

/** 通道：后端字段是 `is_enabled`（main.py:1024-1040），前端 interface 写的是 `enabled`
 * —— 这是**前端读错字段**，mock 仍按后端真源返回（不替它掩饰），页面显示"未开通"。 */
const INTEL_CHANNELS = [
  {
    id: 1,
    name: "海关公开数据",
    type: "customs",
    tier: "free",
    is_enabled: true,
  },
  {
    id: 2,
    name: "Google Places",
    type: "maps",
    tier: "free",
    is_enabled: true,
  },
  {
    id: 3,
    name: "ImportGenius",
    type: "trade",
    tier: "paid",
    is_enabled: false,
  },
  { id: 4, name: "Panjiva", type: "trade", tier: "paid", is_enabled: false },
];

// ════════════════════════════════════════════════════════════════════════════
// 2) market（市场情报）—— 全部只读，形状真源 main.py:1663-1745
// ════════════════════════════════════════════════════════════════════════════

const MARKET_REGIONS = ["US-CA", "US-TX", "DE-NW", "AU-NSW", "GB-ENG"];

const MARKET_REGION_PRODUCTS: Record<string, Array<Record<string, unknown>>> = {
  "DE-NW": [
    {
      id: 1,
      region_code: "DE-NW",
      category_id: null,
      demand_level: "high",
      popularity_rank: 1,
      cert_requirements: ["CE"],
      standards: ["DIN 18202"],
      seasonality: "Q2-Q3",
      specs: [{ key: "wire_diameter", value: "2.5", unit: "mm", rank: 1 }],
      product_name: "Chain link fence",
    },
    {
      id: 2,
      region_code: "DE-NW",
      category_id: null,
      demand_level: "medium",
      popularity_rank: 2,
      cert_requirements: [],
      standards: [],
      seasonality: "Q4",
      specs: [{ key: "height", value: "1.5", unit: "m", rank: 1 }],
      product_name: "Temporary fence",
    },
  ],
  "US-CA": [
    {
      id: 3,
      region_code: "US-CA",
      category_id: null,
      demand_level: "high",
      popularity_rank: 1,
      cert_requirements: ["ASTM F567"],
      standards: [],
      seasonality: "全年",
      specs: [{ key: "mesh", value: "50x50", unit: "mm", rank: 1 }],
      product_name: "Welded mesh panel",
    },
  ],
};

type MockNameMapping = {
  id: number;
  category_id: number | null;
  region_code: string;
  lang: string;
  local_name: string;
  alt_names: string[];
  hs_code: string | null;
  source: string;
  confidence: string | null;
  is_verified: boolean;
  created_at: string;
  updated_at?: string | null;
};

/** 品名对照种子：既是 `GET /market/name-mappings` 空 q 的"最近记录"，也是 name-lookup 的来源。 */
const MARKET_NAME_MAPPINGS: MockNameMapping[] = [
  {
    id: 1,
    category_id: null,
    region_code: "DE-NW",
    lang: "de",
    local_name: "Doppelstabmattenzaun",
    alt_names: ["Doppelstabzaun", "Stabmatte"],
    hs_code: "7314490000",
    source: "seed",
    is_verified: true,
    confidence: "high",
    created_at: "2026-09-02T08:00:00.000Z",
  },
  {
    id: 2,
    category_id: null,
    region_code: "US-CA",
    lang: "en",
    local_name: "chain link fence",
    alt_names: ["cyclone fence", "wire fence"],
    hs_code: "7314490000",
    source: "seed",
    is_verified: true,
    confidence: "high",
    created_at: "2026-09-01T08:00:00.000Z",
  },
];

/**
 * 品名对照写库（B2）：POST / PATCH / DELETE 真改这里，GET 列表与 name-lookup 都读这里
 * —— 旧实现"列表读静态种子、写入另一个空数组"会让刚建的对照搜不到（假正向）。
 * 重置走 `resetNameMappingStore()`（回到种子，不是清空）。
 */
let nameMappingStore: MockNameMapping[] = clone(MARKET_NAME_MAPPINGS);
const nameMappingSeedSeq =
  Math.max(0, ...MARKET_NAME_MAPPINGS.map((r) => r.id)) + 1;
let nameMappingSeq = nameMappingSeedSeq;

/** 给 `handlers.ts` 的 `resetMockData()` 用：回种子（含删除过的种子行）。 */
export function resetNameMappingStore(): void {
  nameMappingStore = clone(MARKET_NAME_MAPPINGS);
  nameMappingSeq = nameMappingSeedSeq;
}

/** 新行 id（POST 用；与种子 id 不冲突，删除后也不回收）。 */
export function nextNameMappingId(): number {
  return nameMappingSeq++;
}

/** 品名/别名 ILIKE + region/lang 过滤（后端 `list_name_mappings` 的 WHERE 同口径）。 */
function filterNameMappings(url: URL): MockNameMapping[] {
  const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
  const region = (url.searchParams.get("region_code") ?? "")
    .trim()
    .toUpperCase();
  const lang = (url.searchParams.get("lang") ?? "").trim();
  return nameMappingStore
    .filter((row) => {
      if (region && row.region_code !== region) return false;
      if (lang && row.lang !== lang) return false;
      if (!q) return true;
      return [row.local_name, ...(row.alt_names ?? [])].some((name) =>
        name.toLowerCase().includes(q),
      );
    })
    .sort(compareNameMappings);
}

/** 排序照后端 `ORDER BY is_verified DESC, created_at DESC`（最近记录在前）。 */
function compareNameMappings(a: MockNameMapping, b: MockNameMapping): number {
  if (a.is_verified !== b.is_verified) return a.is_verified ? -1 : 1;
  const byCreated = (b.created_at ?? "").localeCompare(a.created_at ?? "");
  return byCreated !== 0 ? byCreated : b.id - a.id;
}

const MARKET_PORTS = [
  {
    id: 1,
    name_cn: "汉堡港",
    name_en: "Hamburg",
    un_locode: "DEHAM",
    country_code: "DE",
    city: "Hamburg",
    port_type: "seaport",
    position_desc: "Elbe river",
    suitable_cargo: ["container", "bulk"],
    suitable_shipping_modes: ["sea"],
    congestion_level: "medium",
  },
  {
    id: 2,
    name_cn: "洛杉矶港",
    name_en: "Los Angeles",
    un_locode: "USLAX",
    country_code: "US",
    city: "Los Angeles",
    port_type: "seaport",
    position_desc: "San Pedro Bay",
    suitable_cargo: ["container"],
    suitable_shipping_modes: ["sea", "rail"],
    congestion_level: "high",
  },
];

const MARKET_USAGES = [
  {
    id: 1,
    usage_code: "farm_fence",
    usage_name: "牧场围栏",
    description: "牛栏网/鹿网用于牧场边界与分区",
  },
  {
    id: 2,
    usage_code: "construction_site",
    usage_name: "工地围挡",
    description: "临时围栏 / 石笼网用于工地隔离与护坡",
  },
];

// ════════════════════════════════════════════════════════════════════════════
// 3) spec-config（品类树 / 绑定 / 规格向导）+ admin 属性提案
// 形状真源：main.py:2590-2650（categories/bindings）、contracts/spec-system.ts、
// ws_admin_proposals.py（提案列表/推荐/审核）
// ════════════════════════════════════════════════════════════════════════════

type MockCategoryNode = {
  id: number;
  code: string;
  name: string;
  parent_id: number | null;
  sort_order: number;
  children: MockCategoryNode[];
};

const SPEC_CATEGORY_TREE: MockCategoryNode[] = [
  {
    id: 1,
    code: "fence",
    name: "围栏网",
    parent_id: null,
    sort_order: 1,
    children: [
      {
        id: 2,
        code: "chain_link",
        name: "勾花网",
        parent_id: 1,
        sort_order: 1,
        children: [],
      },
      {
        id: 3,
        code: "field_fence",
        name: "牛栏网",
        parent_id: 1,
        sort_order: 2,
        children: [],
      },
    ],
  },
  {
    id: 4,
    code: "mesh",
    name: "金属网",
    parent_id: null,
    sort_order: 2,
    children: [
      {
        id: 5,
        code: "gabion",
        name: "石笼网",
        parent_id: 4,
        sort_order: 1,
        children: [],
      },
    ],
  },
];

const SPEC_BINDINGS: Record<number, Array<Record<string, unknown>>> = {
  2: [
    {
      id: 11,
      category_id: 2,
      attribute_id: 101,
      group_code: "dimension",
      is_required: true,
      sort_order: 1,
      default_value: null,
      validation_rules: null,
      attribute: {
        id: 101,
        code: "wire_diameter",
        name: "丝径",
        group_code: "dimension",
        data_type: "number",
        unit: "mm",
        unit_group: "length",
        scope: "global",
        source: "builtin",
        values: [],
      },
    },
    {
      id: 12,
      category_id: 2,
      attribute_id: 102,
      group_code: "surface",
      is_required: false,
      sort_order: 2,
      default_value: "hot_dip",
      validation_rules: null,
      attribute: {
        id: 102,
        code: "coating",
        name: "表面处理",
        group_code: "surface",
        data_type: "enum",
        unit: null,
        unit_group: null,
        scope: "global",
        source: "builtin",
        values: [
          { id: 201, value_code: "hot_dip", label: "热镀锌" },
          { id: 202, value_code: "pvc", label: "PVC 包塑" },
        ],
      },
    },
  ],
  3: [
    {
      id: 13,
      category_id: 3,
      attribute_id: 103,
      group_code: "dimension",
      is_required: true,
      sort_order: 1,
      default_value: null,
      validation_rules: null,
      attribute: {
        id: 103,
        code: "height_m",
        name: "网高",
        group_code: "dimension",
        data_type: "number",
        unit: "m",
        unit_group: "length",
        scope: "global",
        source: "builtin",
        values: [],
      },
    },
  ],
};

type MockProposal = {
  id: number;
  tenant_id: string;
  category_id: number;
  proposed_name: string;
  proposed_type: string;
  group_code: string;
  status: string;
  occurrence_count: number;
  recommended_for_promotion: boolean;
  recommendation_score: number | null;
  recommended_at: string | null;
  created_at: string | null;
};

const PROPOSAL_SEEDS: MockProposal[] = [
  {
    id: 1,
    tenant_id: "default",
    category_id: 2,
    proposed_name: "镀锌层厚度",
    proposed_type: "number",
    group_code: "surface",
    status: "pending",
    occurrence_count: 7,
    recommended_for_promotion: true,
    recommendation_score: 82.5,
    recommended_at: "2026-10-18T08:00:00.000Z",
    created_at: "2026-10-16T08:00:00.000Z",
  },
  {
    id: 2,
    tenant_id: "default",
    category_id: 3,
    proposed_name: "卷重",
    proposed_type: "number",
    group_code: "packing",
    status: "pending",
    occurrence_count: 2,
    recommended_for_promotion: false,
    recommendation_score: 31,
    recommended_at: null,
    created_at: "2026-10-19T08:00:00.000Z",
  },
];

let proposalsStore: MockProposal[] = [];
/** 向导提交过的 SKU（按 spec_hash 命中，与 main.py:2679-2745 同语义） */
const specSkuStore = new Map<string, { sku_id: number; revision: number }>();

// ════════════════════════════════════════════════════════════════════════════
// 4) ai-providers（AI 任务元信息 / Provider 密钥 / 绑定 / 用量）
// 形状真源：chain.py:532-726
// ════════════════════════════════════════════════════════════════════════════

const AI_PROVIDER_DEFAULTS: Record<
  string,
  { model: string; base_url: string }
> = {
  deepseek: { model: "deepseek-chat", base_url: "https://api.deepseek.com/v1" },
  kimi: { model: "moonshot-v1-8k", base_url: "https://api.moonshot.cn/v1" },
  zhipu: {
    model: "glm-4-flash",
    base_url: "https://open.bigmodel.cn/api/paas/v4",
  },
};

const AI_TASKS = [
  {
    task_key: "config_validation",
    name: "配置校验",
    recommended_provider: "deepseek",
  },
  {
    task_key: "lead_scoring",
    name: "线索评分",
    recommended_provider: "deepseek",
  },
  {
    task_key: "opening_line",
    name: "开场白生成",
    recommended_provider: "kimi",
  },
  {
    task_key: "email_generation",
    name: "邮件生成",
    recommended_provider: "kimi",
  },
  {
    task_key: "inquiry_classification",
    name: "询盘分类",
    recommended_provider: "kimi",
  },
  // 真机核对（2026-10-21，`GET /api/v1/ai/tasks` 实测 7 个）：mock 原缺这两条，
  // 导致 AI 页「运行任务」在 mock 下看不到它们 —— 契约漂移本次一并修正。
  {
    task_key: "spec_extract",
    name: "规格结构化",
    recommended_provider: "deepseek",
  },
  {
    task_key: "product_translate",
    name: "产品名翻译",
    recommended_provider: "kimi",
  },
];

type MockAiProvider = {
  provider: string;
  api_key: string | null;
  model: string | null;
  base_url: string | null;
  enabled: boolean;
};
let aiProvidersStore: MockAiProvider[] = [];

type MockAiBinding = {
  task_key: string;
  provider: string;
  model: string | null;
  enabled: boolean;
  config: Record<string, unknown> | null;
};
let aiBindingsStore: MockAiBinding[] = [];

const AI_USAGE_SEEDS = [
  {
    id: 1,
    task_key: "config_validation",
    provider: null,
    model: null,
    prompt_tokens: 0,
    completion_tokens: 0,
    cost_usd: null,
    status: "template_only",
    error: null,
    latency_ms: 12,
    created_at: "2026-10-19T08:00:00.000Z",
  },
  {
    id: 2,
    task_key: "email_generation",
    provider: null,
    model: null,
    prompt_tokens: 0,
    completion_tokens: 0,
    cost_usd: null,
    status: "template_only",
    error: null,
    latency_ms: 8,
    created_at: "2026-10-19T09:00:00.000Z",
  },
];
let aiUsageStore: Record<string, unknown>[] = [];

// ════════════════════════════════════════════════════════════════════════════
// 5) auth 长尾（忘记密码 / 重置密码 / bootstrap-admin）
// 形状真源：main.py:300-337（bootstrap）、595-670（forgot/reset）
// ════════════════════════════════════════════════════════════════════════════

/** mock 里"寄出去的重置令牌"：forgot 后写入，reset 只认它（前端拿不到真实邮件，
 *  开发时看 console 日志即可）。 */
let lastResetToken: string | null = null;

// ════════════════════════════════════════════════════════════════════════════
// 6) shipments（出货单）
// 形状真源：ws_shipments.py:134-156 `_row_to_shipment`
// ════════════════════════════════════════════════════════════════════════════

type MockShipment = Record<string, unknown> & { id: number };

function shipmentSeed(
  id: number,
  shipmentNo: string,
  status: string,
  orderId: number | null,
): MockShipment {
  return {
    id,
    shipment_no: shipmentNo,
    order_id: orderId,
    customer_id: 1,
    customer_name: "联佳丝网",
    consignee: "HANSA FENCE GMBH",
    notify_party: null,
    cargo_desc: "Galvanized chain link fence",
    cargo_qty: 120,
    cargo_qty_unit: "ROLLS",
    cargo_weight_kg: 17800,
    cargo_volume_cbm: 42,
    pol: "CNTJN",
    pod: "DEHAM",
    pol_name: "Tianjin",
    pod_name: "Hamburg",
    vessel: "COSCO SHIPPING",
    voyage: "V.026E",
    container_no: "CSNU1234567",
    so_no: null,
    booking_no: "BKG-2026-0001",
    bl_no: "COSU987654321",
    bl_type: "original",
    etd: "2026-09-20",
    eta: "2026-10-18",
    atd: "2026-09-20",
    ata: null,
    status,
    freight_remark: "freight prepaid",
    created_at: "2026-09-15T08:00:00.000Z",
    owner_id: "1",
    owner_scope: "tenant",
  };
}

let shipmentsStore: MockShipment[] = [];

// ════════════════════════════════════════════════════════════════════════════
// 7) research（市场调研：产品 / 统计 / 运行历史）
// 形状真源：chain.py:1830-2130（`_row_to_research` = 整行；stats 聚合）
// ════════════════════════════════════════════════════════════════════════════

const RESEARCH_CATEGORIES = [
  "chain_link_fence",
  "welded_mesh",
  "gabion",
  "temporary_fence",
  "security_fence",
  "farm_fence",
  "razor_wire",
  "hinge_joint_fence",
  "accessories",
  "other",
];

type MockResearchProduct = Record<string, unknown> & { id: number };

function researchSeed(
  id: number,
  name: string,
  country: string,
  category: string,
  canSupply: boolean | null,
): MockResearchProduct {
  return {
    id,
    tenant_id: "default",
    source_ref: null,
    source: "manual",
    product_name: name,
    product_name_cn: name,
    product_image_url: null,
    spec_raw: "wire 2.5mm, mesh 50x50mm",
    spec_normalized: { wire_diameter: 2.5, mesh: "50x50" },
    product_category: category,
    country,
    region: null,
    city: "Hamburg",
    shop_name: "HANSA FENCE GMBH",
    shop_type: "manufacturer",
    address: null,
    phone: null,
    email: null,
    website: "https://example.com",
    link_url: null,
    price_local: 12.5,
    price_currency: "EUR",
    market_note: null,
    can_supply: canSupply,
    supply_notes: null,
    research_status: "done",
    created_at: "2026-10-10T08:00:00.000Z",
    updated_at: "2026-10-12T08:00:00.000Z",
  };
}

let researchProductsStore: MockResearchProduct[] = [];
let researchRunsStore: Array<Record<string, unknown> & { id: number }> = [];

// ════════════════════════════════════════════════════════════════════════════
// 8) leadgen（线索池 / 开发运行）
// 形状真源：chain.py:940-1250（`_row_to_lead` 整行）。
// `demand_index`/`blank_index` **不在库里**（C8 的 `_lead_indices` 按地区聚合后
// 在 API 层回填），因此 store 不存这两个键；由 `leadOut()` 统一补示例值。
// ════════════════════════════════════════════════════════════════════════════

type MockLead = Record<string, unknown> & { id: number };

function leadSeed(
  id: number,
  company: string,
  country: string,
  email: string | null,
  website: string | null,
  fitScore: number,
  outreachStatus: string,
): MockLead {
  return {
    id,
    tenant_id: "default",
    place_id: `mock-place-${id}`,
    company_name: company,
    country,
    region: null,
    city: "Hamburg",
    address: null,
    phone: "+49-40-0000",
    website,
    email,
    industry: "fence & wire mesh",
    source: "manual",
    google_rating: 4.6,
    google_reviews: 128,
    fit_score: fitScore,
    fit_reasons: ["有邮箱 +40", "有官网 +25", "行业关键词匹配 +25"],
    opening_line: null,
    shop_type: "manufacturer",
    product_name: "Chain link fence",
    product_name_cn: "勾花网",
    product_image_url: null,
    spec_raw: null,
    link_url: null,
    can_supply: null,
    supply_notes: null,
    crawl_status: "pending",
    crawled_at: null,
    outreach_status: outreachStatus,
    inquiry_status: "none",
    created_at: "2026-10-05T08:00:00.000Z",
    updated_at: "2026-10-05T08:00:00.000Z",
  };
}

let leadsStore: MockLead[] = [];
let leadgenRunsStore: Array<Record<string, unknown> & { id: number }> = [];
/** 已跑过的配置 hash（同配置再跑返回 deduplicated=true，chain.py:991-1019） */
const leadgenRunHashes = new Set<string>();

// ════════════════════════════════════════════════════════════════════════════
// 9) outreach（发件邮箱 / 营销活动 / 邮件）
// 形状真源：chain.py:1374-1400（mailbox）、1487-1530（campaign）、1596-1660（message）
// ════════════════════════════════════════════════════════════════════════════

type MockMailbox = {
  id: number;
  email: string;
  name: string | null;
  provider: string;
  api_key: string | null;
  is_default: boolean;
  daily_limit: number | null;
  sent_today: number;
  last_sent_date: string | null;
  enabled: boolean;
};
let mailboxesStore: MockMailbox[] = [];

type MockCampaign = {
  id: number;
  name: string;
  subject_template: string;
  body_template: string;
  mailbox_id: number | null;
  status: string;
  total_count: number;
  sent_count: number;
  failed_count: number;
  created_at: string;
};
let campaignsStore: MockCampaign[] = [];

type MockMessage = {
  id: number;
  campaign_id: number | null;
  lead_id: number | null;
  to_email: string;
  to_name: string | null;
  subject: string;
  body_rendered: string;
  status: string;
  error: string | null;
  sent_at: string | null;
  opened_at: string | null;
  replied_at: string | null;
  created_at: string;
};
let messagesStore: MockMessage[] = [];

// ════════════════════════════════════════════════════════════════════════════
// 10) pricing-data（客户成本矩阵：可写单元）
// 形状真源：main.py:2078-2400（GET 矩阵 / POST 新版本 / DELETE 软删）
// ════════════════════════════════════════════════════════════════════════════

type MockPricingCell = {
  id: number;
  product_key: string;
  key: string;
  values: Record<string, string | number>;
  labels: Record<string, string>;
  amount: number;
  unit: string;
  effective_from: string;
  status: string;
};
let pricingCellsStore: MockPricingCell[] = [];
const PRICING_UNITS = new Set([
  "元/kg",
  "kg",
  "元/卷",
  "元/捆",
  "元/平方米",
  "元/个",
  "元/根",
]);

// ════════════════════════════════════════════════════════════════════════════
// 11) fx-rates（汇率；后端 GET 会刷新缓存，mock 直接回一条可用汇率）
// ════════════════════════════════════════════════════════════════════════════

let fxRatesStore: Array<Record<string, unknown>> = [];

// ════════════════════════════════════════════════════════════════════════════
// 种子 / 注册 / 持久化
// ════════════════════════════════════════════════════════════════════════════

/** 把长尾域 store 恢复成种子（`handlers.ts` 的 `seedMockData()` 调用）。 */
export function seedLongtailMockData(): void {
  longtailSeq = 1000;
  intelShipmentsStore = clone(INTEL_SHIPMENT_SEEDS);
  proposalsStore = clone(PROPOSAL_SEEDS);
  specSkuStore.clear();
  aiProvidersStore = Object.keys(AI_PROVIDER_DEFAULTS).map((provider) => ({
    provider,
    api_key: null,
    model: null,
    base_url: null,
    enabled: false,
  }));
  aiBindingsStore = AI_TASKS.map((task) => ({
    task_key: task.task_key,
    provider: task.recommended_provider,
    model: null,
    enabled: false,
    config: null,
  }));
  aiUsageStore = clone(AI_USAGE_SEEDS) as Array<Record<string, unknown>>;
  lastResetToken = null;
  shipmentsStore = [
    shipmentSeed(1, "SH-202609-0001", "in_transit", 1),
    shipmentSeed(2, "SH-202610-0002", "planned", null),
  ];
  researchProductsStore = [
    researchSeed(1, "Chain link fence", "DE", "chain_link_fence", true),
    researchSeed(2, "Welded mesh panel", "US", "welded_mesh", null),
  ];
  researchRunsStore = [
    {
      id: 1,
      tenant_id: "default",
      config: { action: "pick", source_ref: null },
      config_hash: "mock-run-1",
      status: "succeeded",
      leads_scanned: 3,
      products_found: 3,
      products_kept: 2,
      started_at: "2026-10-10T08:00:00.000Z",
      finished_at: "2026-10-10T08:01:00.000Z",
      created_by: "1",
      created_at: "2026-10-10T08:00:00.000Z",
    },
  ];
  leadsStore = [
    leadSeed(
      1,
      "HANSA FENCE GMBH",
      "DE",
      "sales@hansa-fence.example",
      "https://hansa-fence.example",
      90,
      "sent",
    ),
    leadSeed(
      2,
      "PACIFIC FENCE SUPPLY INC.",
      "US",
      "buyer@pacificfence.example",
      "https://pacificfence.example",
      65,
      "none",
    ),
    leadSeed(3, "SOUTHERN MESH PTY", "AU", null, null, 25, "replied"),
    leadSeed(
      4,
      "NORTHWIND SECURITY",
      "GB",
      "info@northwind.example",
      "https://northwind.example",
      50,
      "none",
    ),
  ];
  leadgenRunsStore = [
    {
      id: 1,
      tenant_id: "default",
      config: {
        region: "DE-NW",
        industry: "fence",
        icp: null,
        quantity: 10,
        source: "demo",
      },
      config_hash: "mock-leadgen-1",
      status: "succeeded",
      leads_found: 12,
      leads_kept: 4,
      error: null,
      started_at: "2026-10-05T08:00:00.000Z",
      finished_at: "2026-10-05T08:00:30.000Z",
      created_by: "1",
      created_at: "2026-10-05T08:00:00.000Z",
    },
  ];
  leadgenRunHashes.clear();
  mailboxesStore = [
    {
      id: 1,
      email: "export@kaas.example",
      name: "默认发件人",
      provider: "smtp",
      api_key: null,
      is_default: true,
      daily_limit: 100,
      sent_today: 3,
      last_sent_date: "2026-10-19",
      enabled: true,
    },
    {
      id: 2,
      email: "sales@kaas.example",
      name: "销售邮箱",
      provider: "smtp",
      api_key: null,
      is_default: false,
      daily_limit: 50,
      sent_today: 0,
      last_sent_date: null,
      enabled: false,
    },
  ];
  campaignsStore = [
    {
      id: 1,
      name: "德国市场开发",
      subject_template: "Factory-direct {{product}} — quick question",
      body_template: "Dear {{contact_name}}, ...",
      mailbox_id: 1,
      status: "draft",
      total_count: 0,
      sent_count: 0,
      failed_count: 0,
      created_at: "2026-10-18T08:00:00.000Z",
    },
  ];
  messagesStore = [
    {
      id: 1,
      campaign_id: 1,
      lead_id: 1,
      to_email: "sales@hansa-fence.example",
      to_name: "Hansa Fence",
      subject: "Factory-direct chain link fence",
      body_rendered: "Dear Hansa Fence, ...",
      status: "sent",
      error: null,
      sent_at: "2026-10-19T08:00:00.000Z",
      opened_at: null,
      replied_at: null,
      created_at: "2026-10-19T07:59:00.000Z",
    },
    {
      id: 2,
      campaign_id: 1,
      lead_id: 2,
      to_email: "buyer@pacificfence.example",
      to_name: "Pacific Fence",
      subject: "Factory-direct chain link fence",
      body_rendered: "Dear Pacific Fence, ...",
      status: "failed",
      error: "SMTP timeout",
      sent_at: null,
      opened_at: null,
      replied_at: null,
      created_at: "2026-10-19T08:01:00.000Z",
    },
    {
      id: 3,
      campaign_id: null,
      lead_id: 3,
      to_email: "info@southernmesh.example",
      to_name: "Southern Mesh",
      subject: "Factory-direct welded mesh",
      body_rendered: "Dear Southern Mesh, ...",
      status: "replied",
      error: null,
      sent_at: "2026-10-17T08:00:00.000Z",
      opened_at: "2026-10-17T09:00:00.000Z",
      replied_at: "2026-10-17T10:00:00.000Z",
      created_at: "2026-10-17T07:59:00.000Z",
    },
  ];
  pricingCellsStore = [];
  fxRatesStore = [];
}

/** 注册长尾域的可持久化集合（C5）。调用方：`handlers.ts` 的 bootstrap。 */
export function registerLongtailMockCollections(): void {
  registerMockCollection(
    "nameMappings",
    () => clone(nameMappingStore),
    (value) => {
      if (!Array.isArray(value)) return;
      nameMappingStore = clone(value as MockNameMapping[]);
      // 恢复持久化后把 id 序号推到最大 id 之后，否则新建行会和恢复的行撞 id
      nameMappingSeq =
        Math.max(0, ...nameMappingStore.map((row) => row.id)) + 1;
    },
  );
  registerMockCollection(
    "intelShipments",
    () => clone(intelShipmentsStore),
    (value) => {
      if (Array.isArray(value))
        intelShipmentsStore = clone(value as MockIntelShipment[]);
    },
  );
  registerMockCollection(
    "proposals",
    () => clone(proposalsStore),
    (value) => {
      if (Array.isArray(value)) proposalsStore = clone(value as MockProposal[]);
    },
  );
  registerMockCollection(
    "skus",
    () => [...specSkuStore.entries()],
    (value) => {
      if (!Array.isArray(value)) return;
      specSkuStore.clear();
      for (const entry of value) {
        if (Array.isArray(entry) && entry.length === 2) {
          specSkuStore.set(
            String(entry[0]),
            entry[1] as { sku_id: number; revision: number },
          );
        }
      }
    },
  );
  registerMockCollection(
    "aiProviders",
    () => clone(aiProvidersStore),
    (value) => {
      if (Array.isArray(value))
        aiProvidersStore = clone(value as MockAiProvider[]);
    },
  );
  registerMockCollection(
    "aiBindings",
    () => clone(aiBindingsStore),
    (value) => {
      if (Array.isArray(value))
        aiBindingsStore = clone(value as MockAiBinding[]);
    },
  );
  registerMockCollection(
    "shipments",
    () => clone(shipmentsStore),
    (value) => {
      if (Array.isArray(value)) shipmentsStore = clone(value as MockShipment[]);
    },
  );
  registerMockCollection(
    "researchProducts",
    () => clone(researchProductsStore),
    (value) => {
      if (Array.isArray(value))
        researchProductsStore = clone(value as MockResearchProduct[]);
    },
  );
  registerMockCollection(
    "researchRuns",
    () => clone(researchRunsStore),
    (value) => {
      if (Array.isArray(value))
        researchRunsStore = clone(value as typeof researchRunsStore);
    },
  );
  registerMockCollection(
    "leads",
    () => clone(leadsStore),
    (value) => {
      if (Array.isArray(value)) leadsStore = clone(value as MockLead[]);
    },
  );
  registerMockCollection(
    "leadgenRuns",
    () => clone(leadgenRunsStore),
    (value) => {
      if (Array.isArray(value))
        leadgenRunsStore = clone(value as typeof leadgenRunsStore);
    },
  );
  registerMockCollection(
    "mailboxes",
    () => clone(mailboxesStore),
    (value) => {
      if (Array.isArray(value)) mailboxesStore = clone(value as MockMailbox[]);
    },
  );
  registerMockCollection(
    "campaigns",
    () => clone(campaignsStore),
    (value) => {
      if (Array.isArray(value)) campaignsStore = clone(value as MockCampaign[]);
    },
  );
  registerMockCollection(
    "messages",
    () => clone(messagesStore),
    (value) => {
      if (Array.isArray(value)) messagesStore = clone(value as MockMessage[]);
    },
  );
  registerMockCollection(
    "pricingCells",
    () => clone(pricingCellsStore),
    (value) => {
      if (Array.isArray(value))
        pricingCellsStore = clone(value as MockPricingCell[]);
    },
  );
  registerMockCollection(
    "fxRates",
    () => clone(fxRatesStore),
    (value) => {
      if (Array.isArray(value))
        fxRatesStore = clone(value as Array<Record<string, unknown>>);
    },
  );
  registerMockCollection(
    "longtailSeq",
    () => ({ value: longtailSeq }),
    (value) => {
      const n = asRecord(value).value;
      if (typeof n === "number" && Number.isFinite(n)) longtailSeq = n;
    },
  );
  registerMockCollection(
    "authResetToken",
    () => ({ resetToken: lastResetToken }),
    (value) => {
      const token = asRecord(value).resetToken;
      lastResetToken = typeof token === "string" ? token : null;
    },
  );
}

// ── 小工具 ──────────────────────────────────────────────────────────────────

function nextId(): number {
  longtailSeq += 1;
  return longtailSeq;
}

function notFound(code: string, extra: Record<string, unknown> = {}) {
  return HttpResponse.json(
    { error: "not_found", code, ...extra },
    { status: 404 },
  );
}

function paginate<T>(items: T[], page: number, pageSize: number) {
  return {
    items: items.slice((page - 1) * pageSize, page * pageSize),
    total: items.length,
    page,
    page_size: pageSize,
  };
}

function parseIntParam(value: string | null, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function currencyRate(base: string, quote: string): number {
  const table: Record<string, number> = {
    "USD:CNY": 7.18,
    "EUR:CNY": 7.78,
    "CNY:USD": 0.139,
    "GBP:CNY": 9.12,
  };
  return table[`${base}:${quote}`] ?? 1;
}

/**
 * C8 四源计数（**mock 示例值**）：真实值由后端 `chain.py:_lead_indices` 按地区从
 * `intel_demand_index`（需求量）+ 四源已开发量（抓取/调研/触达/成交）算出，
 * 见 `backend/worker/tests/test_lead_indices.py`。mock 不做聚合，只给**确定性示例**，
 * 让该列在 mock/e2e 下可见（不再是恒 null，否则永远验不了展示）。
 */
function leadOut(lead: MockLead) {
  const demand = 120 + (lead.id % 5) * 30; // 120 / 150 / 180 / 210 / 240（示例）
  const developed = 20 + (lead.id % 4) * 15; // 20 / 35 / 50 / 65（示例：四源合计）
  return { ...lead, demand_index: demand, blank_index: demand - developed };
}

/** `_row_to_provider`（chain.py:558-565） */
function providerOut(p: MockAiProvider) {
  const defaults = AI_PROVIDER_DEFAULTS[p.provider];
  return {
    provider: p.provider,
    api_key_masked: p.api_key ? "sk-****" : null,
    has_key: Boolean(p.api_key),
    model: p.model,
    base_url: p.base_url,
    enabled: p.enabled,
    default_model: defaults?.model ?? null,
    default_base_url: defaults?.base_url ?? null,
  };
}

function bindingOut(b: MockAiBinding) {
  return {
    task_key: b.task_key,
    provider: b.provider,
    model: b.model,
    enabled: b.enabled,
    config: b.config,
    use_ai: b.enabled,
  };
}

function mailboxOut(m: MockMailbox) {
  return {
    id: m.id,
    email: m.email,
    name: m.name,
    provider: m.provider,
    api_key_masked: m.api_key ? "sk-****" : null,
    has_own_key: Boolean(m.api_key),
    is_default: m.is_default,
    daily_limit: m.daily_limit,
    sent_today: m.sent_today,
    last_sent_date: m.last_sent_date,
    enabled: m.enabled,
  };
}

function campaignOut(c: MockCampaign) {
  return { ...c };
}

function messageOut(m: MockMessage) {
  return { ...m };
}

// ════════════════════════════════════════════════════════════════════════════
// 报价 calculate / import / explain（用导出的产品公式数据自证口径）
// ════════════════════════════════════════════════════════════════════════════

type FormulaColumn = {
  key?: unknown;
  label?: unknown;
  label_en?: unknown;
  decimals?: unknown;
  internal?: unknown;
};

function formulasOf(productKey: string) {
  return (MOCK_EXPORT_FORMULAS as Record<string, unknown>)[productKey] as
    | Record<string, unknown>
    | undefined;
}

function columnsOf(
  formulas: Record<string, unknown>,
  view: "customer" | "internal",
) {
  const cols = (formulas.columns as FormulaColumn[] | undefined) ?? [];
  return view === "internal" ? cols : cols.filter((c) => c.internal !== true);
}

/** 单元格取值：只对**行项落库需要的几列**给业务上说得通的值，其余按列族给 0/原值。 */
function cellFor(
  key: string,
  productName: string,
  spec: Record<string, unknown>,
): unknown {
  if (key === "index") return 1;
  if (key === "spec.product_name") return productName;
  if (key.startsWith("spec.")) {
    const value = spec[key.slice("spec.".length)];
    return value === undefined ? null : value;
  }
  if (key === "piece.price_per_piece_fx") return 301.03;
  if (key === "derived.weight_per_piece_kg") return 42.5;
  if (key === "derived.volume_box_per_piece_m3") return 0.31;
  if (key === "derived.area_per_piece_m2") return 30;
  if (key.startsWith("price.")) return 10.1;
  if (key.startsWith("piece.")) return 300;
  if (key.startsWith("derived.")) return 1;
  return null;
}

/**
 * 构造 `ExportQuoteResponse`（契约 `shared/contracts/export-quote.ts`）。
 *
 * ⚠️ 与真实引擎的差异：mock **不跑价链**，只把产品定义里的列按一行填上合理数值，
 * 让 `/quotes` 的"估算行 → 报价单行项"链路能走通（`buildLineItem` 读的那三列有值）。
 * 金额是示例值，不是真实成本；页面上的"估算"语义在这里仍然成立。
 */
function mockCalculateResponse(
  productKey: string,
  body: Record<string, unknown>,
  view: "customer" | "internal",
) {
  const formulas = formulasOf(productKey);
  if (!formulas) return null;
  const product = MOCK_EXPORT_PRODUCTS.find((p) => p.key === productKey);
  const productName = (product?.name as string | undefined) ?? productKey;
  const spec = asRecord(
    body.spec ??
      (Array.isArray(body.spec_rows) ? body.spec_rows[0] : undefined) ??
      {},
  );
  const orderQty = (() => {
    const orders = body.orders;
    if (Array.isArray(orders) && orders.length > 0) {
      const total = asRecord(orders[0]).total;
      if (typeof total === "number" && total > 0) return total;
    }
    return 1;
  })();

  const table = (tableView: "customer" | "internal", labels: "zh" | "en") => {
    const cols = columnsOf(formulas, tableView);
    return {
      view: tableView,
      header: cols.map((c) =>
        labels === "en"
          ? String(c.label_en ?? c.label ?? c.key ?? "")
          : String(c.label ?? c.key ?? ""),
      ),
      rows: [cols.map((c) => cellFor(String(c.key ?? ""), productName, spec))],
      decimals: cols.map((c) =>
        typeof c.decimals === "number" ? c.decimals : null,
      ),
      horizontal_header: [],
      vertical_header: [],
      vertical_data: [],
    };
  };

  const quoteDate = String(
    body.quote_date ?? new Date().toISOString().slice(0, 10),
  );
  const validityDays =
    typeof body.validity_days === "number" ? body.validity_days : 30;
  const validUntil = new Date(
    Date.parse(`${quoteDate}T00:00:00Z`) + validityDays * 86400000,
  )
    .toISOString()
    .slice(0, 10);

  return {
    meta: {
      product_key: productKey,
      product_name: productName,
      product_name_en: String(product?.name_en ?? productName),
      quote_date: quoteDate,
      valid_until: validUntil,
      validity_days: validityDays,
      fx_rate: String(body.fx_rate ?? 7.18),
      fx_source: String(body.fx_source ?? "manual"),
      currency: String(body.currency ?? "CNY"),
      quote_currency: String(body.quote_currency ?? "USD"),
      rate_set_code: "",
      term_codes: [],
      quote_as: "",
      combo_count: 0,
      orders: [
        {
          name: "order_1",
          label: "数量",
          label_en: "Qty",
          total: orderQty,
          unit: "ROLLS",
        },
      ],
      main_term_summary: {},
      term_totals: {},
      diagnostics: ["mock 算价：数值为示例口径（未跑真实价链）"],
    },
    view,
    customer: table("customer", "zh"),
    customer_en: table("customer", "en"),
    ...(view === "internal" ? { internal: table("internal", "zh") } : {}),
  };
}

function importTemplateInfo(productKey: string) {
  const formulas = formulasOf(productKey);
  if (!formulas) return null;
  const product = MOCK_EXPORT_PRODUCTS.find((p) => p.key === productKey);
  const cols = columnsOf(formulas, "customer").filter((c) => {
    const key = String(c.key ?? "");
    return key.startsWith("spec.") || key === "derived.weight_per_piece_kg";
  });
  const headers = cols.map((c) => String(c.label ?? c.key ?? ""));
  const base = `/api/v1/export-quote/products/${encodeURIComponent(productKey)}/import-template`;
  return {
    product_key: productKey,
    product_name: (product?.name as string | undefined) ?? productKey,
    columns: cols.map((c) => ({
      header: String(c.label ?? c.key ?? ""),
      kind: "scalar" as const,
      target: String(c.key ?? ""),
      required: String(c.key ?? "").startsWith("spec."),
      unit: "",
      options: [],
      note: "",
    })),
    headers,
    required_headers: headers.filter(
      (h) => h !== "产品" && h !== "单件重量(kg)",
    ),
    max_rows: 200,
    max_mb: 5,
    sheets: ["报价", "说明"],
    data_sheet: "报价",
    download: {
      csv: `${base}?format=csv`,
      xlsx: `${base}?format=xlsx`,
    },
    notes: [
      "mock：列定义取自产品公式定义（示例）；模板下载由前端 exceljs 生成",
      "每行一条规格，数量列按卷数填写",
    ],
  };
}

/** 导入预览/计算的示例行（mock 不解析上传文件，固定返回 1 行示例并标注原因） */
function sampleSpecRow(columns: Array<Record<string, unknown>>) {
  const row: Record<string, unknown> = {};
  for (const col of columns) {
    const target = String(col.target ?? "");
    if (!target.startsWith("spec.")) continue;
    const key = target.slice("spec.".length);
    row[key] = key === "product_name" ? "Chain link fence" : 1.5;
  }
  return row;
}

/** 上传前的服务端校验（真源 quote_api.py:943-963 `_read_upload` / `_parse_or_400`）。
 *  只校验**能在不解析表格的前提下判断**的失败：空文件 / .xls / 超限 / 缺 file 字段；
 *  真正的表头/单位解析 mock 不做（见 preview handler 的 warning 说明）。 */
const IMPORT_MAX_MB = 2;

function importUploadError(form: FormData): {
  detail: { error: string; message: string };
} | null {
  const file = form.get("file");
  if (!file || typeof file === "string") {
    return {
      detail: { error: "empty_file", message: "上传的文件是空的" },
    };
  }
  const blob = file as File;
  if (blob.size === 0) {
    return {
      detail: { error: "empty_file", message: "上传的文件是空的" },
    };
  }
  if (blob.size > IMPORT_MAX_MB * 1024 * 1024) {
    return {
      detail: {
        error: "file_too_large",
        message: `文件过大（${(blob.size / 1048576).toFixed(1)} MB），上限 ${IMPORT_MAX_MB} MB`,
      },
    };
  }
  if (blob.name.toLowerCase().endsWith(".xls")) {
    return {
      detail: {
        error: "parse_error",
        message:
          "不支持老的 .xls 格式；请在 Excel 里另存为 .xlsx（或 CSV UTF-8）后再上传",
      },
    };
  }
  return null;
}

/** 成本参考：从 mock 定价单元取同产品 + 同规格的"最近一次成本"
 *  （真源 main.py:1931-2010；mock 没有 quote_order_items，用定价单元等价表达）。 */
export function mockCostReference(
  productKey: string,
  spec: Record<string, unknown>,
) {
  const cells = pricingCellsStore.filter(
    (c) => c.product_key === productKey && c.status === "active",
  );
  const same = cells.find(
    (c) => JSON.stringify(c.values) === JSON.stringify(spec),
  );
  if (!same) return null;
  return {
    cost: same.amount,
    cost_unit: same.unit,
    source: "latest",
    sample_count: 1,
    as_of: same.effective_from,
    quote_no: null,
    spec_snapshot: null,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// handlers
// ════════════════════════════════════════════════════════════════════════════

export const longtailHandlers = [
  // ── intel ────────────────────────────────────────────────────────────────
  http.get("/api/v1/intel/shipments", ({ request }) => {
    const url = new URL(request.url);
    const shipper = url.searchParams.get("shipper");
    const consignee = url.searchParams.get("consignee");
    const destCountry = url.searchParams.get("dest_country");
    const hsCode = url.searchParams.get("hs_code");
    let items = intelShipmentsStore.slice();
    if (shipper)
      items = items.filter((s) =>
        String(s.shipper).toLowerCase().includes(shipper.toLowerCase()),
      );
    if (consignee)
      items = items.filter((s) =>
        String(s.consignee).toLowerCase().includes(consignee.toLowerCase()),
      );
    if (destCountry)
      items = items.filter((s) =>
        String(s.dest_country)
          .toLowerCase()
          .includes(destCountry.toLowerCase()),
      );
    if (hsCode) items = items.filter((s) => s.hs_code === hsCode);
    const page = parseIntParam(url.searchParams.get("page"), 1);
    const pageSize = parseIntParam(url.searchParams.get("page_size"), 20);
    return HttpResponse.json(paginate(items, page, pageSize));
  }),

  http.get("/api/v1/intel/shipments/:shipmentId", ({ params }) => {
    const row = intelShipmentsStore.find(
      (s) => s.id === Number(params.shipmentId),
    );
    if (!row) {
      return HttpResponse.json(
        { detail: "Shipment not found" },
        { status: 404 },
      );
    }
    return HttpResponse.json(row);
  }),

  http.get("/api/v1/intel/trade-stats", ({ request }) => {
    const url = new URL(request.url);
    const hsCode = url.searchParams.get("hs_code");
    const partner = url.searchParams.get("partner_country");
    let rows = INTEL_TRADE_STATS.slice();
    if (hsCode) rows = rows.filter((r) => r.hs_code === hsCode);
    if (partner)
      rows = rows.filter((r) =>
        r.partner_country.toLowerCase().includes(partner.toLowerCase()),
      );
    // 后端直接返回数组（main.py:996-1001）
    return HttpResponse.json(rows);
  }),

  http.get("/api/v1/intel/adapter-runs", ({ request }) => {
    const url = new URL(request.url);
    const status = url.searchParams.get("status");
    const rows = status
      ? INTEL_ADAPTER_RUNS.filter((r) => r.status === status)
      : INTEL_ADAPTER_RUNS;
    return HttpResponse.json(rows);
  }),

  http.get("/api/v1/intel/channels", () =>
    HttpResponse.json({
      free_channels: INTEL_CHANNELS.filter((c) => c.tier === "free"),
      paid_channels: INTEL_CHANNELS.filter((c) => c.tier === "paid").map(
        (c) => ({
          ...c,
          message: c.is_enabled ? "已开通" : "未开通",
        }),
      ),
    }),
  ),

  // C36 #16：手工新增情报货运（形状 = main.py:189 ShipmentCreate / 990 create_shipment）
  http.post("/api/v1/intel/shipments", async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const required = ["shipper", "consignee", "product_desc"];
    const missing = required.filter(
      (key) => typeof body[key] !== "string" || String(body[key]).trim() === "",
    );
    if (missing.length > 0) {
      return HttpResponse.json(
        {
          detail: missing.map((key) => ({
            loc: ["body", key],
            msg: "Field required",
            type: "missing",
          })),
        },
        { status: 422 },
      );
    }
    const now = nowIso();
    const row: MockIntelShipment = {
      ...body,
      id: nextId(),
      tenant_id: "default",
      source_channel: "manual",
      source_ref: null,
      is_verified: false,
      created_by: "mock",
      created_at: now,
      updated_at: now,
    };
    intelShipmentsStore.unshift(row);
    return HttpResponse.json(row, { status: 201 });
  }),

  // C36 #15：情报货运 CSV 导入（multipart，字段名 `file`；形状 = main.py:1005 import_csv）
  http.post("/api/v1/intel/import/csv", async ({ request }) => {
    const form = await request.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) {
      return HttpResponse.json(
        { detail: "缺少 file 字段（multipart，字段名必须是 file）" },
        { status: 422 },
      );
    }
    const alias: Record<string, string> = {
      shipper: "shipper",
      发货人: "shipper",
      exporter: "shipper",
      consignee: "consignee",
      收货人: "consignee",
      importer: "consignee",
      product_desc: "product_desc",
      产品描述: "product_desc",
      产品: "product_desc",
      goods: "product_desc",
      ship_date: "ship_date",
      日期: "ship_date",
      date: "ship_date",
      dest_country: "dest_country",
      目的国: "dest_country",
      destination: "dest_country",
      origin_country: "origin_country",
      原产国: "origin_country",
      hs_code: "hs_code",
      hs编码: "hs_code",
      qty: "qty",
      数量: "qty",
      qty_unit: "qty_unit",
      单位: "qty_unit",
      carrier: "carrier",
      承运人: "carrier",
      bl_no: "bl_no",
      提单号: "bl_no",
    };
    const text = await (file as File).text();
    const lines = text
      .replace(/^\uFEFF/, "")
      .split(/\r?\n/)
      .filter((line) => line.trim() !== "");
    const header = (lines[0] ?? "").split(",").map((cell) => cell.trim());
    const errors: Array<{ row: number; error: string }> = [];
    let inserted = 0;
    let processed = 0;
    const now = nowIso();
    for (let index = 1; index < lines.length; index += 1) {
      processed = index;
      const cells = lines[index]!.split(",").map((cell) => cell.trim());
      const row: Record<string, string> = {};
      header.forEach((head, headIndex) => {
        const mapped = alias[head.toLowerCase()] ?? alias[head] ?? undefined;
        const value = cells[headIndex] ?? "";
        if (mapped && value !== "") row[mapped] = value;
      });
      if (
        !("shipper" in row) ||
        !("consignee" in row) ||
        !("product_desc" in row)
      ) {
        errors.push({
          row: index + 1,
          error: "缺少必填字段 (shipper/consignee/product_desc)",
        });
        continue;
      }
      intelShipmentsStore.unshift({
        ...row,
        id: nextId(),
        tenant_id: "default",
        source_channel: "manual_csv",
        source_ref: (file as File).name,
        is_verified: false,
        created_by: "mock",
        created_at: now,
        updated_at: now,
      });
      inserted += 1;
    }
    return HttpResponse.json({
      status: "success",
      processed,
      inserted,
      errors: errors.length,
      error_details: errors.slice(0, 10),
    });
  }),

  // ── market ───────────────────────────────────────────────────────────────
  http.get("/api/v1/market/regions", () =>
    HttpResponse.json(MARKET_REGIONS.slice()),
  ),

  http.get("/api/v1/market/regions/:regionCode/products", ({ params }) => {
    const code = String(params.regionCode).toUpperCase();
    return HttpResponse.json(MARKET_REGION_PRODUCTS[code] ?? []);
  }),

  // ── 品名对照（B2：分页列表 + 编辑 + 删除；契约 main.py:2030-2135）───────────
  // 四口共用 `nameMappingStore`（种子 MARKET_NAME_MAPPINGS），避免"列表读种子、写入
  // 另一个数组"的假正向；name-lookup 也读同一个 store（刚建的对照能被品名反查命中）。
  //  · GET 列表 → `{items,total,page,page_size}`；空 q = 最近记录；q 对品名/别名 ILIKE；
  //    region_code upper、lang 精确；排序 `is_verified DESC, created_at DESC`；
  //  · POST 201（唯一冲突 409）；PATCH 部分字段（空 body 422、冲突 409、不存在 404）；
  //  · DELETE 204（不存在 404）。
  http.get("/api/v1/market/name-lookup", ({ request }) => {
    const url = new URL(request.url);
    const q = (url.searchParams.get("q") ?? "").trim();
    if (!q) {
      return HttpResponse.json({ detail: "q is required" }, { status: 422 });
    }
    return HttpResponse.json(filterNameMappings(url));
  }),

  http.get("/api/v1/market/name-mappings", ({ request }) => {
    const url = new URL(request.url);
    const page = Math.max(1, Number(url.searchParams.get("page") ?? 1) || 1);
    const pageSize = Math.min(
      100,
      Math.max(1, Number(url.searchParams.get("page_size") ?? 20) || 20),
    );
    const matched = filterNameMappings(url);
    const start = (page - 1) * pageSize;
    return HttpResponse.json({
      items: matched.slice(start, start + pageSize),
      total: matched.length,
      page,
      page_size: pageSize,
    });
  }),

  http.post("/api/v1/market/name-mappings", async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const region = String(body.region_code ?? "")
      .trim()
      .toUpperCase();
    const lang = String(body.lang ?? "").trim();
    const localName = String(body.local_name ?? "").trim();
    if (!region || !lang || !localName) {
      return HttpResponse.json(
        {
          detail: {
            error: "validation",
            code: "NAME_MAPPING_REQUIRED",
            detail: "region_code / lang / local_name 必填",
          },
        },
        { status: 422 },
      );
    }
    const categoryId =
      body.category_id === null || body.category_id === undefined
        ? null
        : Number(body.category_id);
    const conflict =
      categoryId !== null &&
      nameMappingStore.some(
        (row) =>
          row.category_id === categoryId &&
          row.region_code === region &&
          row.lang === lang,
      );
    if (conflict) {
      return HttpResponse.json(
        {
          detail: {
            error: "conflict",
            code: "NAME_MAPPING_CONFLICT",
            detail: "同一地区 + 语言 + 类目已存在品名对照",
          },
        },
        { status: 409 },
      );
    }
    const row: MockNameMapping = {
      id: nextNameMappingId(),
      category_id: Number.isFinite(categoryId) ? categoryId : null,
      region_code: region,
      lang,
      local_name: localName,
      alt_names: Array.isArray(body.alt_names)
        ? body.alt_names.map((a) => String(a))
        : [],
      hs_code: typeof body.hs_code === "string" ? body.hs_code : null,
      source: typeof body.source === "string" ? body.source : "manual",
      confidence: typeof body.confidence === "string" ? body.confidence : null,
      is_verified: body.is_verified === true,
      created_at: nowIso(),
    };
    nameMappingStore.push(row);
    return HttpResponse.json(row, { status: 201 });
  }),

  http.patch(
    "/api/v1/market/name-mappings/:id",
    async ({ request, params }) => {
      const id = Number(params.id);
      const index = nameMappingStore.findIndex((row) => row.id === id);
      if (index < 0) {
        return HttpResponse.json(
          { detail: { error: "not_found", code: "NAME_MAPPING_NOT_FOUND" } },
          { status: 404 },
        );
      }
      const body = (await request.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      const patch: Partial<MockNameMapping> = {};
      // 只改 body 里出现的字段（pydantic model_fields_set 语义；空 body → 422）
      if ("category_id" in body)
        patch.category_id =
          body.category_id === null || body.category_id === undefined
            ? null
            : Number(body.category_id);
      if ("region_code" in body)
        patch.region_code = String(body.region_code ?? "")
          .trim()
          .toUpperCase();
      if ("lang" in body) patch.lang = String(body.lang ?? "").trim();
      if ("local_name" in body)
        patch.local_name = String(body.local_name ?? "").trim();
      if ("alt_names" in body)
        patch.alt_names = Array.isArray(body.alt_names)
          ? body.alt_names.map((a) => String(a))
          : [];
      if ("hs_code" in body)
        patch.hs_code = typeof body.hs_code === "string" ? body.hs_code : null;
      if ("source" in body) patch.source = String(body.source ?? "");
      if ("confidence" in body)
        patch.confidence =
          typeof body.confidence === "string" ? body.confidence : null;
      if ("is_verified" in body) patch.is_verified = body.is_verified === true;
      if (Object.keys(patch).length === 0) {
        return HttpResponse.json(
          { detail: "No fields to update" },
          { status: 422 },
        );
      }
      const next: MockNameMapping = {
        ...nameMappingStore[index]!,
        ...patch,
        updated_at: nowIso(),
      };
      // 唯一键 (tenant, category_id, region_code, lang)；category_id 为 NULL 不参与唯一约束
      if (
        next.category_id !== null &&
        nameMappingStore.some(
          (row) =>
            row.id !== id &&
            row.category_id === next.category_id &&
            row.region_code === next.region_code &&
            row.lang === next.lang,
        )
      ) {
        return HttpResponse.json(
          { detail: { error: "conflict", code: "NAME_MAPPING_EXISTS" } },
          { status: 409 },
        );
      }
      nameMappingStore[index] = next;
      return HttpResponse.json(next);
    },
  ),

  http.delete("/api/v1/market/name-mappings/:id", ({ params }) => {
    const id = Number(params.id);
    const index = nameMappingStore.findIndex((row) => row.id === id);
    if (index < 0) {
      return HttpResponse.json(
        { detail: { error: "not_found", code: "NAME_MAPPING_NOT_FOUND" } },
        { status: 404 },
      );
    }
    nameMappingStore.splice(index, 1);
    return new HttpResponse(null, { status: 204 });
  }),

  // 注意：前端抽到的归一化路径是 `/market/ports*`（`/market/ports${params}`，
  // params 可能是空串或 `?country_code=`）⇒ handler 必须用同形 wildcard 才能被门禁识别，
  // 也正好覆盖带 query 与不带 query 两种请求（MSW 按 pathname 匹配）。
  http.get("/api/v1/market/ports*", ({ request }) => {
    const url = new URL(request.url);
    const country = url.searchParams.get("country_code");
    const type = url.searchParams.get("port_type");
    let rows = MARKET_PORTS.slice();
    if (country)
      rows = rows.filter((p) => p.country_code === country.toUpperCase());
    if (type) rows = rows.filter((p) => p.port_type === type);
    return HttpResponse.json(rows);
  }),

  http.get("/api/v1/market/usages", () =>
    HttpResponse.json(MARKET_USAGES.slice()),
  ),

  // ── spec-config ──────────────────────────────────────────────────────────
  http.get("/api/v1/spec/categories", () =>
    HttpResponse.json({ items: SPEC_CATEGORY_TREE }),
  ),

  http.get("/api/v1/spec/categories/:categoryId", ({ params }) => {
    const id = Number(params.categoryId);
    const find = (nodes: MockCategoryNode[]): MockCategoryNode | null => {
      for (const node of nodes) {
        if (node.id === id) return node;
        const hit = find(node.children);
        if (hit) return hit;
      }
      return null;
    };
    const node = find(SPEC_CATEGORY_TREE);
    // 后端对缺失分类返回 200 `{"error":"not_found"}`（main.py:2606-2618）
    if (!node) return HttpResponse.json({ error: "not_found" });
    return HttpResponse.json(node);
  }),

  http.get("/api/v1/spec/categories/:categoryId/bindings", ({ params }) => {
    const id = Number(params.categoryId);
    return HttpResponse.json({ items: SPEC_BINDINGS[id] ?? [] });
  }),

  // POST /spec/wizard/submit ← use-wizard-submit.ts:14
  // 形状 = main.py:2679-2745（`{sku_id, price_id, spec_hash, is_new_sku, revision}`）；
  // mock 用 "category:hash" 做幂等命中，与后端 spec_hash 同语义。
  http.post("/api/v1/spec/wizard/submit", async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const categoryId = body.category_id;
    const specValues = asRecord(body.spec_values);
    if (
      typeof categoryId !== "number" ||
      Object.keys(specValues).length === 0
    ) {
      return HttpResponse.json(
        { detail: "category_id and spec_values are required" },
        { status: 422 },
      );
    }
    const hash = `mock:${categoryId}:${JSON.stringify(specValues)}`;
    const existing = specSkuStore.get(hash);
    if (existing) {
      return HttpResponse.json({
        sku_id: existing.sku_id,
        price_id: null,
        spec_hash: hash,
        is_new_sku: false,
        revision: existing.revision,
      });
    }
    const skuId = nextId();
    specSkuStore.set(hash, { sku_id: skuId, revision: 1 });
    return HttpResponse.json(
      {
        sku_id: skuId,
        price_id: null,
        spec_hash: hash,
        is_new_sku: true,
        revision: 1,
      },
      { status: 200 },
    );
  }),

  // POST /spec/wizard/propose-attribute ← use-wizard-submit.ts:37
  // 形状 = main.py:2749-2795（`{id, status}`）；提案落同一个 store ⇒ 管理员页能看到。
  http.post("/api/v1/spec/wizard/propose-attribute", async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const categoryId = body.category_id;
    const proposedName = String(body.proposed_name ?? "").trim();
    if (typeof categoryId !== "number" || !proposedName) {
      return HttpResponse.json(
        { detail: "category_id and proposed_name are required" },
        { status: 422 },
      );
    }
    const proposal: MockProposal = {
      id: nextId(),
      tenant_id: "default",
      category_id: categoryId,
      proposed_name: proposedName,
      proposed_type: String(body.proposed_type ?? "string"),
      group_code: String(body.group_code ?? ""),
      status: "pending",
      occurrence_count: 1,
      recommended_for_promotion: false,
      recommendation_score: null,
      recommended_at: null,
      created_at: nowIso(),
    };
    proposalsStore.unshift(proposal);
    return HttpResponse.json({ id: proposal.id, status: proposal.status });
  }),

  // ── admin 属性提案 ───────────────────────────────────────────────────────
  http.get("/api/v1/admin/spec/attribute-proposals", ({ request }) => {
    const status = new URL(request.url).searchParams.get("status");
    const rows = status
      ? proposalsStore.filter((p) => p.status === status)
      : proposalsStore;
    return HttpResponse.json({ items: rows.map((p) => ({ ...p })) });
  }),

  http.get("/api/v1/admin/spec/attribute-proposals/recommended", () => {
    const items = proposalsStore
      .filter((p) => p.recommended_for_promotion && p.status === "pending")
      .sort(
        (a, b) => (b.recommendation_score ?? 0) - (a.recommendation_score ?? 0),
      )
      .map((p) => ({
        id: p.id,
        tenant_id: p.tenant_id,
        proposed_name: p.proposed_name,
        recommendation_score: p.recommendation_score,
        recommended_at: p.recommended_at,
      }));
    return HttpResponse.json({ items });
  }),

  http.patch(
    "/api/v1/admin/spec/attribute-proposals/:proposalId",
    async ({ params, request }) => {
      const body = (await request.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      const action = body.action;
      const proposal = proposalsStore.find(
        (p) => p.id === Number(params.proposalId),
      );
      // 后端对不存在/非法动作回 200 `{error}`（ws_admin_proposals.py:120/196）
      if (!proposal) return HttpResponse.json({ error: "not_found" });
      if (action === "approve") {
        proposal.status = "promoted";
        return HttpResponse.json({
          id: proposal.id,
          status: "promoted",
          promoted_attribute_id: nextId(),
        });
      }
      if (action === "reject") {
        proposal.status = "rejected";
        return HttpResponse.json({ id: proposal.id, status: "rejected" });
      }
      if (action === "merge") {
        proposal.status = "merged";
        return HttpResponse.json({
          id: proposal.id,
          status: "merged",
          merged_into: body.target_attribute_id ?? null,
        });
      }
      return HttpResponse.json({ error: "invalid_action" });
    },
  ),

  // ── ai-providers ─────────────────────────────────────────────────────────
  http.get("/api/v1/ai/tasks", () =>
    HttpResponse.json({ items: AI_TASKS.map((t) => ({ ...t })) }),
  ),

  // C36 #13：手动运行任务。契约 = `chain.py:751 run_ai_task`：
  //   body `{payload:{}}` → 200 `{result, path, task, latency_ms?}`
  //   · 绑定未启用/服务商无密钥 ⇒ `path="template"`（模板兜底，**无 latency_ms**）
  //   · 启用且服务商可用 ⇒ `path="ai:<provider>"` + `latency_ms`
  //   · 未知任务 ⇒ 404 `UNKNOWN_TASK`
  // 每次运行都记一条 ai_usage（与真实后端"全程落 usage"一致），页面刷新用量即可看到。
  http.post("/api/v1/ai/tasks/:taskKey/run", async ({ params, request }) => {
    const taskKey = String(params.taskKey);
    if (!AI_TASKS.some((t) => t.task_key === taskKey)) {
      return HttpResponse.json(
        {
          detail: {
            error: "not_found",
            code: "UNKNOWN_TASK",
            task_key: taskKey,
          },
        },
        { status: 404 },
      );
    }
    const body = (await request.json().catch(() => ({}))) as {
      payload?: Record<string, unknown>;
    };
    const payload = body.payload ?? {};
    const binding = aiBindingsStore.find((b) => b.task_key === taskKey);
    const provider = binding?.enabled
      ? aiProvidersStore.find(
          (p) =>
            p.provider === binding.provider && p.enabled && Boolean(p.api_key),
        )
      : undefined;
    const started = Date.now();
    const latency = Math.max(1, ((Date.now() - started) % 900) + 120);
    const result = provider
      ? { ok: true, task_key: taskKey, payload, provider: provider.provider }
      : { ok: true, task_key: taskKey, payload, template: true };
    aiUsageStore.push({
      id: aiUsageStore.length + AI_USAGE_SEEDS.length + 1,
      task_key: taskKey,
      provider: provider?.provider ?? null,
      model: provider?.model ?? null,
      prompt_tokens: 0,
      completion_tokens: 0,
      cost_usd: null,
      status: provider ? "success" : "template_only",
      error: null,
      latency_ms: latency,
      created_at: new Date().toISOString(),
    });
    return HttpResponse.json(
      provider
        ? {
            result,
            path: `ai:${provider.provider}`,
            task: taskKey,
            latency_ms: latency,
          }
        : { result, path: "template", task: taskKey },
    );
  }),

  http.get("/api/v1/ai/providers", () =>
    HttpResponse.json({ items: aiProvidersStore.map(providerOut) }),
  ),

  http.put("/api/v1/ai/providers/:name", async ({ params, request }) => {
    const name = String(params.name);
    if (!(name in AI_PROVIDER_DEFAULTS)) {
      return HttpResponse.json(
        {
          detail: {
            error: "validation",
            code: "BAD_PROVIDER",
            allowed: Object.keys(AI_PROVIDER_DEFAULTS),
          },
        },
        { status: 422 },
      );
    }
    const body = (await request.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    let provider = aiProvidersStore.find((p) => p.provider === name);
    if (!provider) {
      provider = {
        provider: name,
        api_key: null,
        model: null,
        base_url: null,
        enabled: false,
      };
      aiProvidersStore.push(provider);
    }
    if (typeof body.api_key === "string") {
      provider.api_key = body.api_key.trim() ? body.api_key.trim() : null;
    }
    if (typeof body.model === "string") {
      provider.model = body.model.trim() ? body.model.trim() : null;
    }
    if (typeof body.base_url === "string") {
      provider.base_url = body.base_url.trim() ? body.base_url.trim() : null;
    }
    if (typeof body.enabled === "boolean") provider.enabled = body.enabled;
    return HttpResponse.json(providerOut(provider));
  }),

  http.post("/api/v1/ai/providers/:name/test", ({ params }) => {
    const name = String(params.name);
    if (!(name in AI_PROVIDER_DEFAULTS)) {
      return HttpResponse.json(
        { detail: { error: "validation", code: "BAD_PROVIDER" } },
        { status: 422 },
      );
    }
    const provider = aiProvidersStore.find((p) => p.provider === name);
    if (!provider?.api_key) {
      // 后端无 key ⇒ 400 NO_API_KEY（chain.py:608-618）
      return HttpResponse.json(
        { detail: { error: "bad_request", code: "NO_API_KEY" } },
        { status: 400 },
      );
    }
    return HttpResponse.json({
      ok: true,
      latency_ms: 42,
      reply: "ok",
      usage: { prompt_tokens: 8, completion_tokens: 2 },
    });
  }),

  http.get("/api/v1/ai/task-bindings", () =>
    HttpResponse.json({ items: aiBindingsStore.map(bindingOut) }),
  ),

  http.put("/api/v1/ai/task-bindings/:taskKey", async ({ params, request }) => {
    const taskKey = String(params.taskKey);
    if (!AI_TASKS.some((t) => t.task_key === taskKey)) {
      return HttpResponse.json(
        { detail: { error: "not_found", code: "UNKNOWN_TASK" } },
        { status: 404 },
      );
    }
    const body = (await request.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    let binding = aiBindingsStore.find((b) => b.task_key === taskKey);
    if (!binding) {
      const meta = AI_TASKS.find((t) => t.task_key === taskKey);
      binding = {
        task_key: taskKey,
        provider: meta?.recommended_provider ?? "deepseek",
        model: null,
        enabled: false,
        config: null,
      };
      aiBindingsStore.push(binding);
    }
    if (typeof body.provider === "string") binding.provider = body.provider;
    if (typeof body.model === "string") {
      binding.model = body.model.trim() ? body.model.trim() : null;
    }
    if (typeof body.enabled === "boolean") binding.enabled = body.enabled;
    if (typeof body.config === "object" && body.config !== null) {
      binding.config = body.config as Record<string, unknown>;
    }
    return HttpResponse.json(bindingOut(binding));
  }),

  http.get("/api/v1/ai/usage", ({ request }) => {
    const url = new URL(request.url);
    const taskKey = url.searchParams.get("task_key");
    const provider = url.searchParams.get("provider");
    const status = url.searchParams.get("status");
    let rows = aiUsageStore.slice();
    if (taskKey) rows = rows.filter((r) => r.task_key === taskKey);
    if (provider) rows = rows.filter((r) => r.provider === provider);
    if (status) rows = rows.filter((r) => r.status === status);
    const page = parseIntParam(url.searchParams.get("page"), 1);
    const pageSize = parseIntParam(url.searchParams.get("page_size"), 20);
    const stats = new Map<
      string,
      {
        task_key: string;
        provider: string | null;
        status: string;
        count: number;
        prompt_tokens: number;
        completion_tokens: number;
      }
    >();
    for (const row of aiUsageStore) {
      const key = `${row.task_key}|${row.provider}|${row.status}`;
      const entry = stats.get(key) ?? {
        task_key: String(row.task_key),
        provider: (row.provider as string | null) ?? null,
        status: String(row.status),
        count: 0,
        prompt_tokens: 0,
        completion_tokens: 0,
      };
      entry.count += 1;
      entry.prompt_tokens += Number(row.prompt_tokens ?? 0);
      entry.completion_tokens += Number(row.completion_tokens ?? 0);
      stats.set(key, entry);
    }
    return HttpResponse.json({
      ...paginate(rows, page, pageSize),
      stats: [...stats.values()],
    });
  }),

  // ── auth 长尾 ────────────────────────────────────────────────────────────
  http.post("/api/v1/auth/forgot-password", async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as {
      email?: string;
    };
    const email = String(body.email ?? "")
      .trim()
      .toLowerCase();
    if (!email || !email.includes("@")) {
      return HttpResponse.json(
        { detail: "validation_error: email is required" },
        { status: 422 },
      );
    }
    // 不泄露邮箱存在性：响应恒为 ok（main.py:595-627）
    lastResetToken = `mock-reset-${Date.now()}`;
    console.info(
      `[MSW mock] 忘记密码：重置令牌（仅 mock，开发用）= ${lastResetToken}`,
    );
    return HttpResponse.json({
      ok: true,
      message: "如果该邮箱已注册，重置链接已发送",
    });
  }),

  http.post("/api/v1/auth/reset-password", async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as {
      token?: string;
      new_password?: string;
    };
    const token = String(body.token ?? "").trim();
    const password = String(body.new_password ?? "");
    if (!token) {
      return HttpResponse.json(
        { detail: "validation_error: token is required" },
        { status: 422 },
      );
    }
    if (password.length < 8) {
      return HttpResponse.json(
        { detail: "validation_error: Password must be at least 8 characters" },
        { status: 422 },
      );
    }
    if (token !== lastResetToken) {
      return HttpResponse.json(
        {
          detail: {
            error: "invalid_token",
            message: "重置链接无效或已过期，请重新申请",
          },
        },
        { status: 400 },
      );
    }
    lastResetToken = null;
    return HttpResponse.json({
      ok: true,
      message: "密码已重置，请用新密码登录",
    });
  }),

  // POST /auth/bootstrap-admin ← auth-context.tsx:156 + setup-admin/page.tsx
  // 形状真源 main.py:300-337。mock 里平台管理员已存在 ⇒ 与生产一致地回
  // 403 "System already initialized"（不假装还能再初始化一次）。
  http.post("/api/v1/auth/bootstrap-admin", async ({ request }) => {
    const auth = request.headers.get("Authorization") ?? "";
    if (!auth.startsWith("Bearer ")) {
      return HttpResponse.json("Not authenticated", { status: 401 });
    }
    const body = (await request.json().catch(() => ({}))) as {
      password?: string;
    };
    if (String(body.password ?? "").length < 8) {
      return HttpResponse.json(
        "validation_error: Password must be at least 8 characters",
        { status: 422 },
      );
    }
    return HttpResponse.json("System already initialized", { status: 403 });
  }),

  // ── shipments ────────────────────────────────────────────────────────────
  http.get("/api/v1/shipments", ({ request }) => {
    const url = new URL(request.url);
    const status = url.searchParams.get("status");
    const page = parseIntParam(url.searchParams.get("page"), 1);
    const pageSize = parseIntParam(url.searchParams.get("page_size"), 20);
    let rows = shipmentsStore.slice();
    if (status) rows = rows.filter((s) => s.status === status);
    return HttpResponse.json(paginate(rows, page, pageSize));
  }),

  // 单条出货详情（= ws_shipments.py:314 get_shipment；形状同 _row_to_shipment）。
  // 编辑对话框按 id 独立查询时用，避免"改筛选/列表刷新即丢编辑现场"。
  http.get("/api/v1/shipments/:shipmentId", ({ params }) => {
    const row = shipmentsStore.find((s) => s.id === Number(params.shipmentId));
    if (!row) {
      return HttpResponse.json(
        { detail: { error: "not_found", code: "SHIPMENT_NOT_FOUND" } },
        { status: 404 },
      );
    }
    return HttpResponse.json(row);
  }),

  http.post("/api/v1/shipments", async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as {
      order_id?: number | null;
    };
    const id = nextId();
    const row = shipmentSeed(
      id,
      `SH-202610-${String(id).padStart(4, "0")}`,
      "planned",
      body.order_id ?? null,
    );
    // 建单时可从订单带入客户名；mock 没有 ordersStore 访问权，故保留种子客户名。
    shipmentsStore.unshift(row);
    return HttpResponse.json(row, { status: 201 });
  }),

  http.patch("/api/v1/shipments/:shipmentId", async ({ params, request }) => {
    const row = shipmentsStore.find((s) => s.id === Number(params.shipmentId));
    if (!row) {
      return HttpResponse.json(
        { detail: { error: "not_found", code: "SHIPMENT_NOT_FOUND" } },
        { status: 404 },
      );
    }
    const body = (await request.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    // 只接受可编辑字段（与 ws_shipments.py:323-360 同白名单口径）
    for (const key of [
      "consignee",
      "cargo_desc",
      "bl_no",
      "bl_type",
      "pol_name",
      "pod_name",
      "vessel",
      "voyage",
      "container_no",
      "etd",
      "eta",
      "status",
      "freight_remark",
    ] as const) {
      if (key in body) row[key] = body[key];
    }
    return HttpResponse.json(row);
  }),

  // ── research ─────────────────────────────────────────────────────────────
  http.get("/api/v1/research/categories", () =>
    HttpResponse.json({ items: RESEARCH_CATEGORIES.slice() }),
  ),

  http.get("/api/v1/research/products", ({ request }) => {
    const url = new URL(request.url);
    const search = url.searchParams.get("search");
    const country = url.searchParams.get("country");
    const category = url.searchParams.get("product_category");
    const canSupply = url.searchParams.get("can_supply");
    let rows = researchProductsStore.slice();
    if (search) {
      const q = search.toLowerCase();
      rows = rows.filter((r) =>
        ["product_name", "product_name_cn", "shop_name"].some((field) =>
          String(r[field] ?? "")
            .toLowerCase()
            .includes(q),
        ),
      );
    }
    if (country) rows = rows.filter((r) => r.country === country);
    if (category) rows = rows.filter((r) => r.product_category === category);
    if (canSupply === "true") rows = rows.filter((r) => r.can_supply === true);
    if (canSupply === "false")
      rows = rows.filter((r) => r.can_supply === false);
    if (canSupply === "unknown")
      rows = rows.filter((r) => r.can_supply == null);
    const page = parseIntParam(url.searchParams.get("page"), 1);
    const pageSize = parseIntParam(url.searchParams.get("page_size"), 20);
    return HttpResponse.json(paginate(rows, page, pageSize));
  }),

  http.get("/api/v1/research/stats", () => {
    const byCountry = new Map<
      string,
      { country: string; total: number; can_supply: number }
    >();
    const byCategory = new Map<
      string,
      { product_category: string; total: number }
    >();
    let canSupplyYes = 0;
    for (const row of researchProductsStore) {
      if (row.can_supply === true) canSupplyYes += 1;
      const country = String(row.country ?? "");
      if (country) {
        const entry = byCountry.get(country) ?? {
          country,
          total: 0,
          can_supply: 0,
        };
        entry.total += 1;
        if (row.can_supply === true) entry.can_supply += 1;
        byCountry.set(country, entry);
      }
      const category = String(row.product_category ?? "unclassified");
      const catEntry = byCategory.get(category) ?? {
        product_category: category,
        total: 0,
      };
      catEntry.total += 1;
      byCategory.set(category, catEntry);
    }
    return HttpResponse.json({
      total: researchProductsStore.length,
      can_supply_yes: canSupplyYes,
      by_country: [...byCountry.values()],
      by_category: [...byCategory.values()],
    });
  }),

  http.post("/api/v1/research/products", async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const sourceRef = body.source_ref;
    if (typeof sourceRef === "number") {
      if (researchProductsStore.some((p) => p.source_ref === sourceRef)) {
        return HttpResponse.json(
          { error: "conflict", code: "ALREADY_PICKED" },
          { status: 409 },
        );
      }
      const lead = leadsStore.find((l) => l.id === sourceRef);
      if (!lead) return notFound("LEAD_NOT_FOUND");
      const created: MockResearchProduct = {
        id: nextId(),
        tenant_id: "default",
        source_ref: sourceRef,
        source: "leadgen",
        product_name: lead.product_name ?? lead.company_name,
        product_name_cn: lead.product_name_cn ?? null,
        product_image_url: lead.product_image_url ?? null,
        spec_raw: lead.spec_raw ?? null,
        spec_normalized: null,
        product_category: null,
        country: lead.country ?? null,
        region: lead.region ?? null,
        city: lead.city ?? null,
        shop_name: lead.company_name,
        shop_type: lead.shop_type ?? null,
        address: lead.address ?? null,
        phone: lead.phone ?? null,
        email: lead.email ?? null,
        website: lead.website ?? null,
        link_url: lead.link_url ?? null,
        price_local: null,
        price_currency: null,
        market_note: null,
        can_supply: lead.can_supply ?? null,
        supply_notes: null,
        research_status: "pending",
        created_at: nowIso(),
        updated_at: nowIso(),
      };
      researchProductsStore.unshift(created);
      researchRunsStore.unshift({
        id: nextId(),
        tenant_id: "default",
        config: { action: "pick", source_ref: sourceRef },
        config_hash: `pick-${sourceRef}`,
        status: "succeeded",
        leads_scanned: 1,
        products_found: 1,
        products_kept: 1,
        started_at: nowIso(),
        finished_at: nowIso(),
        created_by: "1",
        created_at: nowIso(),
      });
      return HttpResponse.json(created, { status: 201 });
    }
    const created: MockResearchProduct = {
      id: nextId(),
      tenant_id: "default",
      source_ref: null,
      source: "manual",
      product_name: optStr(body.product_name),
      product_name_cn: optStr(body.product_name_cn),
      product_image_url: optStr(body.product_image_url),
      spec_raw: optStr(body.spec_raw),
      spec_normalized: asRecord(body.spec_normalized),
      product_category: optStr(body.product_category),
      country: optStr(body.country),
      region: optStr(body.region),
      city: optStr(body.city),
      shop_name: optStr(body.shop_name),
      shop_type: optStr(body.shop_type),
      address: optStr(body.address),
      phone: optStr(body.phone),
      email: optStr(body.email),
      website: optStr(body.website),
      link_url: optStr(body.link_url),
      price_local:
        typeof body.price_local === "number" ? body.price_local : null,
      price_currency: optStr(body.price_currency),
      market_note: optStr(body.market_note),
      can_supply: typeof body.can_supply === "boolean" ? body.can_supply : null,
      supply_notes: optStr(body.supply_notes),
      research_status: "pending",
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    researchProductsStore.unshift(created);
    return HttpResponse.json(created, { status: 201 });
  }),

  http.patch(
    "/api/v1/research/products/:researchId",
    async ({ params, request }) => {
      const row = researchProductsStore.find(
        (p) => p.id === Number(params.researchId),
      );
      if (!row) return notFound("RESEARCH_NOT_FOUND");
      const body = (await request.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      // 白名单 = chain.py:ResearchPatch 的字段（不含 id/tenant_id）
      for (const key of [
        "product_name",
        "product_name_cn",
        "product_image_url",
        "spec_raw",
        "spec_normalized",
        "product_category",
        "country",
        "region",
        "city",
        "shop_name",
        "shop_type",
        "address",
        "phone",
        "email",
        "website",
        "link_url",
        "price_local",
        "price_currency",
        "market_note",
        "can_supply",
        "supply_notes",
        "research_status",
      ] as const) {
        if (key in body) row[key] = body[key];
      }
      row.updated_at = nowIso();
      return HttpResponse.json(row);
    },
  ),

  http.delete("/api/v1/research/products/:researchId", ({ params }) => {
    const index = researchProductsStore.findIndex(
      (p) => p.id === Number(params.researchId),
    );
    if (index < 0) return notFound("RESEARCH_NOT_FOUND");
    researchProductsStore.splice(index, 1);
    // 后端返回 `{"deleted": id}`（chain.py:2065-2071）
    return HttpResponse.json({ deleted: Number(params.researchId) });
  }),

  http.post("/api/v1/research/from-leadgen", async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as {
      lead_ids?: number[];
    };
    const leadIds = Array.isArray(body.lead_ids) ? body.lead_ids : [];
    if (leadIds.length === 0) {
      return HttpResponse.json(
        { error: "validation", code: "EMPTY_SELECTION" },
        { status: 422 },
      );
    }
    const leads = leadsStore.filter((l) => leadIds.includes(l.id));
    const created: MockResearchProduct[] = [];
    let skipped = 0;
    for (const lead of leads) {
      if (researchProductsStore.some((p) => p.source_ref === lead.id)) {
        skipped += 1;
        continue;
      }
      const row: MockResearchProduct = {
        id: nextId(),
        tenant_id: "default",
        source_ref: lead.id,
        source: "leadgen",
        product_name: lead.product_name ?? lead.company_name,
        product_name_cn: lead.product_name_cn ?? null,
        product_image_url: lead.product_image_url ?? null,
        spec_raw: lead.spec_raw ?? null,
        spec_normalized: null,
        product_category: null,
        country: lead.country ?? null,
        region: lead.region ?? null,
        city: lead.city ?? null,
        shop_name: lead.company_name,
        shop_type: lead.shop_type ?? null,
        address: lead.address ?? null,
        phone: lead.phone ?? null,
        email: lead.email ?? null,
        website: lead.website ?? null,
        link_url: lead.link_url ?? null,
        price_local: null,
        price_currency: null,
        market_note: null,
        can_supply: lead.can_supply ?? null,
        supply_notes: null,
        research_status: "pending",
        created_at: nowIso(),
        updated_at: nowIso(),
      };
      researchProductsStore.unshift(row);
      created.push(row);
    }
    researchRunsStore.unshift({
      id: nextId(),
      tenant_id: "default",
      config: { action: "from_leadgen", lead_ids: leadIds },
      config_hash: `from-leadgen-${leadIds.join("-")}`,
      status: "succeeded",
      leads_scanned: leads.length,
      products_found: leads.length,
      products_kept: created.length,
      started_at: nowIso(),
      finished_at: nowIso(),
      created_by: "1",
      created_at: nowIso(),
    });
    return HttpResponse.json(
      {
        scanned: leads.length,
        created: created.length,
        skipped,
        items: created,
      },
      { status: 201 },
    );
  }),

  http.get("/api/v1/research/runs", ({ request }) => {
    const url = new URL(request.url);
    const page = parseIntParam(url.searchParams.get("page"), 1);
    const pageSize = parseIntParam(url.searchParams.get("page_size"), 20);
    return HttpResponse.json(paginate(researchRunsStore, page, pageSize));
  }),

  // ── leadgen ──────────────────────────────────────────────────────────────
  http.get("/api/v1/leadgen/regions", () =>
    HttpResponse.json({
      items: [
        "US-TX",
        "US-CA",
        "US-FL",
        "US-NY",
        "CA-ON",
        "AU-NSW",
        "GB-ENG",
        "DE-NW",
      ],
      regions: [
        { code: "US-TX", name: "Texas, USA" },
        { code: "US-CA", name: "California, USA" },
        { code: "DE-NW", name: "NRW, Germany" },
        { code: "AU-NSW", name: "NSW, Australia" },
        { code: "GB-ENG", name: "England, UK" },
      ],
    }),
  ),

  // POST /leadgen/validate ← leadgen/page.tsx:212
  // 形状 = run_ai_task 的 `{result, path, task}`；模板口径见 _template_config_validation
  http.post("/api/v1/leadgen/validate", async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const issues: string[] = [];
    if (!String(body.region ?? "").trim()) issues.push("地区未填写");
    if (!String(body.industry ?? "").trim()) issues.push("行业未填写");
    const qty = Number(body.quantity ?? 0);
    if (!(qty >= 1 && qty <= 5000)) issues.push("数量需在 1-5000 之间");
    return HttpResponse.json({
      result: {
        valid: issues.length === 0,
        issues,
        suggestion: issues.length ? "检查地区/行业/数量后重新提交" : null,
      },
      path: "template",
      task: "config_validation",
    });
  }),

  http.get("/api/v1/leadgen/runs", ({ request }) => {
    const url = new URL(request.url);
    const page = parseIntParam(url.searchParams.get("page"), 1);
    const pageSize = parseIntParam(url.searchParams.get("page_size"), 20);
    return HttpResponse.json(paginate(leadgenRunsStore, page, pageSize));
  }),

  http.post("/api/v1/leadgen/runs", async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const config = {
      region: String(body.region ?? ""),
      industry: String(body.industry ?? ""),
      icp: optStr(body.icp),
      quantity: Number(body.quantity ?? 10),
      source: String(body.source ?? "demo"),
    };
    const hash = `mock-${config.region}-${config.industry}-${config.quantity}-${config.source}`;
    if (leadgenRunHashes.has(hash)) {
      const existing = leadgenRunsStore.find((r) => r.config_hash === hash);
      return HttpResponse.json({
        id: existing?.id ?? nextId(),
        status: existing?.status ?? "succeeded",
        leads_found: existing?.leads_found ?? 0,
        leads_kept: existing?.leads_kept ?? 0,
        error: null,
        deduplicated: true,
      });
    }
    leadgenRunHashes.add(hash);
    // 生成 2 条示例线索挂在本次 run 下（让列表有内容）
    const newLeads: MockLead[] = [
      leadSeed(
        nextId(),
        `${config.region || "NEW"} FENCE ${leadgenRunsStore.length + 1}`,
        config.region.split("-")[0] || "US",
        "info@example.com",
        "https://example.com",
        60,
        "none",
      ),
      leadSeed(
        nextId(),
        `${config.industry || "MESH"} TRADING CO.`,
        config.region.split("-")[0] || "US",
        null,
        null,
        40,
        "none",
      ),
    ];
    leadsStore.unshift(...newLeads);
    const run = {
      id: nextId(),
      tenant_id: "default",
      config,
      config_hash: hash,
      status: "succeeded",
      leads_found: newLeads.length,
      leads_kept: newLeads.length,
      error: null,
      started_at: nowIso(),
      finished_at: nowIso(),
      created_by: "1",
      created_at: nowIso(),
    };
    leadgenRunsStore.unshift(run);
    return HttpResponse.json(
      {
        id: run.id,
        status: run.status,
        config_hash: hash,
        leads_found: run.leads_found,
        leads_kept: run.leads_kept,
        error: null,
        deduplicated: false,
      },
      { status: 201 },
    );
  }),

  // C36 #18：手工新增线索（形状 = chain.py:1349 lead_create；重复公司 409 DUPLICATE_PLACE）
  http.post("/api/v1/leads", async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const company =
      typeof body.company_name === "string" ? body.company_name.trim() : "";
    if (!company) {
      return HttpResponse.json(
        {
          detail: [
            {
              loc: ["body", "company_name"],
              msg: "Field required",
              type: "missing",
            },
          ],
        },
        { status: 422 },
      );
    }
    const duplicate = leadsStore.some(
      (lead) =>
        String(lead.company_name).toLowerCase() === company.toLowerCase(),
    );
    if (duplicate) {
      return HttpResponse.json(
        { detail: { error: "conflict", code: "DUPLICATE_PLACE" } },
        { status: 409 },
      );
    }
    const now = nowIso();
    const companySlug = company
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 24);
    const lead: MockLead = {
      id: nextId(),
      tenant_id: "default",
      place_id:
        typeof body.place_id === "string" && body.place_id.trim()
          ? body.place_id.trim()
          : `manual-${companySlug || "unknown"}`,
      company_name: company,
      country: optStr(body.country),
      region: optStr(body.region),
      city: optStr(body.city),
      address: optStr(body.address),
      phone: optStr(body.phone),
      website: optStr(body.website),
      email: optStr(body.email),
      industry: optStr(body.industry),
      source: "manual",
      opening_line: optStr(body.opening_line),
      shop_type: optStr(body.shop_type),
      product_name: optStr(body.product_name),
      product_name_cn: optStr(body.product_name_cn),
      product_image_url: null,
      spec_raw: optStr(body.spec_raw),
      link_url: optStr(body.link_url),
      can_supply: typeof body.can_supply === "boolean" ? body.can_supply : null,
      supply_notes: optStr(body.supply_notes),
      crawl_status: "no_website",
      fit_score: 0,
      outreach_status: "none",
      inquiry_status: "none",
      created_at: now,
      updated_at: now,
    };
    leadsStore.unshift(lead);
    return HttpResponse.json(leadOut(lead), { status: 201 });
  }),

  http.get("/api/v1/leads", ({ request }) => {
    const url = new URL(request.url);
    const outreach = url.searchParams.get("outreach_status");
    const inquiry = url.searchParams.get("inquiry_status");
    const search = url.searchParams.get("search");
    const minScore = url.searchParams.get("min_score");
    const sort = url.searchParams.get("sort") ?? "score";
    const page = parseIntParam(url.searchParams.get("page"), 1);
    const pageSize = parseIntParam(url.searchParams.get("page_size"), 20);
    let rows = leadsStore.slice();
    if (outreach) rows = rows.filter((l) => l.outreach_status === outreach);
    if (inquiry) rows = rows.filter((l) => l.inquiry_status === inquiry);
    if (search) {
      const q = search.toLowerCase();
      rows = rows.filter((l) =>
        String(l.company_name).toLowerCase().includes(q),
      );
    }
    if (minScore) {
      const min = Number(minScore);
      if (Number.isFinite(min)) {
        rows = rows.filter((l) => Number(l.fit_score ?? 0) >= min);
      }
    }
    if (sort === "recent") {
      rows.sort((a, b) =>
        String(b.created_at).localeCompare(String(a.created_at)),
      );
    } else if (sort === "name") {
      rows.sort((a, b) =>
        String(a.company_name).localeCompare(String(b.company_name)),
      );
    } else {
      rows.sort((a, b) => Number(b.fit_score ?? 0) - Number(a.fit_score ?? 0));
    }
    return HttpResponse.json(paginate(rows.map(leadOut), page, pageSize));
  }),

  http.get("/api/v1/leads/:leadId", ({ params }) => {
    const lead = leadsStore.find((l) => l.id === Number(params.leadId));
    if (!lead) return notFound("LEAD_NOT_FOUND");
    // 形状 = chain.py:1188-1216（lead + outreach_history + inquiry_history）
    const outreachHistory = messagesStore
      .filter((m) => m.lead_id === lead.id)
      .map((m) => ({
        id: m.id,
        status: m.status,
        error: m.error,
        sent_at: m.sent_at,
      }));
    return HttpResponse.json({
      ...leadOut(lead),
      outreach_history: outreachHistory,
      inquiry_history: [],
    });
  }),

  http.patch("/api/v1/leads/:leadId", async ({ params, request }) => {
    const lead = leadsStore.find((l) => l.id === Number(params.leadId));
    if (!lead) return notFound("LEAD_NOT_FOUND");
    const body = (await request.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    // 白名单 = chain.py:_LEAD_PATCHABLE（越权改状态列会被拒是后端行为，mock 只收白名单）
    for (const key of [
      "company_name",
      "email",
      "website",
      "phone",
      "industry",
      "fit_score",
      "opening_line",
      "owner_scope",
      "shop_type",
      "product_name",
      "product_name_cn",
      "product_image_url",
      "spec_raw",
      "link_url",
      "can_supply",
      "supply_notes",
    ] as const) {
      if (key in body) lead[key] = body[key];
    }
    lead.updated_at = nowIso();
    return HttpResponse.json(leadOut(lead));
  }),

  http.post("/api/v1/leads/scan-replied", () => {
    // 形状 = chain.py:1136-1186 `{scanned, created, already_linked}`
    // mock 简化：只把 replied 且未转化的线索标成 new（不真正创建询盘——
    // 询盘 store 在 handlers.ts，跨模块写会把单文件复杂度抬到不可维护）。
    const candidates = leadsStore.filter(
      (l) => l.outreach_status === "replied" && l.inquiry_status === "none",
    );
    for (const lead of candidates) lead.inquiry_status = "new";
    return HttpResponse.json({
      scanned: candidates.length,
      created: candidates.length,
      already_linked: 0,
    });
  }),

  http.post("/api/v1/leads/:leadId/crawl", ({ params }) => {
    const lead = leadsStore.find((l) => l.id === Number(params.leadId));
    if (!lead) return notFound("LEAD_NOT_FOUND");
    // 形状 = chain.py:_crawl_one / 1751-1775 `{result, lead}`
    const status = lead.website ? "success" : "no_website";
    lead.crawl_status = status;
    lead.crawled_at = nowIso();
    if (status === "success") {
      lead.product_name = lead.product_name ?? "Chain link fence";
      lead.spec_raw = lead.spec_raw ?? "wire 2.5mm, mesh 50x50mm";
    }
    return HttpResponse.json({
      result: { lead_id: lead.id, status, error: null },
      lead: leadOut(lead),
    });
  }),

  http.post("/api/v1/leads/crawl-batch", async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as {
      lead_ids?: number[];
      only_pending?: boolean;
      limit?: number;
    };
    const limit = Math.max(1, Math.min(Number(body.limit ?? 10), 20));
    let rows = leadsStore.slice();
    if (Array.isArray(body.lead_ids) && body.lead_ids.length) {
      rows = rows.filter((l) => body.lead_ids?.includes(l.id));
    } else if (body.only_pending !== false) {
      rows = rows.filter((l) => l.crawl_status === "pending");
    }
    rows = rows.slice(0, limit);
    const items: Array<Record<string, unknown>> = [];
    for (const lead of rows) {
      const status = lead.website ? "success" : "no_website";
      lead.crawl_status = status;
      lead.crawled_at = nowIso();
      items.push({ lead_id: lead.id, status, error: null });
    }
    const count = (status: string) =>
      items.filter((item) => item.status === status).length;
    // 形状 = chain.py:1776-1808
    return HttpResponse.json({
      crawled: items.length,
      success: count("success"),
      failed: count("failed"),
      blocked: count("blocked"),
      no_website: count("no_website"),
      items,
    });
  }),

  // ── outreach ─────────────────────────────────────────────────────────────
  http.get("/api/v1/outreach/mailboxes", () =>
    HttpResponse.json({
      items: mailboxesStore.map(mailboxOut),
      total: mailboxesStore.length,
    }),
  ),

  http.post("/api/v1/outreach/mailboxes", async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const email = String(body.email ?? "").trim();
    if (!email) {
      return HttpResponse.json(
        { error: "validation", code: "EMAIL_REQUIRED" },
        { status: 422 },
      );
    }
    if (mailboxesStore.some((m) => m.email === email)) {
      return HttpResponse.json(
        { error: "conflict", code: "MAILBOX_EXISTS" },
        { status: 409 },
      );
    }
    const isDefault = body.is_default === true;
    if (isDefault) for (const m of mailboxesStore) m.is_default = false;
    const created: MockMailbox = {
      id: nextId(),
      email,
      name: optStr(body.name),
      provider: "smtp",
      api_key: optStr(body.api_key),
      is_default: isDefault || mailboxesStore.length === 0,
      daily_limit: null,
      sent_today: 0,
      last_sent_date: null,
      enabled: true,
    };
    mailboxesStore.push(created);
    return HttpResponse.json(mailboxOut(created), { status: 201 });
  }),

  http.patch(
    "/api/v1/outreach/mailboxes/:mailboxId",
    async ({ params, request }) => {
      const mailbox = mailboxesStore.find(
        (m) => m.id === Number(params.mailboxId),
      );
      if (!mailbox) {
        return HttpResponse.json(
          { error: "not_found", code: "MAILBOX_NOT_FOUND" },
          { status: 404 },
        );
      }
      const body = (await request.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      if (body.is_default === true) {
        for (const m of mailboxesStore) m.is_default = false;
        mailbox.is_default = true;
      }
      if (typeof body.name === "string") mailbox.name = body.name || null;
      if (typeof body.enabled === "boolean") mailbox.enabled = body.enabled;
      if (typeof body.daily_limit === "number")
        mailbox.daily_limit = body.daily_limit;
      if (typeof body.api_key === "string") {
        mailbox.api_key = body.api_key || null;
      }
      return HttpResponse.json(mailboxOut(mailbox));
    },
  ),

  http.post("/api/v1/outreach/mailboxes/:mailboxId/test", ({ params }) => {
    const mailbox = mailboxesStore.find(
      (m) => m.id === Number(params.mailboxId),
    );
    if (!mailbox) {
      return HttpResponse.json(
        { error: "not_found", code: "MAILBOX_NOT_FOUND" },
        { status: 404 },
      );
    }
    if (!mailbox.enabled) {
      return HttpResponse.json({
        status: "failed",
        error: "邮箱未启用",
      });
    }
    return HttpResponse.json({ status: "sent" });
  }),

  http.get("/api/v1/outreach/campaigns", () =>
    HttpResponse.json({ items: campaignsStore.map(campaignOut) }),
  ),

  http.post("/api/v1/outreach/campaigns", async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const name = String(body.name ?? "").trim();
    if (!name) {
      return HttpResponse.json(
        { error: "validation", code: "NAME_REQUIRED" },
        { status: 422 },
      );
    }
    const created: MockCampaign = {
      id: nextId(),
      name,
      subject_template: String(body.subject_template ?? ""),
      body_template: String(body.body_template ?? ""),
      mailbox_id: typeof body.mailbox_id === "number" ? body.mailbox_id : null,
      status: "draft",
      total_count: 0,
      sent_count: 0,
      failed_count: 0,
      created_at: nowIso(),
    };
    campaignsStore.unshift(created);
    return HttpResponse.json(campaignOut(created), { status: 201 });
  }),

  // POST /outreach/generate ← outreach/page.tsx:189；形状 = run_ai_task
  http.post("/api/v1/outreach/generate", () =>
    HttpResponse.json({
      result: {
        subject: "Factory-direct wire mesh & fencing — quick question",
        body: "Dear {{contact_name}},\n\nWe supply wire mesh and fencing with factory-direct pricing.\n\nMay I send you our catalog?\n\nBest regards,\n{{sender_name}}",
      },
      path: "template",
      task: "email_generation",
    }),
  ),

  http.post(
    "/api/v1/outreach/campaigns/:campaignId/send",
    async ({ params, request }) => {
      const campaign = campaignsStore.find(
        (c) => c.id === Number(params.campaignId),
      );
      if (!campaign) {
        return HttpResponse.json(
          { error: "not_found", code: "CAMPAIGN_NOT_FOUND" },
          { status: 404 },
        );
      }
      if (campaign.status === "sending") {
        return HttpResponse.json(
          { error: "conflict", code: "ALREADY_SENDING" },
          { status: 409 },
        );
      }
      const body = (await request.json().catch(() => ({}))) as {
        lead_ids?: number[];
      };
      const leadIds = Array.isArray(body.lead_ids) ? body.lead_ids : [];
      let sent = 0;
      let failed = 0;
      for (const leadId of leadIds) {
        const lead = leadsStore.find((l) => l.id === leadId);
        if (!lead) {
          failed += 1;
          continue;
        }
        const message: MockMessage = {
          id: nextId(),
          campaign_id: campaign.id,
          lead_id: lead.id,
          to_email: String(lead.email ?? "unknown@example.com"),
          to_name: String(lead.company_name),
          subject: campaign.subject_template,
          body_rendered: campaign.body_template,
          status: "sent",
          error: null,
          sent_at: nowIso(),
          opened_at: null,
          replied_at: null,
          created_at: nowIso(),
        };
        messagesStore.unshift(message);
        lead.outreach_status = "sent";
        sent += 1;
      }
      campaign.total_count += leadIds.length;
      campaign.sent_count += sent;
      campaign.failed_count += failed;
      campaign.status = "sent";
      // 形状 = chain.py:1519-1594 `{campaign_id,total,sent,failed}`
      return HttpResponse.json({
        campaign_id: campaign.id,
        total: leadIds.length,
        sent,
        failed,
      });
    },
  ),

  http.get("/api/v1/outreach/messages", ({ request }) => {
    const url = new URL(request.url);
    const status = url.searchParams.get("status");
    const campaignId = url.searchParams.get("campaign_id");
    const leadId = url.searchParams.get("lead_id");
    const page = parseIntParam(url.searchParams.get("page"), 1);
    const pageSize = parseIntParam(url.searchParams.get("page_size"), 20);
    let rows = messagesStore.slice();
    if (status) rows = rows.filter((m) => m.status === status);
    if (campaignId)
      rows = rows.filter((m) => m.campaign_id === Number(campaignId));
    if (leadId) rows = rows.filter((m) => m.lead_id === Number(leadId));
    const items = rows.map((m) => ({
      ...messageOut(m),
      lead_company:
        leadsStore.find((l) => l.id === m.lead_id)?.company_name ?? null,
    }));
    return HttpResponse.json(paginate(items, page, pageSize));
  }),

  http.get("/api/v1/outreach/messages/:messageId", ({ params }) => {
    const message = messagesStore.find(
      (m) => m.id === Number(params.messageId),
    );
    if (!message) {
      return HttpResponse.json(
        { error: "not_found", code: "MESSAGE_NOT_FOUND" },
        { status: 404 },
      );
    }
    return HttpResponse.json(messageOut(message));
  }),

  http.post("/api/v1/outreach/messages/:messageId/retry", ({ params }) => {
    const message = messagesStore.find(
      (m) => m.id === Number(params.messageId),
    );
    if (!message) {
      return HttpResponse.json(
        { error: "not_found", code: "MESSAGE_NOT_FOUND" },
        { status: 404 },
      );
    }
    if (message.status !== "failed" && message.status !== "bounced") {
      return HttpResponse.json(
        {
          error: "conflict",
          code: "NOT_RETRYABLE",
          detail: "仅 failed/bounced 可重发",
        },
        { status: 409 },
      );
    }
    message.status = "sent";
    message.error = null;
    message.sent_at = nowIso();
    return HttpResponse.json({ status: "sent" });
  }),

  // ── pricing-data ─────────────────────────────────────────────────────────
  // GET ← use-pricing-data.ts:14（矩阵 = 产品定义兜底值 + 客户已保存的档位）
  http.get("/api/v1/pricing-data", ({ request }) => {
    const url = new URL(request.url);
    const productKey = url.searchParams.get("product_key") ?? "";
    const product = MOCK_EXPORT_PRODUCTS.find((p) => p.key === productKey);
    const values = [2.5, 3.0, 3.5];
    const amounts = [2.3, 2.5, 2.7];
    const savedRows = pricingCellsStore
      .filter((c) => c.product_key === productKey && c.status === "active")
      .map((cell) => ({
        key: `wire_diameter=${String(cell.values.wire_diameter ?? "")}`,
        values: cell.values,
        labels: Object.values(cell.labels ?? {}),
        amount: cell.amount,
        unit: cell.unit,
        item_id: cell.id,
        effective_from: cell.effective_from,
        source: "manual",
        notes: null,
        configured: true,
      }));
    const baseRows = values.map((value, i) => ({
      key: `wire_diameter=${value}`,
      values: { wire_diameter: value },
      labels: [`${value}mm`],
      amount: amounts[i],
      unit: "元/㎡",
      item_id: i === 0 ? 301 : null,
      effective_from: "2026-10-01",
      source: i === 0 ? "manual" : "product_default",
      notes: null,
      configured: i === 0,
    }));
    // 保存过的单元覆盖同 key 的兜底行（后端是"新版本生效"，读取侧看到的就是已配置值）
    const merged = baseRows.map((row) => {
      const hit = savedRows.find((saved) => saved.key === row.key);
      return hit ?? row;
    });
    for (const saved of savedRows) {
      if (!merged.some((row) => row.key === saved.key)) merged.push(saved);
    }
    return HttpResponse.json({
      product_key: productKey,
      product_name: product?.name ?? productKey,
      cost_unit: "元/㎡",
      scope: url.searchParams.get("scope") === "all" ? "all" : "own",
      dims: [
        {
          field: "wire_diameter",
          label: "丝径/线径",
          unit: "mm",
          kind: "axis",
          ui_unit: "mm",
          ui_scale: 1,
          options: values.map((v) => ({ value: v, label: `${v}mm` })),
        },
      ],
      rows: merged,
    });
  }),

  // POST /pricing-data ← use-pricing-data.ts:36
  // 形状 = main.py:2183-2288（201 + `{id,product_key,key,values,amount,unit,effective_from,status}`）
  http.post("/api/v1/pricing-data", async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const productKey = String(body.product_key ?? "").trim();
    const product = MOCK_EXPORT_PRODUCTS.find((p) => p.key === productKey);
    if (!product) {
      return HttpResponse.json(
        { detail: `未知产品: ${productKey}` },
        { status: 404 },
      );
    }
    const values = asRecord(body.values);
    if (Object.keys(values).length === 0) {
      return HttpResponse.json(
        { detail: "values is required" },
        { status: 422 },
      );
    }
    const amount = body.amount;
    if (typeof amount !== "number" || amount <= 0) {
      return HttpResponse.json(
        { detail: "amount must be > 0" },
        { status: 422 },
      );
    }
    const unit = String(body.unit ?? "").trim();
    if (!PRICING_UNITS.has(unit)) {
      return HttpResponse.json(
        {
          detail: `unit 必须是以下之一: ${[...PRICING_UNITS].sort().join(", ")}`,
        },
        { status: 422 },
      );
    }
    const key = `wire_diameter=${String(values.wire_diameter ?? "")}`;
    // INSERT-only 语义：同 key 旧版本置 inactive（main.py:2255-2290 的 CTE）
    for (const cell of pricingCellsStore) {
      if (
        cell.product_key === productKey &&
        cell.key === key &&
        cell.status === "active"
      ) {
        cell.status = "inactive";
      }
    }
    const labels = asRecord(body.labels);
    const created: MockPricingCell = {
      id: nextId(),
      product_key: productKey,
      key,
      values: values as Record<string, string | number>,
      labels: Object.fromEntries(
        Object.entries(labels).map(([k, v]) => [k, String(v)]),
      ),
      amount,
      unit,
      effective_from:
        optStr(body.effective_from) ?? new Date().toISOString().slice(0, 10),
      status: "active",
    };
    pricingCellsStore.push(created);
    return HttpResponse.json(
      {
        id: created.id,
        product_key: productKey,
        key: created.key,
        values: created.values,
        amount: created.amount,
        unit: created.unit,
        effective_from: created.effective_from,
        status: created.status,
      },
      { status: 201 },
    );
  }),

  http.delete("/api/v1/pricing-data/:itemId", ({ params }) => {
    const cell = pricingCellsStore.find(
      (c) => c.id === Number(params.itemId) && c.status === "active",
    );
    if (!cell) {
      return HttpResponse.json(
        { detail: "Pricing data not found or access denied" },
        { status: 404 },
      );
    }
    cell.status = "inactive";
    return HttpResponse.json({ id: cell.id, status: "inactive" });
  }),

  // ── fx-rates ─────────────────────────────────────────────────────────────
  // GET /fx-rates/latest ← lib/fx/use-latest-fx.ts:25
  // 形状 = ws_extras.py:179-195 `_ensure_fresh_fx` 的返回（6 键）
  http.get("/api/v1/fx-rates/latest", ({ request }) => {
    const url = new URL(request.url);
    const base = (url.searchParams.get("base_currency") ?? "USD").toUpperCase();
    const quote = (
      url.searchParams.get("quote_currency") ?? "CNY"
    ).toUpperCase();
    const stored = fxRatesStore.find(
      (r) => r.base_currency === base && r.quote_currency === quote,
    );
    if (stored) return HttpResponse.json(stored);
    return HttpResponse.json({
      base_currency: base,
      quote_currency: quote,
      rate: currencyRate(base, quote),
      rate_date: new Date().toISOString().slice(0, 10),
      source: "mock",
      is_stale: false,
    });
  }),

  // ── 报价 / 算价 / 导入 / 试算 ────────────────────────────────────────────
  // 注意：`GET /quotes/cost-reference` **不能**注册在这里 —— core `handlers.ts` 的
  // `GET /quotes/:id` 会先匹配到（MSW 按注册顺序、命中即止）⇒ 这里只导出计算函数，
  // 由 handlers.ts 把路由注册在 `:id` 之前（见 `mockCostReference` 调用点）。

  // POST /export-quote/calculate ← batch-quote-view.tsx:244
  http.post("/api/v1/export-quote/calculate", async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const productKey = String(body.product_key ?? "");
    const view = body.with_verification === true ? "internal" : "customer";
    const response = mockCalculateResponse(productKey, body, view);
    if (!response) {
      return HttpResponse.json(
        {
          error: "unknown_product",
          message: `未注册的产品模型 '${productKey}'`,
        },
        { status: 404 },
      );
    }
    return HttpResponse.json(response);
  }),

  // GET /export-quote/products/:key/import-template（端点保留；旧单产品导入 hook 已删，此处供整单模板列定义复用）
  http.get(
    "/api/v1/export-quote/products/:productKey/import-template",
    ({ params }) => {
      const info = importTemplateInfo(String(params.productKey));
      if (!info) {
        return HttpResponse.json(
          { error: "unknown_product", message: "未注册的产品模型" },
          { status: 404 },
        );
      }
      return HttpResponse.json(info);
    },
  ),

  // ── 整单批量导入（R-D，2026-10-23）─────────────────────────────────────────
  // GET /export-quote/import/order/template-info ← bulk-import-panel.tsx
  // 规格列 = 各产品模板列的并集；公共列在前（与后端约定顺序一致）。
  http.get("/api/v1/export-quote/import/order/template-info", ({ request }) => {
    const url = new URL(request.url);
    const wanted = (url.searchParams.get("product_keys") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const keys =
      wanted.length > 0
        ? wanted
        : MOCK_EXPORT_PRODUCTS.map((p) => String(p.key));
    const infos = keys
      .map((k) => importTemplateInfo(k))
      .filter(
        (i): i is NonNullable<ReturnType<typeof importTemplateInfo>> =>
          i !== null,
      );
    const commonHeaders = [
      "产品",
      "件数（卷）",
      "成本",
      "成本口径（含税/不含税）",
      "包装方式",
      "本行利润率（%）",
    ];
    const seen = new Set<string>();
    const specHeaders: string[] = [];
    const specProducts = new Map<string, string[]>();
    for (const info of infos) {
      for (const header of info.headers) {
        if (seen.has(header)) {
          specProducts.get(header)?.push(info.product_name);
          continue;
        }
        seen.add(header);
        specHeaders.push(header);
        specProducts.set(header, [info.product_name]);
      }
    }
    const headers = [...commonHeaders, ...specHeaders];
    return HttpResponse.json({
      product_keys: keys,
      headers,
      columns: [
        ...commonHeaders.map((header) => ({
          header,
          kind: "common" as const,
          products: [] as string[],
          unit: "",
          options: [] as string[],
          note: "",
        })),
        ...specHeaders.map((header) => ({
          header,
          kind: "spec" as const,
          products: specProducts.get(header) ?? [],
          unit: "",
          options: [] as string[],
          note: "",
        })),
      ],
      max_rows: 2000,
      max_mb: IMPORT_MAX_MB,
      data_sheet: "整单表",
      notes: [
        "mock：列定义取自各产品公式定义（示例）；模板下载由前端 exceljs 生成",
        "每行一个产品；与该行产品无关的规格列留空",
      ],
    });
  }),

  // POST /export-quote/import/order/preview ← bulk-import-panel.tsx
  // 真实后端解析整单表；mock 不解析二进制，固定回 2 行（2 个产品）示例并明确标注。
  http.post(
    "/api/v1/export-quote/import/order/preview",
    async ({ request }) => {
      const form = await request.formData();
      const uploadError = importUploadError(form);
      if (uploadError) {
        return HttpResponse.json(uploadError, { status: 400 });
      }
      const uploaded = form.get("file") as File | null;
      const picks = MOCK_EXPORT_PRODUCTS.slice(0, 2);
      const products = picks.map((p) => ({
        product_key: String(p.key),
        product_name: String(p.name),
        rows: 1,
      }));
      const rows = picks.map((p, index) => {
        const info = importTemplateInfo(String(p.key));
        const columns = (info?.columns ?? []) as Array<Record<string, unknown>>;
        return {
          row: index + 1,
          product_key: String(p.key),
          product_name: String(p.name),
          spec: sampleSpecRow(columns),
          pieces: 10,
          cost: 4.8,
          cost_basis: index === 1 ? "incl_tax" : "pretax",
          packaging_method: null,
          packaging_id: null,
          profit_pct: null,
          row_errors: [],
        };
      });
      const info0 = importTemplateInfo(String(picks[0]?.key ?? ""));
      return HttpResponse.json({
        source_name: uploaded?.name || "mock-order.xlsx",
        sheet: "整单表",
        total_data_rows: rows.length,
        usable_rows: rows.length,
        error_count: 0,
        warning_count: 1,
        products,
        mapping: Object.fromEntries(
          (info0?.headers ?? []).map((h: string) => [h, h]),
        ),
        ignored_columns: [],
        issues: [
          {
            row: 0,
            column: "",
            value: null,
            message:
              "mock：未真正解析上传文件，下方为示例行（用于打通预览→填入工作台链路）",
            severity: "warning",
          },
        ],
        rows,
        expected_columns: info0?.headers ?? [],
      });
    },
  ),

  // POST /export-quote/products/:key/explain ← product-spec-tryout.tsx:125
  // 形状 = ws_quote_ext.py:285-297（steps + ok/errors/warnings；不跑价链）
  http.post(
    "/api/v1/export-quote/products/:productKey/explain",
    async ({ params, request }) => {
      const productKey = String(params.productKey);
      const product = MOCK_EXPORT_PRODUCTS.find((p) => p.key === productKey);
      const body = (await request.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      const spec = asRecord(body.spec);
      const columns = (() => {
        const formulas = formulasOf(productKey);
        if (!formulas) return [] as FormulaColumn[];
        return columnsOf(formulas, "customer");
      })();
      const steps = columns
        .filter((c) => {
          const key = String(c.key ?? "");
          return key.startsWith("spec.") || key.startsWith("derived.");
        })
        .map((c) => {
          const key = String(c.key ?? "");
          const value = key.startsWith("spec.")
            ? (spec[key.slice("spec.".length)] ?? 0)
            : 0;
          return {
            key,
            code: key,
            name: String(c.label ?? key),
            expr: key,
            value: value as number | string,
            unit: "",
            label: String(c.label_en ?? c.label ?? key),
            note: null,
            error: null,
          };
        });
      return HttpResponse.json({
        product_key: productKey,
        product_name: product?.name ?? productKey,
        steps,
        ok: !product || steps.length >= 0,
        errors: product
          ? []
          : [
              {
                code: "unknown_product",
                error: `未注册的产品模型 '${productKey}'`,
              },
            ],
        warnings: ["mock：逐步代入用产品定义的列结构占位，未跑真实表达式求值"],
      });
    },
  ),
];
