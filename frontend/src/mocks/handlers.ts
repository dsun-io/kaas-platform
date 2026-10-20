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
import {
  FULL_CHAIN_CODE,
  SUBSCRIBABLE_WORKSTATIONS,
} from "@/lib/workstation/visibility";
import tradeDocSample from "@/lib/trade-doc/sample-data.json";
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
const featureFlagsStore: Record<string, Record<string, boolean>> = JSON.parse(
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
  /** 后端 `SELECT *` 会带；客户详情按「主要置顶 + 添加时间倒序」展示 */
  created_at?: string;
};

/** 询盘 —— 字段名照后端 `row_to_inquiry()`
 * （kaas_common/workstation/customer_serializers.py:73-104）。
 * 刻意**不含** `notes`：后端存了但序列化不返回（:37-49），前端也不读（page.tsx:71-81）。 */
type MockInquiry = {
  id: number;
  customer_id: number;
  /** 自动生成的询盘编号（后端 `inquiry_no`；历史询盘可能为空） */
  inquiry_no?: string | null;
  lead_id: number | null;
  channel: string | null;
  category_id: number | null;
  product_name_raw: string | null;
  quantity: number | null;
  quantity_unit: string | null;
  application: string | null;
  status: string;
  /** 询盘阶段（F4 · `worker/src/inquiry_stage.py` 的 STAGE_*；列表/详情都带） */
  stage?: string | null;
  stage_updated_at?: string | null;
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

/** 客户阶段（2026-10-18 用户口径）：只有三种。
 *  - active / inactive 是**手动**状态；
 *  - ordered（已下单）由开启中的订单推导，**不允许手写**。
 * 询盘/报价/订单的 lead→inquiry→quoted→won→lost 属于**单据阶段**，不是客户阶段。 */
const CUSTOMER_STAGES: readonly string[] = ["active", "inactive"];

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

const ordersStore: Array<Record<string, unknown> & { id: number }> = [];
const docsStore: Array<Record<string, unknown> & { id: number }> = [];

// 单证**内容**版本链（TODO A1）：mock 内存版，按 docId 惰性种子 2 版。
// 恢复 = 追加一条 restore 版本并回写单据 raw_payload —— 与服务端「只增不删」一致。
interface MockContentVersion {
  version_no: number;
  change_source:
    | "custom_update"
    | "refresh_sources"
    | "issue"
    | "restore"
    | "translate";
  actor_id: string | null;
  note: string | null;
  created_at: string;
  custom_keys: string[];
  raw_payload: Record<string, unknown>;
}
const contentVersionsStore = new Map<number, MockContentVersion[]>();

function contentVersionsOf(docId: number): MockContentVersion[] {
  const existing = contentVersionsStore.get(docId);
  if (existing) return existing;
  const seeded: MockContentVersion[] = [
    {
      version_no: 1,
      change_source: "custom_update",
      actor_id: "1",
      note: null,
      created_at: "2026-10-19T08:30:00Z",
      custom_keys: ["remarks", "payment_terms"],
      raw_payload: {
        sources: {},
        custom: {
          remarks: "1) 分批装运 2) 唛头见附件",
          payment_terms: "30% T/T",
        },
      },
    },
    {
      version_no: 2,
      change_source: "refresh_sources",
      actor_id: "1",
      note: null,
      created_at: "2026-10-20T02:10:00Z",
      custom_keys: ["remarks", "payment_terms", "shipping_marks"],
      raw_payload: {
        sources: { order: { order_no: "ORD-202610-0001" } },
        custom: {
          remarks: "1) 分批装运 2) 唛头见附件",
          payment_terms: "30% T/T",
          shipping_marks: "KAAS/ACME/HAMBURG",
        },
      },
    },
  ];
  contentVersionsStore.set(docId, seeded);
  return seeded;
}

/** 枚举真源 = backend/orchestrator/app/domain/enums.py（值逐字照搬）。 */
const ENUMS_MOCK: Record<string, string[]> = {
  inquiry_status: ["unquoted", "quoted", "closed"],
  customer_stage: ["active", "inactive", "ordered"],
  quote_status: ["draft", "sent", "accepted", "rejected", "expired", "closed"],
  order_status: [
    "pending",
    "confirmed",
    "producing",
    "shipped",
    "completed",
    "cancelled",
  ],
  doc_type: [
    "quotation",
    "pi",
    "contract",
    "ci",
    "pl",
    "shipping_advice",
    "draft",
    "beneficiary_cert",
    "non_wood_packing",
    "weight_list",
    "quality_cert",
    "manufacturer_cert",
    "bl",
    "co",
    "insurance",
    "customs_declaration",
    "fumigation_cert",
    "other",
  ],
  doc_status: ["draft", "issued", "void"],
  currency: ["USD", "CNY", "EUR", "GBP", "JPY", "AUD", "CAD", "HKD"],
  owner_scope: ["private", "tenant"],
  inquiry_channel: [
    "email",
    "whatsapp",
    "alibaba",
    "expo",
    "website",
    "quote",
    "other",
  ],
};

const accountsStore: MockAccount[] = [
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

const quotesStore: MockQuote[] = [
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

// ═══════════════════════════════════════════════════════════════════════════
// P1 组 mock 数据（对齐修复 B · 2026-10-20）
//
// 这些端点此前**没有 handler**（缺口清单见 `.tmp/msw-diff.txt`）：mock 模式下
// `onUnhandledRequest:"warn"`（msw-provider.tsx:96）会把它放行到网络 ⇒ 本地没后端时
// 请求挂起/失败 ⇒ 产品定义、企业税档、企业公章、团队订阅、单证对账等新页面静默空白。
//
// 形状一律照 worker 的序列化函数（每处标了 file:line），**不凭空造字段**；
// 数据全部落在本模块的可变 store 里，`resetMockData()` 能恢复种子（测试可重复）。
// ═══════════════════════════════════════════════════════════════════════════

/** 单证列表的最近一次对账结论（TODO A8/A9）。形状 = worker `main.py:4161-4180`。 */
type MockRenderCheck = {
  matches: boolean;
  /** 共享内核 reason 原值：matched / version_drift / data_changed / ... */
  reason: string;
  render_version_drift: boolean;
  checked_at: string | null;
};

/** 单证种子：`docsStore` 原先**恒为空** ⇒ 单证页在 mock 下永远 0 行，A8/A9 的
 *  「已变更 / 模板已更新」标识根本无从验证。id 1..4 刻意覆盖四种对账故事
 *  （data_changed / version_drift / 从未对账 / 一致）；id 1、2 同属 order 9 且 2 更晚
 *  ⇒ id 1 的 `doc_no_editable=false`（与后端同一推导，main.py:4145-4155）。 */
const DOC_SEEDS: Array<Record<string, unknown> & { id: number }> = [
  {
    id: 1,
    doc_no: "PI-202610-0001",
    doc_type: "pi",
    order_id: 9,
    quote_id: null,
    customer_id: "1",
    status: "issued",
    currency: "USD",
    total_amount: 12300,
    issued_at: "2026-10-10T08:00:00Z",
    issued_by: "1",
    raw_payload: {
      sources: {
        order: { order_no: "ORD-202609-0009", customer_name: "联佳丝网" },
      },
      custom: { remarks: "1) 分批装运 2) 唛头见附件" },
      // 签发时冻结的渲染指纹（形状 = kaas_common/trade_doc/render_fingerprint.py:194-211）
      _render: {
        render_version: 1,
        input_sha256:
          "6f1b0c0a5c2a4d5e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e",
        frozen_at: "2026-10-10T08:00:00Z",
      },
    },
    created_at: "2026-10-10T07:30:00Z",
  },
  {
    id: 2,
    doc_no: "CI-202609-0001",
    doc_type: "ci",
    order_id: 9,
    quote_id: null,
    customer_id: "1",
    status: "issued",
    currency: "USD",
    total_amount: 12300,
    issued_at: "2026-10-11T08:00:00Z",
    issued_by: "1",
    raw_payload: {
      sources: { order: { order_no: "ORD-202609-0009" } },
      custom: {},
      // 内容摘要与"现在"一致，但冻结时的渲染器版本更旧 ⇒ version_drift（模板已更新）
      _render: {
        render_version: 0,
        input_sha256:
          "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b",
        frozen_at: "2026-10-11T08:00:00Z",
      },
    },
    created_at: "2026-10-11T07:30:00Z",
  },
  {
    // 草稿、没有上游 ⇒ 从未对账（`render_check=null`：界面不显示任何标识，不冒充"没问题"）
    id: 3,
    doc_no: "PI-202609-0002",
    doc_type: "pi",
    order_id: null,
    quote_id: null,
    customer_id: "2",
    status: "draft",
    currency: "USD",
    total_amount: 8000,
    issued_at: null,
    issued_by: null,
    raw_payload: null,
    created_at: "2026-10-12T07:30:00Z",
  },
  {
    id: 4,
    doc_no: "QUO-202610-0002",
    doc_type: "quotation",
    order_id: null,
    quote_id: 1,
    customer_id: "1",
    status: "draft",
    currency: "USD",
    total_amount: 3612.36,
    issued_at: null,
    issued_by: null,
    raw_payload: {
      sources: { quote: { quote_no: "QUO-20261017-001" } },
      custom: {},
      _render: {
        render_version: 1,
        input_sha256:
          "2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c",
        frozen_at: "2026-10-18T08:00:00Z",
      },
    },
    created_at: "2026-10-18T07:30:00Z",
  },
];

/** 「现在重算出来的摘要」：只给需要演示"数据被改"的单证一个不同值。
 *  真实后端每次装配都会算；mock 没有装配管线，用固定串表示"与冻结值不同"。 */
const FINGERPRINT_CURRENT_SHA: Record<number, string> = {
  1: "9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b",
};

/** 列表行上挂的最近对账结论（与 FINGERPRINT_CURRENT_SHA 的故事保持一致）。 */
const DOC_RENDER_CHECKS: Record<number, MockRenderCheck | null> = {
  1: {
    matches: false,
    reason: "data_changed",
    render_version_drift: false,
    checked_at: "2026-10-20T01:00:00Z",
  },
  2: {
    // 摘要一致（matches=true）但模板版本变了 ⇒ 徽章是「模板已更新」而不是「已变更」
    matches: true,
    reason: "version_drift",
    render_version_drift: true,
    checked_at: "2026-10-20T01:00:00Z",
  },
  3: null,
  4: {
    matches: true,
    reason: "matched",
    render_version_drift: false,
    checked_at: "2026-10-20T01:00:00Z",
  },
};

/** 询盘状态机（真源 = `worker/src/ws_crm_ext.py:_INQUIRY_NEXT`）。 */
const INQUIRY_NEXT: Record<string, readonly string[]> = {
  unquoted: ["closed"],
  quoted: ["closed"],
  closed: ["unquoted", "quoted"],
};
const INQUIRY_STATUSES: readonly string[] = ["unquoted", "quoted", "closed"];

/** 询盘阶段变更历史（`GET /inquiries/{id}/stage-log` 的数据源）。
 *  形状 = `ws_crm_ext.py:414-451`：from_stage / to_stage / source_event / actor_id / note / created_at。 */
type MockInquiryStageLog = {
  from_stage: string | null;
  to_stage: string;
  source_event: string;
  actor_id: string | null;
  note: string | null;
  created_at: string;
};
let inquiryStageLogStore = new Map<number, MockInquiryStageLog[]>();

function inquiryStageLogsOf(inquiryId: number): MockInquiryStageLog[] {
  let rows = inquiryStageLogStore.get(inquiryId);
  if (!rows) {
    rows = [];
    inquiryStageLogStore.set(inquiryId, rows);
  }
  return rows;
}

/** file_objects 行投影（列 = `worker/src/ws_files.py:_META_COLS` / `_row_to_file`）。 */
type MockFileObject = {
  id: number;
  tenant_id: string;
  team_id: number | null;
  owner_type: string;
  owner_id: string | null;
  kind: string;
  media_kind: string | null;
  name: string;
  storage: string;
  object_key: string | null;
  file_name: string | null;
  content_type: string | null;
  file_size: number | null;
  sha256: string | null;
  version: number;
  supersedes_id: number | null;
  is_current: boolean;
  is_primary: boolean;
  sort_order: number;
  uploaded_by: string | null;
  created_at: string;
};

let fileObjectsStore: MockFileObject[] = [];
let fileObjectSeq = 1;
/** 文件字节（`GET /file-objects/:id/content` 用；inline 落点才有）。 */
const fileObjectBytes = new Map<
  number,
  { bytes: Uint8Array; contentType: string }
>();

/** 单证挂文件的链接行（`trade_doc_files`；`GET /trade-docs/:id/files` 的 link_* 字段）。 */
type MockDocFileLink = {
  link_id: number;
  file_id: number;
  role: string;
  caption: string | null;
  sort_order: number;
};
let docFileLinksStore = new Map<number, MockDocFileLink[]>();
let docFileLinkSeq = 1;

/** 产品基础信息（`product_profiles.info`；`ws_files.py:412-434` 的 GET 形状）。 */
const productProfilesStore = new Map<string, Record<string, unknown>>();
/** 产品图类型（真源 = `kaas_common/files/rules.py:34`）。 */
const MEDIA_KIND_LABELS: Record<string, string> = {
  production: "生产图片",
  size: "尺寸图片",
  weight: "重量图片",
  finished: "成品图片",
  other: "其它",
};

/** 租户产品定义（字段逐条对齐 `ws_products.py:_product_out`，含 spec 解码）。 */
type MockTenantProduct = {
  id: number;
  product_key: string;
  product_name: string;
  product_name_en: string | null;
  category_code: string | null;
  cost_field: string;
  cost_basis: string;
  cost_unit: string | null;
  profit_mode: string;
  profit_value: number;
  misc_fee_rate: number;
  spec: Record<string, unknown>;
  is_system: boolean;
  is_active: boolean;
  created_at: string | null;
};

let tenantProductsStore: MockTenantProduct[] = [];
let tenantProductSeq = 1;
/** 工位启用矩阵（`tenant_workstation_products`）：只存显式登记过的行，缺省 = 启用。 */
const tenantProductStatusStore = new Map<string, boolean>();

/** 团队（`ws_teams.py:_team_out`）。 */
type MockTeam = {
  id: number;
  name: string;
  created_by: number;
  created_at: string;
};
type MockTeamMember = {
  user_id: number;
  email: string;
  display_name: string;
  role: string;
  console_access: boolean;
};
type MockTeamInvite = {
  id: number;
  email: string | null;
  token: string;
  status: string;
  created_at: string | null;
  expires_at: string | null;
  accepted_at: string | null;
  accepted_by: number | null;
};
type MockTeamSubscription = {
  code: string;
  active: boolean;
  expires_at: string | null;
  source: string | null;
  created_at: string | null;
};

let teamStore: MockTeam = {
  id: 1,
  name: "示例团队",
  created_by: MOCK_ADMIN_USER.user_id,
  created_at: "2026-10-01T08:00:00.000Z",
};
let teamMembersStore: MockTeamMember[] = [];
let teamInvitesStore: MockTeamInvite[] = [];
let teamSubscriptionStore: MockTeamSubscription[] = [];
let teamInviteSeq = 1;

/** 企业主体信息字段（真源 = `worker/src/main.py:4595-4597` 的 `_COMPANY_FIELDS`）。 */
const COMPANY_PROFILE_FIELDS = [
  "name_en",
  "name_zh",
  "address_en",
  "address_zh",
  "phone",
  "email",
  "website",
  "bank_name",
  "bank_account",
  "swift_code",
  "logo_url",
  "default_incoterm",
  "default_payment_terms",
  "default_country_of_origin",
] as const;
let companyProfileStore: Record<string, string | null> | null = null;

/** 公章（形状 = `ws_seals.py:_to_meta`；图片字节走专用端点，不进元数据）。 */
type MockCompanySeal = {
  id: number;
  name: string;
  mime: string;
  width: number | null;
  height: number | null;
  is_default: boolean;
  created_by: string | null;
  created_at: string | null;
};
let companySealsStore: MockCompanySeal[] = [];
let companySealSeq = 1;

/** 企业税档（`tax_archives.py:_row_out`）。 */
type MockTaxArchive = {
  id: number;
  code: string | null;
  name: string;
  effective_from: string | null;
  effective_to: string | null;
  tax_values: Record<string, number>;
  source: string | null;
  status: string;
  created_at: string | null;
  updated_at: string | null;
};
let taxArchivesStore: MockTaxArchive[] = [];
let taxArchiveSeq = 1;

/** 产品税率（`tax_archives.py:_product_tax_out`）。 */
type MockProductTaxRate = {
  id: number;
  product_key: string;
  input_vat_rate: number | null;
  rebate_rate: number | null;
  status: string;
  created_at: string | null;
  updated_at: string | null;
};
let productTaxRatesStore: MockProductTaxRate[] = [];
let productTaxRateSeq = 1;

/** 1×1 透明 PNG —— 公章 / 图片字节的最小合法占位（`<img>` 解码不会炸）。 */
const MOCK_PNG_BYTES = new Uint8Array([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0,
  0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 10, 73, 68, 65, 84, 120,
  156, 99, 0, 1, 0, 0, 5, 0, 1, 13, 10, 45, 180, 0, 0, 0, 0, 73, 69, 78, 68,
  174, 66, 96, 130,
]);

const TENANT_PRODUCT_SEEDS: MockTenantProduct[] = [
  {
    id: 1,
    product_key: "field_fence",
    product_name: "牛栏网（租户自定义）",
    product_name_en: "Field Fence (tenant)",
    category_code: "niulanwang",
    cost_field: "raw_price",
    cost_basis: "pretax",
    cost_unit: "元/㎡",
    profit_mode: "margin_on_price",
    profit_value: 0.08,
    misc_fee_rate: 0.03,
    spec: { key: "field_fence", name: "牛栏网（租户自定义）" },
    is_system: false,
    is_active: true,
    created_at: "2026-10-15T08:00:00.000Z",
  },
];

const TEAM_MEMBER_SEEDS: MockTeamMember[] = [
  {
    user_id: MOCK_ADMIN_USER.user_id,
    email: MOCK_ADMIN_USER.email,
    display_name: MOCK_ADMIN_USER.display_name,
    role: MOCK_ADMIN_USER.role,
    console_access: true,
  },
  {
    user_id: 2,
    email: "ops@kaas.local",
    display_name: "运营小李",
    role: "customer_member",
    console_access: false,
  },
];

const TEAM_INVITE_SEEDS: MockTeamInvite[] = [
  {
    id: 1,
    email: "pending@example.com",
    token: "invite-mock-token-0001",
    status: "pending",
    created_at: "2026-10-18T08:00:00.000Z",
    expires_at: "2026-10-25T08:00:00.000Z",
    accepted_at: null,
    accepted_by: null,
  },
];

const TEAM_SUBSCRIPTION_SEEDS: MockTeamSubscription[] = [
  {
    code: FULL_CHAIN_CODE,
    active: true,
    expires_at: null,
    source: "signup",
    created_at: "2026-10-01T08:00:00.000Z",
  },
];

const COMPANY_PROFILE_SEED: Record<string, string | null> = {
  name_en: "ANPING KAAS WIRE MESH CO., LTD.",
  name_zh: "安平凯斯丝网有限公司",
  address_en: "Wire Mesh Industrial Park, Anping County, Hengshui, Hebei, China",
  address_zh: "河北省衡水市安平县丝网工业园",
  phone: "+86-318-765-4321",
  email: "export@kaas.local",
  website: "https://kaas.local",
  bank_name: "Bank of China, Anping Sub-branch",
  bank_account: "1234567890",
  swift_code: "BKCHCNBJ220",
  logo_url: null,
  default_incoterm: "FOB",
  default_payment_terms: "30% T/T, balance against B/L copy",
  default_country_of_origin: "China",
};

const COMPANY_SEAL_SEEDS: MockCompanySeal[] = [
  {
    id: 1,
    name: "公章",
    mime: "image/png",
    width: 1,
    height: 1,
    is_default: true,
    created_by: String(MOCK_ADMIN_USER.user_id),
    created_at: "2026-10-01T09:00:00.000Z",
  },
];

const TAX_ARCHIVE_SEEDS: MockTaxArchive[] = [
  {
    id: 1,
    code: "TAX-20261001-1",
    name: "默认税档（13% 销项）",
    effective_from: "2026-10-01",
    effective_to: null,
    tax_values: { output_vat_rate: 0.13, misc_fee_rate: 0.03 },
    source: "manual",
    status: "active",
    created_at: "2026-10-01T08:00:00.000Z",
    updated_at: "2026-10-01T08:00:00.000Z",
  },
];

const PRODUCT_TAX_RATE_SEEDS: MockProductTaxRate[] = [
  {
    id: 1,
    product_key: "field_fence",
    input_vat_rate: 0.13,
    rebate_rate: 0.13,
    status: "active",
    created_at: "2026-10-01T08:00:00.000Z",
    updated_at: "2026-10-01T08:00:00.000Z",
  },
];

/** 把 P1 组 store 恢复成种子（`resetMockData()` 调用；浏览器每次加载即种子状态）。 */
function seedP1Stores(): void {
  docsStore.splice(0, docsStore.length, ...clone(DOC_SEEDS));
  fileObjectsStore = [];
  fileObjectBytes.clear();
  fileObjectSeq = 1;
  docFileLinksStore = new Map();
  docFileLinkSeq = 1;
  productProfilesStore.clear();
  tenantProductsStore = clone(TENANT_PRODUCT_SEEDS);
  tenantProductSeq =
    tenantProductsStore.reduce((max, p) => Math.max(max, p.id), 0) + 1;
  tenantProductStatusStore.clear();
  teamStore = {
    id: 1,
    name: "示例团队",
    created_by: MOCK_ADMIN_USER.user_id,
    created_at: "2026-10-01T08:00:00.000Z",
  };
  teamMembersStore = clone(TEAM_MEMBER_SEEDS);
  teamInvitesStore = clone(TEAM_INVITE_SEEDS);
  teamSubscriptionStore = clone(TEAM_SUBSCRIPTION_SEEDS);
  teamInviteSeq =
    teamInvitesStore.reduce((max, i) => Math.max(max, i.id), 0) + 1;
  companyProfileStore = clone(COMPANY_PROFILE_SEED);
  companySealsStore = clone(COMPANY_SEAL_SEEDS);
  sealBytesStore.clear();
  companySealSeq =
    companySealsStore.reduce((max, s) => Math.max(max, s.id), 0) + 1;
  taxArchivesStore = clone(TAX_ARCHIVE_SEEDS);
  taxArchiveSeq =
    taxArchivesStore.reduce((max, a) => Math.max(max, a.id), 0) + 1;
  productTaxRatesStore = clone(PRODUCT_TAX_RATE_SEEDS);
  productTaxRateSeq =
    productTaxRatesStore.reduce((max, r) => Math.max(max, r.id), 0) + 1;
  // 询盘阶段历史：种子里每条询盘一条「进入当前阶段」的记录（F4 的入口数据）
  inquiryStageLogStore = new Map();
  for (const list of inquiriesStore.values()) {
    for (const inq of list) {
      inquiryStageLogStore.set(inq.id, [
        {
          from_stage: "inquiry",
          to_stage: inq.stage ?? "inquiry",
          source_event: "quote_created",
          actor_id: String(MOCK_ADMIN_USER.user_id),
          note: null,
          created_at: inq.created_at,
        },
      ]);
    }
  }
  // 报价单挂回**真实存在**的询盘：quotesStore 的种子里写死的是 `inquiry_id: 1`，
  // 而询盘 id 由 nextChildId 动态分配（种子联系人先占了 1..6）⇒ 那条引用是悬空的。
  // 不修则「客户 1 的询盘已报价」这个演示状态永远不成立（inquiry_no_editable 恒 true）。
  const firstInquiry = inquiriesStore.get(1)?.[0];
  const firstQuote = quotesStore[0];
  if (firstInquiry && firstQuote) firstQuote.inquiry_id = firstInquiry.id;
}

// ── P1 组 helpers ───────────────────────────────────────────────────────────

/** 单证号是否可改：同一 quote/order 链上还有更晚的单证 ⇒ 锁定
 *  （后端口径 `main.py:4145-4155`：先看 quote_id、再看 order_id）。 */
function docNoEditable(doc: Record<string, unknown>): boolean {
  const id = Number(doc.id);
  const quoteId = doc.quote_id;
  if (quoteId !== null && quoteId !== undefined) {
    return !docsStore.some(
      (d) => Number(d.id) > id && d.quote_id === quoteId,
    );
  }
  const orderId = doc.order_id;
  if (orderId !== null && orderId !== undefined) {
    return !docsStore.some(
      (d) => Number(d.id) > id && d.order_id === orderId,
    );
  }
  return true;
}

/** 询盘是否已生成报价单（决定 `inquiry_no_editable`，ws_crm_ext.py:249-257）。 */
function inquiryHasQuote(inquiryId: number): boolean {
  return quotesStore.some((q) => q.inquiry_id === inquiryId);
}

function findInquiry(
  id: number,
): { inquiry: MockInquiry; list: MockInquiry[] } | null {
  for (const list of inquiriesStore.values()) {
    const inquiry = list.find((i) => i.id === id);
    if (inquiry) return { inquiry, list };
  }
  return null;
}

/** 询盘编号：mock 里按「缩写-日期-序号」生成（真实编号规则在后端 number_rules，
 *  前端只展示/可改，故不必逐字复刻位数）。 */
function nextInquiryNo(customer: MockCustomer): string {
  const abbrRaw = (customer as Record<string, unknown>).abbr;
  const abbr =
    typeof abbrRaw === "string" && abbrRaw.trim()
      ? abbrRaw.trim().toUpperCase()
      : "KAAS";
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const used = new Set<string>();
  for (const list of inquiriesStore.values()) {
    for (const i of list) if (i.inquiry_no) used.add(i.inquiry_no);
  }
  for (let seq = 1; seq <= 999; seq += 1) {
    const candidate = `${abbr}-${stamp}-${String(seq).padStart(3, "0")}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${abbr}-${stamp}-999`;
}

function docFileLinksOf(docId: number): MockDocFileLink[] {
  let links = docFileLinksStore.get(docId);
  if (!links) {
    links = [];
    docFileLinksStore.set(docId, links);
  }
  return links;
}

/** 建一条 file_objects 行（`ws_files.py:_create_file` 的 mock 收敛版）。
 *  `supersede=true` ⇒ 同 owner/kind 的旧"当前件"退位（版本链，不物理删）。 */
function createMockFile(input: {
  owner_type: string;
  owner_id: string | null;
  kind: string;
  media_kind?: string | null;
  name: string;
  content_type?: string | null;
  file_name?: string | null;
  file_size?: number | null;
  sha256?: string | null;
  supersede?: boolean;
  bytes?: Uint8Array | null;
}): MockFileObject {
  if (input.supersede) {
    for (const f of fileObjectsStore) {
      if (
        f.owner_type === input.owner_type &&
        f.owner_id === input.owner_id &&
        f.kind === input.kind &&
        f.is_current
      ) {
        f.is_current = false;
      }
    }
  }
  const created: MockFileObject = {
    id: fileObjectSeq++,
    tenant_id: "default",
    team_id: teamStore.id,
    owner_type: input.owner_type,
    owner_id: input.owner_id,
    kind: input.kind,
    media_kind: input.media_kind ?? null,
    name: input.name,
    storage: input.bytes ? "inline" : "s3",
    object_key: null,
    file_name: input.file_name ?? null,
    content_type: input.content_type ?? null,
    file_size: input.file_size ?? input.bytes?.byteLength ?? null,
    sha256: input.sha256 ?? null,
    version: 1,
    supersedes_id: null,
    is_current: true,
    is_primary: false,
    sort_order: 0,
    uploaded_by: String(MOCK_ADMIN_USER.user_id),
    created_at: nowIso(),
  };
  if (input.bytes) {
    fileObjectBytes.set(created.id, {
      bytes: input.bytes,
      contentType: created.content_type ?? "application/octet-stream",
    });
  }
  fileObjectsStore.push(created);
  return created;
}

/** `Blob` 形状判定（跨 realm 用 duck-typing：`instanceof Blob` 在 node/jsdom 混跑时会误判）。 */
function isBlobLike(value: unknown): value is Blob {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Blob).arrayBuffer === "function" &&
    typeof (value as Blob).size === "number"
  );
}

/** 从 PNG 字节里读 IHDR 宽高（公章上传要回 width/height；纯 Python 校验收紧在后端）。 */
function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24) return null;
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < sig.length; i += 1) {
    if (bytes[i] !== sig[i]) return null;
  }
  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset + 16,
    8,
  );
  return { width: view.getUint32(0), height: view.getUint32(4) };
}

/** 单证对账响应（11 字段，形状真源 `kaas_common/trade_doc/render_fingerprint.py:290-314`）。
 *  mock 没有"重新装配"管线，故用 `FINGERPRINT_CURRENT_SHA` 表示此刻的摘要。 */
function renderFingerprintCheckOf(docId: number) {
  const doc = docsStore.find((d) => Number(d.id) === docId);
  const payload = doc?.raw_payload;
  const frozen =
    typeof payload === "object" &&
    payload !== null &&
    "_render" in payload &&
    typeof (payload as Record<string, unknown>)._render === "object"
      ? ((payload as Record<string, unknown>)._render as Record<string, unknown>)
      : null;
  const checkedAt = nowIso();
  if (!frozen) {
    return {
      has_fingerprint: false,
      frozen: null,
      current_sha256: FINGERPRINT_CURRENT_SHA[docId] ?? null,
      matches: false,
      render_version_frozen: null,
      render_version_current: 1,
      render_version_drift: false,
      reason: "no_fingerprint",
      checked_at: checkedAt,
      current_note: null,
      frozen_note: null,
    };
  }
  const frozenSha =
    typeof frozen.input_sha256 === "string" ? frozen.input_sha256 : null;
  const frozenVersion =
    typeof frozen.render_version === "number" ? frozen.render_version : null;
  const currentSha = FINGERPRINT_CURRENT_SHA[docId] ?? frozenSha;
  const currentVersion = 1;
  const drift = frozenVersion !== null && frozenVersion !== currentVersion;
  let reason: string;
  if (frozenSha === null) reason = "frozen_unavailable";
  else if (currentSha === null) reason = "current_unavailable";
  else if (currentSha !== frozenSha) reason = "data_changed";
  else reason = drift ? "version_drift" : "matched";
  return {
    has_fingerprint: true,
    frozen,
    current_sha256: currentSha,
    matches: frozenSha !== null && currentSha === frozenSha,
    render_version_frozen: frozenVersion,
    render_version_current: currentVersion,
    render_version_drift: drift,
    reason,
    checked_at: checkedAt,
    current_note: currentSha === null ? "input_unavailable" : null,
    frozen_note: typeof frozen.note === "string" ? frozen.note : null,
  };
}

function teamNotFound() {
  return HttpResponse.json(
    { detail: { error: "not_found", code: "TEAM_NOT_FOUND" } },
    { status: 404 },
  );
}

function isTeamAdmin(userId: number, role: string): boolean {
  if (userId === teamStore.created_by) return true;
  return role === "system_admin" || role === "admin";
}

/** `ws_teams.py:_team_out` */
function teamOut() {
  return {
    id: teamStore.id,
    name: teamStore.name,
    created_by: teamStore.created_by,
    is_admin: isTeamAdmin(MOCK_ADMIN_USER.user_id, MOCK_ADMIN_USER.role),
    member_count: teamMembersStore.length,
  };
}

/** `ws_workstations.py:_sub_out`（列表；比 PUT 多一个 created_at）。 */
function subOut(row: MockTeamSubscription) {
  return {
    code: row.code,
    active: row.active,
    expires_at: row.expires_at,
    source: row.source,
    created_at: row.created_at,
  };
}

/** `ws_workstations.py:_sub_set_out`（PUT 的 4 键响应，**不**含 created_at）。 */
function subSetOut(row: MockTeamSubscription) {
  return {
    code: row.code,
    active: row.active,
    expires_at: row.expires_at,
    source: row.source,
  };
}

/** `ws_teams.py:_invite_out` */
function inviteOut(row: MockTeamInvite) {
  return {
    id: row.id,
    email: row.email,
    token: row.token,
    status: row.status,
    created_at: row.created_at,
    expires_at: row.expires_at,
    accepted_at: row.accepted_at,
    accepted_by: row.accepted_by,
  };
}

/** `ws_files.py:_row_to_file`（原样整行投影，FE 只读其中一部分）。 */
function fileOut(file: MockFileObject) {
  return { ...file };
}

/** `ws_seals.py:_to_meta` */
function sealOut(seal: MockCompanySeal) {
  return {
    id: seal.id,
    name: seal.name,
    mime: seal.mime,
    width: seal.width,
    height: seal.height,
    is_default: seal.is_default,
    created_by: seal.created_by,
    created_at: seal.created_at,
    preview_url: `/api/v1/tenant/company-seals/${seal.id}/image`,
  };
}

/** `tax_archives.py:_row_out` */
function taxArchiveOut(row: MockTaxArchive) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    effective_from: row.effective_from,
    effective_to: row.effective_to,
    tax_values: row.tax_values,
    source: row.source,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** `tax_archives.py:_product_tax_out` */
function productTaxOut(row: MockProductTaxRate) {
  return {
    id: row.id,
    product_key: row.product_key,
    input_vat_rate: row.input_vat_rate,
    rebate_rate: row.rebate_rate,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** `ws_products.py:_product_out` */
function tenantProductOut(p: MockTenantProduct) {
  return {
    id: p.id,
    product_key: p.product_key,
    product_name: p.product_name,
    product_name_en: p.product_name_en,
    category_code: p.category_code,
    cost_field: p.cost_field,
    cost_basis: p.cost_basis,
    cost_unit: p.cost_unit,
    profit_mode: p.profit_mode,
    profit_value: p.profit_value,
    misc_fee_rate: p.misc_fee_rate,
    spec: p.spec,
    is_system: p.is_system,
    is_active: p.is_active,
    created_at: p.created_at,
  };
}

/** `main.py:4625-4635` —— 未配置时返回空结构（不是 404），前端表单可直接绑定。 */
function companyProfileResponse(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of COMPANY_PROFILE_FIELDS) {
    out[field] = companyProfileStore?.[field] ?? null;
  }
  out.configured = Boolean(companyProfileStore?.name_en);
  return out;
}

/** 产品注册表里的 key → 名称（用于 `GET /export-quote/products/:key/spec` 与状态校验）。 */
function registryProduct(productKey: string) {
  return MOCK_EXPORT_PRODUCTS.find((p) => p.key === productKey) ?? null;
}

/** `tax_archives.py:_clean_tax_values` —— 只收 0~1 数字；返回 string 表示错误码。 */
function parseTaxValues(raw: unknown): Record<string, number> | string {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return "TAX_VALUES_REQUIRED";
  }
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined || value === null) continue;
    const num = Number(value);
    if (!Number.isFinite(num) || num < 0 || num > 1) {
      return "INVALID_TAX_RATE";
    }
    out[key] = num;
  }
  if (Object.keys(out).length === 0) return "TAX_VALUES_REQUIRED";
  return out;
}

/** `tax_archives.py:_rate_or_422` —— 单条税率；返回 string 表示错误码。 */
function parseTaxRate(raw: unknown): number | null | string {
  if (raw === undefined || raw === null || raw === "") return null;
  const num = Number(raw);
  if (!Number.isFinite(num) || num < 0 || num > 1) return "INVALID_TAX_RATE";
  return num;
}

/** 税率校验失败的统一错误体（与 tax_archives.py 的 422 detail 同形）。 */
function taxValuesError(code: string) {
  const detail =
    code === "INVALID_TAX_RATE"
      ? "税率必须在 0~1 之间（10% 请填 0.1）"
      : code === "TAX_VALUES_REQUIRED"
        ? "至少填写一个税率项"
        : "税率取值非法";
  return HttpResponse.json(
    { detail: { error: "validation", code, detail } },
    { status: 422 },
  );
}

/** 公章图片字节（与 file_objects 的 id 空间分开存，避免 id 撞号）。 */
const sealBytesStore = new Map<number, Uint8Array>();


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
      created_at: "2026-08-01T09:00:00Z",
    },
    {
      id: 2,
      name: "李工",
      position: "生产主管",
      phone: "+86-138-0000-0002",
      email: "li@example.com",
      whatsapp: null,
      is_primary: false,
      created_at: "2026-10-05T09:00:00Z",
    },
    {
      id: 3,
      name: "张工",
      position: "质检",
      phone: "+86-138-0000-0003",
      email: "zhang@example.com",
      whatsapp: null,
      is_primary: false,
      created_at: "2026-09-12T09:00:00Z",
    },
  ].map((c) => ({ ...c, id: nextChildId++ }));
}

function seedInquiries(customerId: number): MockInquiry[] {
  const now = Date.now();
  return [
    {
      id: nextChildId++,
      customer_id: customerId,
      // 对齐后端 `row_to_inquiry` 的 inquiry_no / stage 两键（customer_serializers.py:73-104）
      inquiry_no: `CN-C${customerId}-20261015-001`,
      lead_id: null,
      channel: "alibaba",
      category_id: null,
      product_name_raw: "牛栏网 2.5mm × 1.5m",
      quantity: 1000,
      quantity_unit: "m",
      application: "牧场围栏",
      // 已报价的询盘（不是 open）—— 详见 PATCH /stage 处关于 409 二次确认的说明
      status: "quoted",
      stage: "quotation",
      stage_updated_at: new Date(now - 5 * 86400000).toISOString(),
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
      to_stage: "active",
      reason: "新建客户",
      created_at: new Date(now - 30 * 86400000).toISOString(),
    },
    {
      id: nextChildId++,
      from_stage: "active",
      to_stage: customer.manual_stage ?? customer.stage,
      reason:
        customer.manual_stage === "inactive" ? "手动切换为沉寂" : "收到询盘",
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
  // P1 组 store（单证/产品/团队/税档/企业信息/公章/文件）一并回到种子
  seedP1Stores();
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
  // member_count 从 mock 成员表**真实派生**（teamStore/teamMembersStore 见 P1 组 store），
  // 否则「成员列表 2 条、团队卡说 1 人」自相矛盾。
  http.get("/api/v1/teams/me", () =>
    HttpResponse.json({
      team: {
        id: teamStore.id,
        name: teamStore.name,
        created_by: teamStore.created_by,
        is_admin: true,
        member_count: teamMembersStore.length,
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

  // 个人信息编辑（TODO F3）：mock 必须**真的**改显示名 —— "保存成功但界面没变"
  // 正是这层要防的假成功。密码在 mock 里不存明文：只校验长度与非空旧密码
  // （真实旧密码校验在后端，e2e 只走成功链路）。
  http.patch("/api/v1/auth/me", async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as {
      display_name?: string;
    };
    const name = String(body.display_name ?? "").trim();
    if (!name) {
      return HttpResponse.json(
        {
          detail: {
            error: "validation",
            code: "DISPLAY_NAME_REQUIRED",
            detail: "显示名不能为空",
          },
        },
        { status: 422 },
      );
    }
    MOCK_ADMIN_USER.display_name = name;
    return HttpResponse.json(MOCK_ADMIN_USER);
  }),
  http.post("/api/v1/auth/change-password", async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as {
      current_password?: string;
      new_password?: string;
    };
    if ((body.new_password ?? "").length < 8) {
      return HttpResponse.json(
        {
          detail: {
            error: "validation",
            code: "PASSWORD_TOO_SHORT",
            detail: "Password must be at least 8 characters",
          },
        },
        { status: 422 },
      );
    }
    if (!(body.current_password ?? "")) {
      return HttpResponse.json(
        {
          detail: {
            error: "forbidden",
            code: "INVALID_CURRENT_PASSWORD",
            detail: "当前密码不正确",
          },
        },
        { status: 403 },
      );
    }
    return HttpResponse.json({ message: "Password updated" });
  }),

  // ── Auth · 注册（task-6：原先缺失 ⇒ 放行到网络 ⇒ 自代理永久挂起）─────────
  // 消费方 lib/auth/auth-context.tsx:127-139 `register()`：
  //   · `res.data.access_token` 必须存在（:130 直接写进会话）
  //   · `buildUser(res.data)`（:55-67）要 user_id/email/display_name/account_type/
  //     role/plan/team_id/team_name/console_access 共 8 项
  // 后端 orchestrator/app/api/auth.py:162-281（无 status_code ⇒ 200）：
  //   `_auth_response`（:145-159）= 上面 8 项 + access_token/token_type；
  //   强制 `account_type="customer"`、`plan="free"`（:250-252）；
  //   角色 `"user"`(凭邀请码) / `"owner"`（:245）。
  // 校验口径照后端：email/password/display_name/product_category 必填
  // （:200-207；company_name 自 2026-10-19 起可选——注册页只留团队名称）、
  // 密码 ≥8（:209-210）、邮箱重复 409（:238-240）。
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
    const productCategory = String(body.product_category ?? "").trim();
    if (!email || !password || !displayName || !productCategory) {
      return HttpResponse.json(
        {
          error_code: "VALIDATION_ERROR",
          message: "邮箱、密码、姓名、主营类型均为必填",
          detail:
            "validation_error: email, password, display_name, product_category are required",
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

  // ── OSS（已删除：后端没有这条路由）─────────────────────────────────
  // `POST /oss/presign` 在 worker 全仓 **0 命中**（审计报告 §2-5）。原先这个 mock
  // 回 200，把"生产环境这一步必然失败"掩盖成正向路径；前端 `lib/events/client.ts`
  // catch 后回退内联，看起来一切正常。
  // 现在前端已删掉该死代码路径（事件 payload 直接内联，理由见该文件注释），
  // mock 也一并移除 —— 不存在的接口不应继续被 mock 撑成"存在"。

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
    const contactName = String(body.contact_name ?? "").trim();
    // 与后端一致（2026-10-17 口径）：公司名与联系人至少填一个。
    if (!companyName && !contactName) {
      return HttpResponse.json(
        {
          error_code: "CUSTOMER_IDENTITY_REQUIRED",
          message: "公司名称和联系人至少填写一个",
          detail: "公司名称和联系人至少填写一个",
        },
        { status: 422 },
      );
    }
    const stage = String(body.stage ?? "active") || "active";
    if (!CUSTOMER_STAGES.includes(stage)) {
      // 后端错误 detail 是对象型；页面 errMsg 已兼容对象（page.tsx errMsg）。
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
      company_name: companyName || contactName,
      country: optStr(body.country),
      address: optStr(body.address),
      default_port: optStr(body.default_port),
      credit_level: optStr(body.credit_level),
      stage,
      manual_stage: stage,
      notes: optStr(body.notes),
      created_at: at,
      updated_at: at,
    };
    customersStore.push(created);
    contactsStore.set(created.id, []);
    inquiriesStore.set(created.id, []);
    if (contactName) {
      contactsOf(created.id).push({
        id: nextChildId++,
        name: contactName,
        position: null,
        phone: optStr(body.contact_phone),
        email: optStr(body.contact_email),
        whatsapp: null,
        is_primary: true,
      });
    }
    // 后端建客户时写一条 stage_log
    stageLogsOf(created.id).push({
      id: nextChildId++,
      from_stage: null,
      to_stage: stage,
      reason: "新建客户",
      created_at: at,
    });
    return HttpResponse.json(created, { status: 201 });
  }),

  // PATCH /customers/:id ← 消费方 page.tsx CustomerForm（编辑档案，2026-10-18 新增）
  //   请求体 = 档案字段；**不含 stage**（阶段走 /stage）。语义照后端：
  //   exclude_unset —— 只改显式出现的字段，传 null = 清空。
  http.patch("/api/v1/customers/:id", async ({ params, request }) => {
    const customer = customersStore.find((c) => c.id === Number(params.id));
    if (!customer) return customerNotFound(params.id);
    const body = (await request.json()) as Record<string, unknown>;
    const companyName = String(body.company_name ?? "").trim();
    if ("company_name" in body && !companyName) {
      return HttpResponse.json(
        {
          error_code: "INVALID_ARGUMENT",
          message: "公司名称不能为空",
          detail: "公司名称不能为空",
        },
        { status: 422 },
      );
    }
    if ("company_name" in body) customer.company_name = companyName;
    for (const key of [
      "country",
      "address",
      "default_port",
      "credit_level",
      "notes",
    ] as const) {
      if (key in body) {
        (customer as Record<string, unknown>)[key] = optStr(body[key]);
      }
    }
    customer.updated_at = nowIso();
    return HttpResponse.json(customer);
  }),

  // DELETE /customers/:id ← 消费方 page.tsx DeleteCustomer（2026-10-18 新增）
  //   后端：软删除，列表隐藏；有开启中的订单 409 OPEN_ORDERS_EXIST。
  //   mock 没有客户维度的订单夹具，故这里只做软删除（从 store 移除）。
  http.delete("/api/v1/customers/:id", ({ params }) => {
    const id = Number(params.id);
    const idx = customersStore.findIndex((c) => c.id === id);
    if (idx < 0) return customerNotFound(params.id);
    customersStore.splice(idx, 1);
    contactsStore.delete(id);
    inquiriesStore.delete(id);
    stageLogStore.delete(id);
    return new HttpResponse(null, { status: 204 });
  }),

  // PATCH /customers/:id/stage ← 消费方 page.tsx（StageUpdate）
  //   2026-10-18：只有 active / inactive 可手写；ordered 由开启中的订单推导，
  //   传 ordered 回 422（与后端 validate_manual_stage 同口径）。
  http.patch("/api/v1/customers/:id/stage", async ({ params, request }) => {
    const customer = customersStore.find((c) => c.id === Number(params.id));
    if (!customer) return customerNotFound(params.id);
    const body = (await request.json()) as Record<string, unknown>;
    const target = String(body.stage ?? "");
    if (!CUSTOMER_STAGES.includes(target)) {
      return HttpResponse.json(
        {
          error_code: "INVALID_ENUM",
          message: "客户阶段取值非法",
          detail:
            target === "ordered"
              ? "「已下单」由开启中的订单自动推导，不能手动设置"
              : `invalid_enum_value: customer_stage=${target}`,
        },
        { status: 422 },
      );
    }
    const fromStage = customer.manual_stage ?? customer.stage;
    const at = nowIso();
    customer.stage = target;
    customer.manual_stage = target;
    customer.updated_at = at;
    stageLogsOf(customer.id).push({
      id: nextChildId++,
      from_stage: fromStage,
      to_stage: target,
      reason: optStr(body.reason),
      created_at: at,
    });
    return HttpResponse.json({
      ...customer,
      manual_stage: target,
      closed_inquiries: [],
    });
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
      created_at: nowIso(),
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
  //   `("email","whatsapp","alibaba","expo","website","quote","other")` 且**大小写敏感**
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
      inquiry_no: nextInquiryNo(customer),
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
      status: "unquoted",
      // 新询盘的阶段恒为 inquiry（后端 `inquiry_stage.STAGE_INQUIRY` 的起点）
      stage: "inquiry",
      stage_updated_at: at,
      created_at: at,
    };
    inquiriesOf(customer.id).push(inquiry);
    // 2026-10-18：询盘属于单据阶段，不再联动客户阶段。
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
    // 询盘来源：报价单通过 inquiry_id 挂回询盘（与后端 quote_orders.inquiry_id 同口径）。
    // 第一条报价挂到该客户现有询盘；第二条报价刻意不挂，用来演示"未关联询盘的单据"。
    const linkedInquiryId = customer
      ? (inquiriesOf(customer.id)[0]?.id ?? null)
      : null;
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
          inquiry_id: linkedInquiryId,
          documents: [
            {
              id: 12,
              doc_no: "QUO-202609-0004",
              doc_type: "quotation",
              status: "issued",
              currency: "USD",
              total_amount: 12300,
              created_at: "2026-09-27T14:56:42Z",
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
                  currency: "USD",
                  total_amount: 12300,
                  created_at: "2026-09-28T10:00:00Z",
                },
                {
                  id: 2,
                  doc_no: "CI-202609-0001",
                  doc_type: "ci",
                  status: "issued",
                  currency: "USD",
                  total_amount: 12300,
                  created_at: "2026-09-29T09:00:00Z",
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
          inquiry_id: null,
          documents: [
            {
              id: 11,
              doc_no: "QUO-202609-0003",
              doc_type: "quotation",
              status: "draft",
              currency: "USD",
              total_amount: 8000,
              created_at: "2026-09-26T10:00:00Z",
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
                currency: "USD",
                total_amount: 5400,
                created_at: "2026-09-21T08:00:00Z",
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
            currency: "USD",
            total_amount: 5400,
            created_at: "2026-09-21T07:00:00Z",
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

  // ── Deployment Audit（后端**没有**这条路由 ⇒ 如实 404）────────────────────
  // 依据：worker 全仓只有 main.py:2959 的一条注释，没有 `@app.get(...deployment_audit)`；
  // 生产 404 属**设计**（`docs/PROBLEM_STATUS_2026-10-11.md` 的 route-parity allowlist）。
  // 原先这里回 200 + 一份伪造时间线 ⇒ mock 把"生产根本没有这条路"掩盖成"有记录"，
  // 管理员在 mock 下看到的是永远不存在的功能。
  //
  // 前端 `use-deployment-audit.ts` 已按真实语义处理该错误态（区分"接口不可用"与
  // "暂无记录"）；灰度变更的可审计记录仍在 `GET /admin/audit-log`（下方 handler）。
  http.get("/api/v1/admin/deployment_audit", () =>
    HttpResponse.json({ detail: "Not Found" }, { status: 404 }),
  ),

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

  // ── 订单（orders）────────────────────────────────────────────────────────
  // 补洞主链（quote → order）：orders 页与报价转单在 mock 模式下此前全部无 handler。
  // 写操作真改 store：转单后订单列表/详情跟着变，e2e 才能断言。
  http.get("/api/v1/orders", () => {
    return HttpResponse.json({
      items: ordersStore.slice().sort((a, b) => b.id - a.id),
      total: ordersStore.length,
      page: 1,
      page_size: 100,
    });
  }),

  http.post("/api/v1/orders", async ({ request }) => {
    const body = (await request.json()) as {
      quote_order_id?: number;
      customer_id?: number;
    };
    // 报价转单：客户/金额/贸易条款从报价单继承（与后端口径一致）
    const quote = body.quote_order_id
      ? quotesStore.find((q) => q.id === body.quote_order_id)
      : null;
    const customer = customersStore.find(
      (c) => c.id === (quote?.customer_id ?? body.customer_id),
    );
    const nextId = Math.max(0, ...ordersStore.map((o) => o.id)) + 1;
    const order = {
      id: nextId,
      order_no: `ORD-2026${String(nextId).padStart(4, "0")}`,
      quote_order_id: quote?.id ?? null,
      customer_id: quote?.customer_id ?? body.customer_id ?? null,
      customer_name:
        quote?.customer_name ??
        (customer as { company_name?: string })?.company_name ??
        null,
      status: "pending",
      currency: quote?.currency ?? "USD",
      total_amount: quote?.total_amount ?? null,
      order_date: nowIso(),
      delivery_date: null,
      incoterm: null,
      payment_terms: null,
      port_of_loading: null,
      port_of_destination: null,
      shipping_marks: null,
      country_of_origin: null,
    };
    ordersStore.push(order);
    return HttpResponse.json(order, { status: 201 });
  }),

  http.patch("/api/v1/orders/:id", async ({ params, request }) => {
    const order = ordersStore.find((o) => o.id === Number(params.id));
    if (!order) {
      return HttpResponse.json(
        { detail: { error: "not_found" } },
        { status: 404 },
      );
    }
    Object.assign(order, await request.json());
    return HttpResponse.json(order);
  }),

  // ── 单证（trade-docs）──────────────────────────────────────────────────────
  // 列表行必须带两个后端字段（原先 mock 直接回 docsStore，两个键都缺）：
  //   · `doc_no_editable` —— 同一条 quote/order 链上还有更晚的单证 ⇒ 号码锁定
  //     （`main.py:4145-4155`，前端 `use-trade-docs.ts:50` 读）；
  //   · `render_check` —— 最近一次定时对账结论（`main.py:4157-4180`，
  //     形状 matches/reason/render_version_drift/checked_at）。缺了它，
  //     A8/A9 的「已变更 / 模板已更新 / 待复核」标识在 mock 下永远不会出现。
  //   `null` = 从未对账 ⇒ 前端**不显示任何标识**（`lib/trade-doc/render-check.ts:39-44`
  //   的口径：不能把"没查过"画成"没问题"）。
  http.get("/api/v1/trade-docs", () => {
    const items = docsStore
      .slice()
      .sort((a, b) => b.id - a.id)
      .map((doc) => ({
        ...doc,
        doc_no_editable: docNoEditable(doc),
        render_check: DOC_RENDER_CHECKS[Number(doc.id)] ?? null,
      }));
    return HttpResponse.json({
      items,
      total: items.length,
      page: 1,
      page_size: 50,
    });
  }),

  http.post("/api/v1/trade-docs", async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>;
    const nextId = Math.max(0, ...docsStore.map((d) => d.id)) + 1;
    const doc = {
      id: nextId,
      doc_no: `${String(body.doc_type ?? "doc").toUpperCase()}-2026${String(nextId).padStart(4, "0")}`,
      doc_type: String(body.doc_type ?? "pi"),
      order_id: (body.order_id as number) ?? null,
      // 后端的单证号锁定推导先看 quote_id 再看 order_id（main.py:4145-4152），
      // 故 POST 也把 quote_id 存下来，否则新建的报价单证无法参与推导。
      // `quote_order_id` 是前端既有入参名（use-trade-docs.ts:135），后端两者等价
      // （main.py:create_trade_doc 的 quote_ref 取任意一个）。
      quote_id:
        (body.quote_id as number) ?? (body.quote_order_id as number) ?? null,
      customer_id: (body.customer_id as string) ?? null,
      status: "draft",
      currency: String(body.currency ?? "USD"),
      total_amount: (body.total_amount as number) ?? null,
      issued_at: null,
      issued_by: null,
      raw_payload: null,
      created_at: nowIso(),
    };
    docsStore.push(doc);
    return HttpResponse.json(doc, { status: 201 });
  }),

  http.get("/api/v1/trade-docs/:id", ({ params }) => {
    const doc = docsStore.find((d) => d.id === Number(params.id));
    if (!doc) {
      return HttpResponse.json(
        { detail: { error: "not_found" } },
        { status: 404 },
      );
    }
    return HttpResponse.json(doc);
  }),

  // 签发 / 改内容（TODO F1：PATCH 可携带 html，由服务端出 PDF 并归档）——
  // mock 环境没有浏览器渲染器，与 `POST /trade-docs/:id/pdf` 同口径**如实失败**
  // （pdf_archive.ok=false + 503），界面据此提示手动上传，不假装归档成功。
  http.patch("/api/v1/trade-docs/:id", async ({ params, request }) => {
    const doc = docsStore.find((d) => d.id === Number(params.id));
    if (!doc) {
      return HttpResponse.json(
        { detail: { error: "not_found" } },
        { status: 404 },
      );
    }
    const body = (await request.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    for (const key of ["doc_no", "status", "raw_payload"] as const) {
      if (key in body) doc[key] = body[key];
    }
    const out: Record<string, unknown> = { ...doc };
    if (
      body.status === "issued" &&
      typeof body.html === "string" &&
      body.html.trim()
    ) {
      out.pdf_archive = {
        ok: false,
        status_code: 503,
        detail: {
          error: "unavailable",
          code: "PDF_RENDERER_NOT_CONFIGURED",
          detail: "mock 环境未配置浏览器渲染器",
        },
      };
    }
    return HttpResponse.json(out);
  }),

  // 单证内嵌预览（客户详情 → 单证）：mock 用固定样板数据渲染，避免预览空转。
  // 真实环境由后端 `/trade-docs/{id}/render-data` 按快照装配。
  http.get("/api/v1/trade-docs/:id/render-data", ({ params }) => {
    const id = Number(params.id);
    const known: Record<
      number,
      { doc_type: string; doc_no: string; status: string; total_amount: number }
    > = {
      2: {
        doc_type: "ci",
        doc_no: "CI-202609-0001",
        status: "issued",
        total_amount: 12300,
      },
      3: {
        doc_type: "pi",
        doc_no: "PI-202609-0002",
        status: "draft",
        total_amount: 12300,
      },
      11: {
        doc_type: "quotation",
        doc_no: "QUO-202609-0003",
        status: "draft",
        total_amount: 8000,
      },
      12: {
        doc_type: "quotation",
        doc_no: "QUO-202609-0004",
        status: "issued",
        total_amount: 12300,
      },
      21: {
        doc_type: "bl",
        doc_no: "BL-202609-0004",
        status: "issued",
        total_amount: 5400,
      },
      22: {
        doc_type: "pl",
        doc_no: "PL-202609-0003",
        status: "draft",
        total_amount: 5400,
      },
    };
    const fromStore = docsStore.find((d) => d.id === id);
    const meta = known[id] ?? fromStore;
    if (!meta) {
      return HttpResponse.json(
        { detail: { error: "not_found" } },
        { status: 404 },
      );
    }
    const sample = tradeDocSample as unknown as {
      base: Record<string, unknown>;
      other_extra?: Record<string, unknown>;
    };
    return HttpResponse.json({
      doc: {
        id,
        doc_no: "doc_no" in meta ? meta.doc_no : `DOC-${id}`,
        doc_type: "doc_type" in meta ? meta.doc_type : "ci",
        status: "status" in meta ? meta.status : "draft",
        currency: "USD",
        total_amount: "total_amount" in meta ? meta.total_amount : null,
        raw_payload: null,
        created_at: "2026-09-29T09:00:00Z",
      },
      data: {
        ...sample.base,
        ...(meta.doc_type === "other" ? (sample.other_extra ?? {}) : {}),
      },
      company_profile_configured: false,
    });
  }),

  // 单证归档文件版本（真实环境由 files 接口返回 version/is_current/supersedes 链）
  // 形状 = `ws_files.py:597-614`：file 元数据 + 该链接行的 link_id/role/caption/sort_order。
  // 原先固定回 `{items: []}` ⇒ 上传/解绑后列表永远不刷新（假成功）。
  http.get("/api/v1/trade-docs/:id/files", ({ params }) => {
    const docId = Number(params.id);
    const items = docFileLinksOf(docId)
      .map((link) => {
        const file = fileObjectsStore.find((f) => f.id === link.file_id);
        if (!file) return null;
        return {
          ...fileOut(file),
          link_id: link.link_id,
          role: link.role,
          caption: link.caption,
          sort_order: link.sort_order,
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null);
    return HttpResponse.json({ items });
  }),

  // 上传并挂到单证（客户盖章回传）。`role` 属于版本化角色时旧"当前件"退位、
  // 旧链接改挂 `<role>_superseded`（ws_files.py:634-640 + 660-678）。
  http.post("/api/v1/trade-docs/:id/files/upload", async ({ params, request }) => {
    const docId = Number(params.id);
    const doc = docsStore.find((d) => d.id === docId);
    if (!doc) {
      return HttpResponse.json(
        { detail: { error: "not_found", code: "DOC_NOT_FOUND" } },
        { status: 404 },
      );
    }
    const form = await request.formData();
    const fileEntry = form.get("file");
    if (!isBlobLike(fileEntry)) {
      return HttpResponse.json(
        {
          detail: {
            error: "validation",
            code: "FILE_REQUIRED",
            detail: "缺少上传文件",
          },
        },
        { status: 422 },
      );
    }
    const roleRaw = form.get("role");
    const role = typeof roleRaw === "string" && roleRaw ? roleRaw : "stamp_scan";
    const nameRaw = form.get("name");
    const name =
      (typeof nameRaw === "string" ? nameRaw.trim() : "") ||
      fileEntry.name ||
      "回传件";
    const captionRaw = form.get("caption");
    const caption =
      typeof captionRaw === "string" && captionRaw.trim()
        ? captionRaw.trim()
        : null;
    const bytes = new Uint8Array(await fileEntry.arrayBuffer());
    const created = createMockFile({
      owner_type: "trade_doc",
      owner_id: String(docId),
      kind: role,
      name,
      content_type: fileEntry.type || "application/octet-stream",
      file_name: fileEntry.name || null,
      file_size: bytes.byteLength,
      bytes,
      supersede: role === "stamp_scan" || role === "render_pdf",
    });
    const links = docFileLinksOf(docId);
    if (role === "stamp_scan" || role === "render_pdf") {
      for (const link of links) {
        if (link.role === role) link.role = `${role}_superseded`;
      }
    }
    const link: MockDocFileLink = {
      link_id: docFileLinkSeq++,
      file_id: created.id,
      role,
      caption,
      sort_order: 0,
    };
    links.push(link);
    return HttpResponse.json(
      {
        file: fileOut(created),
        link: {
          id: link.link_id,
          role: link.role,
          caption: link.caption,
          sort_order: link.sort_order,
        },
      },
      { status: 201 },
    );
  }),

  // 摘除引用（不删文件本身：文件是留档资料，只解绑）—— ws_files.py:648-657
  http.delete(
    "/api/v1/trade-docs/:id/files/:linkId",
    ({ params }) => {
      const docId = Number(params.id);
      const links = docFileLinksOf(docId);
      const index = links.findIndex(
        (l) => l.link_id === Number(params.linkId),
      );
      if (index < 0) {
        return HttpResponse.json(
          { detail: { error: "not_found", code: "LINK_NOT_FOUND" } },
          { status: 404 },
        );
      }
      links.splice(index, 1);
      return new HttpResponse(null, { status: 204 });
    },
  ),

  // 从上游重新带入快照（仅 draft；已签发冻结）—— ws_docs_ext.py:refresh-sources
  // 响应 `{doc, sources:[...]}`；无上游 ⇒ 422 NO_UPSTREAM。
  http.post("/api/v1/trade-docs/:id/refresh-sources", ({ params }) => {
    const doc = docsStore.find((d) => d.id === Number(params.id));
    if (!doc) {
      return HttpResponse.json(
        { detail: { error: "not_found", code: "DOC_NOT_FOUND" } },
        { status: 404 },
      );
    }
    if (doc.status !== "draft") {
      return HttpResponse.json(
        {
          detail: {
            error: "conflict",
            code: "NOT_DRAFT",
            detail: "仅 draft 状态可重新带入上游数据（已签发单据已冻结）",
          },
        },
        { status: 409 },
      );
    }
    const payload = (doc.raw_payload ?? {}) as Record<string, unknown>;
    const custom = (payload.custom ?? {}) as Record<string, unknown>;
    const sources: Record<string, unknown> = {};
    if (doc.order_id != null) {
      sources.order = {
        order_no: `ORD-2026${String(doc.order_id).padStart(4, "0")}`,
      };
    }
    if (doc.quote_id != null) {
      sources.quote = { quote_no: `QUO-2026${String(doc.quote_id).padStart(4, "0")}` };
    }
    if (Object.keys(sources).length === 0) {
      return HttpResponse.json(
        {
          detail: {
            error: "validation",
            code: "NO_UPSTREAM",
            detail: "该单据没有可重新带入的上游来源",
          },
        },
        { status: 422 },
      );
    }
    doc.raw_payload = { sources, custom };
    // 内容级版本：重新带入上游快照也是一次内容变更，留版（TODO A1 同口径）
    const versions = contentVersionsOf(Number(doc.id));
    versions.push({
      version_no: Math.max(...versions.map((v) => v.version_no), 0) + 1,
      change_source: "refresh_sources",
      actor_id: String(MOCK_ADMIN_USER.user_id),
      note: null,
      created_at: nowIso(),
      custom_keys: Object.keys(custom),
      raw_payload: doc.raw_payload as Record<string, unknown>,
    });
    return HttpResponse.json({ doc, sources: Object.keys(sources) });
  }),

  // 渲染指纹对账（C 方案消费者）：**只读**，11 字段与共享内核逐字一致
  // （kaas_common/trade_doc/render_fingerprint.py:290-314）。
  // 消费方 `useCheckTradeDocRenderFingerprint`（use-trade-docs.ts:431-440），
  // 用户点「对账」才发一次（不挂自动查询）。
  http.get(
    "/api/v1/trade-docs/:id/render-fingerprint-check",
    ({ params }) => {
      const id = Number(params.id);
      const doc = docsStore.find((d) => d.id === id);
      if (!doc) {
        return HttpResponse.json(
          { detail: { error: "not_found", code: "DOC_NOT_FOUND" } },
          { status: 404 },
        );
      }
      return HttpResponse.json(renderFingerprintCheckOf(id));
    },
  ),

  // 自动出 PDF（服务端 Browser Rendering）：mock 环境没有渲染器，
  // 如实返回 503，让前端走“手动归档”的降级提示，而不是假装成功。
  http.post("/api/v1/trade-docs/:id/pdf", () => {
    return HttpResponse.json(
      { detail: { error: "renderer_unavailable" } },
      { status: 503 },
    );
  }),

  // ── 单证内容版本（TODO A1）───────────────────────────────────────────────
  // 列表**不带**整份 payload（与真实后端一致：图片 base64 会让响应到 1MB+）
  http.get("/api/v1/trade-docs/:id/content-versions", ({ params }) => {
    const docId = Number(params.id);
    const items = contentVersionsOf(docId)
      .slice()
      .sort((a, b) => b.version_no - a.version_no)
      .map((v) => ({
        version_no: v.version_no,
        change_source: v.change_source,
        actor_id: v.actor_id,
        note: v.note,
        created_at: v.created_at,
        custom_keys: v.custom_keys,
      }));
    return HttpResponse.json({ doc_id: docId, total: items.length, items });
  }),

  http.get(
    "/api/v1/trade-docs/:id/content-versions/:versionNo",
    ({ params }) => {
      const version = contentVersionsOf(Number(params.id)).find(
        (v) => v.version_no === Number(params.versionNo),
      );
      if (!version) {
        return HttpResponse.json(
          { detail: { error: "not_found", code: "VERSION_NOT_FOUND" } },
          { status: 404 },
        );
      }
      return HttpResponse.json(version);
    },
  ),

  http.post(
    "/api/v1/trade-docs/:id/content-versions/:versionNo/restore",
    async ({ params, request }) => {
      const docId = Number(params.id);
      const versionNo = Number(params.versionNo);
      const versions = contentVersionsOf(docId);
      const target = versions.find((v) => v.version_no === versionNo);
      if (!target) {
        return HttpResponse.json(
          { detail: { error: "not_found", code: "VERSION_NOT_FOUND" } },
          { status: 404 },
        );
      }
      const doc = docsStore.find((d) => d.id === docId);
      // 与后端 409 同口径：issued/void 冻结；报价单由报价同步、不收恢复
      if (doc && doc.status !== "draft") {
        return HttpResponse.json(
          {
            detail: {
              error: "conflict",
              code: "NOT_DRAFT",
              detail: "已签发/作废单证内容冻结，不能恢复历史版本",
            },
          },
          { status: 409 },
        );
      }
      if (doc && doc.doc_type === "quotation") {
        return HttpResponse.json(
          {
            detail: {
              error: "conflict",
              code: "QUOTATION_DOC_SYNCED",
              detail: "报价单由报价自动同步生成，恢复内容会被下次报价更新覆盖",
            },
          },
          { status: 409 },
        );
      }
      const body = (await request.json().catch(() => ({}))) as {
        note?: string;
      };
      const nextNo = Math.max(...versions.map((v) => v.version_no), 0) + 1;
      const created: MockContentVersion = {
        version_no: nextNo,
        change_source: "restore",
        actor_id: "1",
        note: body.note || `恢复至 v${versionNo}`,
        created_at: nowIso(),
        custom_keys: Object.keys(
          (target.raw_payload.custom ?? {}) as Record<string, unknown>,
        ),
        raw_payload: target.raw_payload,
      };
      versions.push(created);
      if (doc) doc.raw_payload = target.raw_payload;
      return HttpResponse.json({
        doc: doc ?? { id: docId, raw_payload: target.raw_payload },
        restored_version_no: versionNo,
      });
    },
  ),

  // ── 枚举（/enums · 与后端 app/domain/enums.py 同键同值）──────────────────
  http.get("/api/v1/enums", () => {
    return HttpResponse.json(ENUMS_MOCK);
  }),

  // ── 平台账号治理（admin/accounts · 契约见 docs/archive/2026-10-20-closeout/ACCOUNT_GOVERNANCE_HANDOVER_2026-10-12.md §②）──  // 写操作必须**真的**改 store：停用/恢复后列表与详情要跟着变，否则 e2e 断言失效。
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

  // 成本历史（报价工位「成本历史」tab）：mock 给一张完整矩阵，
  // 否则该 tab 会一直停在“加载中…”。形状对齐 contracts/export-quote PricingMatrix。
  http.get("/api/v1/pricing-data", ({ request }) => {
    const url = new URL(request.url);
    const productKey = url.searchParams.get("product_key") ?? "";
    const product = MOCK_EXPORT_PRODUCTS.find((p) => p.key === productKey);
    const values = [2.5, 3.0, 3.5];
    const amounts = [2.3, 2.5, 2.7];
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
      rows: values.map((value, i) => ({
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
      })),
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

  // ══════════════════════════════════════════════════════════════════════════
  // P1 组 handler（对齐修复 B · 2026-10-20）
  //
  // 覆盖审计报告 §2-3 点名的缺口：customers 联系人与询盘、products/profile/media、
  // file-objects、tenant-products、trade-docs 对账/文件、teams 成员/邀请/订阅、
  // tax-archives、company-profile/seals。形状全部照 worker 序列化函数（逐处标了行号），
  // 写操作真的改 store（"保存成功但界面没变"正是这层要防的假成功）。
  // ══════════════════════════════════════════════════════════════════════════

  // ── 客户 · 询盘列表 / 询盘更新 ──────────────────────────────────────────
  // GET  ← quotes/views/batch-quote-view.tsx:95、quote-workbench-view.tsx:121
  // 形状 = `{items,total}`（ws_crm_ext.py:248-257），每行比 `row_to_inquiry`
  // 多一个 `inquiry_no_editable`（worker 有意差异：已生成报价单后编号锁定）。
  http.get("/api/v1/customers/:id/inquiries", ({ params, request }) => {
    const customer = customersStore.find((c) => c.id === Number(params.id));
    if (!customer) return customerNotFound(params.id);
    const status = new URL(request.url).searchParams.get("status");
    if (status && !INQUIRY_STATUSES.includes(status)) {
      return HttpResponse.json(
        {
          detail: {
            error: "validation",
            code: "INVALID_ENUM",
            detail: `invalid_enum_value: inquiry_status=${status}`,
          },
        },
        { status: 422 },
      );
    }
    let items = inquiriesOf(customer.id)
      .slice()
      .sort(
        (a, b) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      );
    if (status) items = items.filter((i) => i.status === status);
    return HttpResponse.json({
      items: items.map((i) => ({
        ...i,
        inquiry_no_editable: !inquiryHasQuote(i.id),
      })),
      total: items.length,
    });
  }),

  // PATCH ← customers/page.tsx:899（改编号）/ :917（关闭/重开）
  // 状态机 + 编号锁定口径 = ws_crm_ext.py:302-411（真源 `_INQUIRY_NEXT`）。
  http.patch("/api/v1/inquiries/:id", async ({ params, request }) => {
    const id = Number(params.id);
    const found = findInquiry(id);
    if (!found) {
      return HttpResponse.json(
        { detail: { error: "not_found", code: "INQUIRY_NOT_FOUND" } },
        { status: 404 },
      );
    }
    const { inquiry, list } = found;
    const body = (await request.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const hasQuote = inquiryHasQuote(id);
    const patch: Record<string, unknown> = {};

    if ("inquiry_no" in body) {
      const raw = String(body.inquiry_no ?? "").trim();
      if (!raw) {
        return HttpResponse.json(
          {
            detail: {
              error: "validation",
              code: "INVALID_INQUIRY_NO",
              detail: "询盘编号不能为空",
            },
          },
          { status: 422 },
        );
      }
      if (hasQuote) {
        return HttpResponse.json(
          {
            detail: {
              error: "conflict",
              code: "INQUIRY_NO_LOCKED",
              detail: "该询盘已生成报价单，编号已锁定；如需改号请先处理关联报价",
            },
          },
          { status: 409 },
        );
      }
      if (list.some((i) => i.id !== id && i.inquiry_no === raw)) {
        return HttpResponse.json(
          {
            detail: {
              error: "conflict",
              code: "INQUIRY_NO_TAKEN",
              detail: `询盘编号「${raw}」已被占用，请换一个`,
            },
          },
          { status: 409 },
        );
      }
      patch.inquiry_no = raw;
    }

    if ("status" in body) {
      const requested = String(body.status ?? "");
      if (!INQUIRY_STATUSES.includes(requested)) {
        return HttpResponse.json(
          {
            detail: {
              error: "validation",
              code: "INVALID_ENUM",
              detail: `invalid_enum_value: inquiry_status=${requested}`,
            },
          },
          { status: 422 },
        );
      }
      // 已有报价 ⇒ 重开时回到「已报价」（ws_crm_ext.py:366-372）
      const target = requested === "unquoted" && hasQuote ? "quoted" : requested;
      const allowed = INQUIRY_NEXT[inquiry.status] ?? [];
      if (target !== inquiry.status && !allowed.includes(target)) {
        return HttpResponse.json(
          {
            detail: {
              error: "conflict",
              code: "ILLEGAL_TRANSITION",
              detail: `询盘状态不允许从 ${inquiry.status} 流转到 ${target}`,
            },
          },
          { status: 409 },
        );
      }
      if (target !== inquiry.status) {
        patch.status = target;
        if (target === "closed") {
          // 询盘阶段（TODO F4）：手动关闭 → closed（终态），并留一条阶段流水
          inquiryStageLogsOf(id).push({
            from_stage:
              typeof inquiry.stage === "string" ? inquiry.stage : "inquiry",
            to_stage: "closed",
            source_event: "inquiry_closed",
            actor_id: String(MOCK_ADMIN_USER.user_id),
            note: null,
            created_at: nowIso(),
          });
          patch.stage = "closed";
          patch.stage_updated_at = nowIso();
        }
      }
    }

    // 其余可编辑列（ws_crm_ext.py:_INQUIRY_COLUMNS 的子集；notes 不在序列化里）
    for (const key of [
      "channel",
      "product_name_raw",
      "quantity",
      "quantity_unit",
      "application",
    ] as const) {
      if (key in body) patch[key] = body[key];
    }
    Object.assign(inquiry, patch);
    return HttpResponse.json(inquiry);
  }),

  // GET ← customers/components/inquiry-followups.tsx（F4 展开区「阶段历史」）
  // 形状 = `ws_crm_ext.py:414-451`：`{items:[{from_stage,to_stage,source_event,
  // actor_id,note,created_at}]}`；空列表是合法响应（历史行没有阶段记录）。
  http.get("/api/v1/inquiries/:id/stage-log", ({ params }) => {
    const id = Number(params.id);
    if (!findInquiry(id)) {
      return HttpResponse.json(
        { detail: { error: "not_found", code: "INQUIRY_NOT_FOUND" } },
        { status: 404 },
      );
    }
    return HttpResponse.json({ items: inquiryStageLogsOf(id) });
  }),

  // ── 客户 · 联系人更新 / 删除 ────────────────────────────────────────────
  // PATCH ← customers/page.tsx:554（ContactForm 编辑）
  // 响应是 7 键投影（main.py:1487-1516 的 `_contact_api`），不是整行。
  http.patch(
    "/api/v1/customers/:id/contacts/:contactId",
    async ({ params, request }) => {
      const customer = customersStore.find((c) => c.id === Number(params.id));
      if (!customer) return customerNotFound(params.id);
      const contact = contactsOf(customer.id).find(
        (c) => c.id === Number(params.contactId),
      );
      if (!contact) {
        return HttpResponse.json(
          { detail: { error: "not_found", code: "CONTACT_NOT_FOUND" } },
          { status: 404 },
        );
      }
      const body = (await request.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      if ("name" in body) {
        const name = String(body.name ?? "").trim();
        if (!name) {
          return HttpResponse.json(
            {
              error_code: "VALIDATION_ERROR",
              message: "联系人姓名必填",
              detail: "validation_error: name is required",
            },
            { status: 422 },
          );
        }
        contact.name = name;
      }
      for (const key of ["position", "phone", "email", "whatsapp"] as const) {
        if (key in body) contact[key] = optStr(body[key]);
      }
      if (typeof body.is_primary === "boolean") {
        if (body.is_primary) {
          for (const other of contactsOf(customer.id)) {
            other.is_primary = other.id === contact.id;
          }
        } else {
          contact.is_primary = false;
        }
      }
      return HttpResponse.json({
        id: contact.id,
        name: contact.name,
        position: contact.position,
        phone: contact.phone,
        email: contact.email,
        whatsapp: contact.whatsapp,
        is_primary: contact.is_primary,
      });
    },
  ),

  // DELETE ← customers/page.tsx:928（handleDeleteContact）。204；不存在 404。
  http.delete(
    "/api/v1/customers/:id/contacts/:contactId",
    ({ params }) => {
      const customer = customersStore.find((c) => c.id === Number(params.id));
      if (!customer) return customerNotFound(params.id);
      const list = contactsOf(customer.id);
      const index = list.findIndex(
        (c) => c.id === Number(params.contactId),
      );
      if (index < 0) {
        return HttpResponse.json(
          { detail: { error: "not_found", code: "CONTACT_NOT_FOUND" } },
          { status: 404 },
        );
      }
      list.splice(index, 1);
      return new HttpResponse(null, { status: 204 });
    },
  ),

  // ── 产品（注册表产品 + 租户可编辑的基础信息/图片）────────────────────────
  // GET ← lib/products/use-products.ts:61；形状 = ws_files.py:394-405
  http.get("/api/v1/products", () => {
    return HttpResponse.json({
      items: MOCK_EXPORT_PRODUCTS.map((p) => ({
        product_key: p.key,
        name: p.name || p.key,
        name_en: p.name_en,
        category_code: p.category_code,
        media_count: fileObjectsStore.filter(
          (f) =>
            f.owner_type === "product" &&
            f.owner_id === p.key &&
            f.kind === "product_photo" &&
            f.is_current,
        ).length,
        profile: productProfilesStore.get(p.key) ?? {},
      })),
      media_kinds: MEDIA_KIND_LABELS,
    });
  }),

  // GET / PUT profile ← use-products.ts:74 / :86；形状 = ws_files.py:432-434
  http.get("/api/v1/products/:productKey/profile", ({ params }) => {
    const productKey = String(params.productKey);
    return HttpResponse.json({
      product_key: productKey,
      info: productProfilesStore.get(productKey) ?? {},
      updated_at: null,
    });
  }),

  http.put("/api/v1/products/:productKey/profile", async ({ params, request }) => {
    const productKey = String(params.productKey);
    const body = (await request.json().catch(() => ({}))) as {
      info?: unknown;
    };
    const info = body.info;
    if (typeof info !== "object" || info === null || Array.isArray(info)) {
      return HttpResponse.json(
        {
          detail: {
            error: "validation",
            code: "INVALID_PROFILE",
            detail: "info 必须是对象",
          },
        },
        { status: 422 },
      );
    }
    productProfilesStore.set(productKey, info as Record<string, unknown>);
    return HttpResponse.json({
      product_key: productKey,
      info: productProfilesStore.get(productKey),
      updated_at: nowIso(),
    });
  }),

  // GET / POST media ← use-products.ts:100 / :147（服务端代理上传）
  // 形状 = ws_files.py:458-481（`{items,_media_kinds}` / 201 + `_row_to_file`）
  http.get("/api/v1/products/:productKey/media", ({ params }) => {
    const productKey = String(params.productKey);
    const items = fileObjectsStore
      .filter(
        (f) =>
          f.owner_type === "product" &&
          f.owner_id === productKey &&
          f.kind === "product_photo" &&
          f.is_current,
      )
      .sort(
        (a, b) =>
          Number(b.is_primary) - Number(a.is_primary) ||
          a.sort_order - b.sort_order ||
          a.id - b.id,
      )
      .map((f) => fileOut(f));
    return HttpResponse.json({ items, media_kinds: MEDIA_KIND_LABELS });
  }),

  http.post(
    "/api/v1/products/:productKey/media",
    async ({ params, request }) => {
      const productKey = String(params.productKey);
      const form = await request.formData();
      const fileEntry = form.get("file");
      if (!isBlobLike(fileEntry)) {
        return HttpResponse.json(
          {
            detail: {
              error: "validation",
              code: "FILE_REQUIRED",
              detail: "缺少上传文件",
            },
          },
          { status: 422 },
        );
      }
      const nameRaw = form.get("name");
      const name =
        (typeof nameRaw === "string" ? nameRaw.trim() : "") ||
        fileEntry.name ||
        "产品图";
      const mediaKindRaw = form.get("media_kind");
      const mediaKind =
        typeof mediaKindRaw === "string" && mediaKindRaw
          ? mediaKindRaw
          : "other";
      const bytes = new Uint8Array(await fileEntry.arrayBuffer());
      const created = createMockFile({
        owner_type: "product",
        owner_id: productKey,
        kind: "product_photo",
        media_kind: mediaKind,
        name,
        content_type: fileEntry.type || "application/octet-stream",
        file_name: fileEntry.name || null,
        file_size: bytes.byteLength,
        bytes,
      });
      return HttpResponse.json(fileOut(created), { status: 201 });
    },
  ),

  // ── 文件对象（file_objects）────────────────────────────────────────────
  // presign ← use-products.ts:208；未配对象存储时后端如实回 `{configured:false}`
  // （ws_files.py:892-905）⇒ 前端跳过直传、走服务端代理（功能不缺失）。
  http.post("/api/v1/file-objects/presign", async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as {
      sha256?: string;
    };
    const sha = String(body.sha256 ?? "").trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(sha)) {
      return HttpResponse.json(
        {
          detail: {
            error: "validation",
            code: "SHA256_REQUIRED",
            detail: "直传必须先算好文件的 sha256（64 位十六进制）",
          },
        },
        { status: 422 },
      );
    }
    return HttpResponse.json({ configured: false });
  }),

  // register ← use-products.ts:239（仅直传成功后调用；mock 里 presign 已 configured=false）
  http.post("/api/v1/file-objects/register", async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const sha = String(body.sha256 ?? "").trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(sha)) {
      return HttpResponse.json(
        {
          detail: {
            error: "validation",
            code: "SHA256_REQUIRED",
            detail: "直传必须先算好文件的 sha256（64 位十六进制）",
          },
        },
        { status: 422 },
      );
    }
    const created = createMockFile({
      owner_type: String(body.owner_type ?? "other"),
      owner_id: optStr(body.owner_id),
      kind: String(body.kind ?? "other"),
      media_kind: optStr(body.media_kind),
      name: String(body.name ?? "文件"),
      content_type: optStr(body.content_type),
      file_name: optStr(body.file_name),
      file_size: typeof body.size === "number" ? body.size : null,
      sha256: sha,
      supersede: body.supersede === true,
    });
    return HttpResponse.json(fileOut(created), { status: 201 });
  }),

  // content ← use-products.ts:328（blob→objectURL）；返回真实字节（mock 返回上传时的字节）
  http.get("/api/v1/file-objects/:fileId/content", ({ params }) => {
    const file = fileObjectsStore.find(
      (f) => f.id === Number(params.fileId),
    );
    if (!file) {
      return HttpResponse.json(
        { detail: { error: "not_found", code: "FILE_NOT_FOUND" } },
        { status: 404 },
      );
    }
    const stored = fileObjectBytes.get(file.id);
    return new HttpResponse(stored?.bytes ?? MOCK_PNG_BYTES, {
      status: 200,
      headers: {
        "Content-Type":
          stored?.contentType ?? file.content_type ?? "application/octet-stream",
        "Cache-Control": "private, max-age=3600",
      },
    });
  }),

  // url ← use-products.ts:269；mock 没有对象存储 ⇒ `{configured:false}`（ws_files.py:992-1008）
  http.get("/api/v1/file-objects/:fileId/url", ({ params }) => {
    const file = fileObjectsStore.find(
      (f) => f.id === Number(params.fileId),
    );
    if (!file) {
      return HttpResponse.json(
        { detail: { error: "not_found", code: "FILE_NOT_FOUND" } },
        { status: 404 },
      );
    }
    return HttpResponse.json({
      configured: false,
      reason: "mock 未配置对象存储（字节走 /content）",
    });
  }),

  // GET /file-objects ← 后端 ws_files.py:571-585。**前端当前 0 调用**
  // （审计报告里它是"后端有、前端从不调用"的死路由）；仍补上是为了形状齐全，
  // 避免以后接线时又是一处"mock 放行到网络"。故会出现在门禁的 unused 信息项里。
  http.get("/api/v1/file-objects", ({ request }) => {
    const url = new URL(request.url);
    const ownerType = url.searchParams.get("owner_type") ?? "";
    const ownerId = url.searchParams.get("owner_id");
    const kind = url.searchParams.get("kind");
    const items = fileObjectsStore.filter(
      (f) =>
        f.owner_type === ownerType &&
        f.is_current &&
        (ownerId === null ? (f.owner_id ?? "") === "" : f.owner_id === ownerId) &&
        (kind ? f.kind === kind : true),
    );
    return HttpResponse.json({ items: items.map((f) => fileOut(f)) });
  }),

  // PATCH ← use-products.ts:285 / :304（改名 / 主图 / 排序）；响应 `{ok:true}`（ws_files.py:539）
  http.patch("/api/v1/file-objects/:fileId", async ({ params, request }) => {
    const file = fileObjectsStore.find(
      (f) => f.id === Number(params.fileId),
    );
    if (!file) {
      return HttpResponse.json(
        { detail: { error: "not_found", code: "FILE_NOT_FOUND" } },
        { status: 404 },
      );
    }
    const body = (await request.json().catch(() => ({}))) as {
      name?: string;
      is_primary?: boolean;
      caption?: string | null;
      sort_order?: number;
    };
    if (typeof body.name === "string") {
      const label = body.name.trim();
      if (!label) {
        return HttpResponse.json(
          {
            detail: {
              error: "validation",
              code: "NAME_REQUIRED",
              detail: "名称不能为空",
            },
          },
          { status: 422 },
        );
      }
      if (label.length > 80) {
        return HttpResponse.json(
          {
            detail: {
              error: "validation",
              code: "NAME_TOO_LONG",
              detail: "名称最长 80 个字符",
            },
          },
          { status: 422 },
        );
      }
      file.name = label;
    }
    if (typeof body.is_primary === "boolean") {
      if (body.is_primary) {
        for (const other of fileObjectsStore) {
          if (
            other.owner_type === file.owner_type &&
            other.owner_id === file.owner_id &&
            other.kind === file.kind
          ) {
            other.is_primary = false;
          }
        }
      }
      file.is_primary = body.is_primary;
    }
    if (typeof body.sort_order === "number") {
      if (body.sort_order < 0 || body.sort_order > 9999) {
        return HttpResponse.json(
          {
            detail: {
              error: "validation",
              code: "SORT_ORDER_OUT_OF_RANGE",
              detail: "排序值需在 0 ~ 9999 之间",
            },
          },
          { status: 422 },
        );
      }
      file.sort_order = body.sort_order;
    }
    return HttpResponse.json({ ok: true });
  }),

  // DELETE ← use-products.ts:315（退役，不物理删：is_current=false）；ws_files.py:542-552
  http.delete("/api/v1/file-objects/:fileId", ({ params }) => {
    const file = fileObjectsStore.find(
      (f) => f.id === Number(params.fileId),
    );
    if (!file) {
      return HttpResponse.json(
        { detail: { error: "not_found", code: "FILE_NOT_FOUND" } },
        { status: 404 },
      );
    }
    file.is_current = false;
    file.is_primary = false;
    return new HttpResponse(null, { status: 204 });
  }),

  // ── 租户产品定义（product 工位：自定义产品 / 系统产品停用）──────────────
  // 列表**不包封**：后端直接回数组（ws_products.py:208），FE 类型也是 `TenantProduct[]`。
  http.get("/api/v1/tenant-products", () => {
    return HttpResponse.json(tenantProductsStore.map(tenantProductOut));
  }),

  http.post("/api/v1/tenant-products", async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const productKey = String(body.product_key ?? "").trim();
    const productName = String(body.product_name ?? "").trim();
    if (!productKey || !productName) {
      return HttpResponse.json(
        {
          detail: {
            error: "validation",
            code: "PRODUCT_REQUIRED",
            detail: "product_key / product_name 必填",
          },
        },
        { status: 422 },
      );
    }
    if (tenantProductsStore.some((p) => p.product_key === productKey)) {
      return HttpResponse.json(
        {
          detail: {
            error: "conflict",
            code: "PRODUCT_KEY_TAKEN",
            detail: `本租户已存在产品标识「${productKey}」`,
          },
        },
        { status: 409 },
      );
    }
    const spec =
      typeof body.spec === "object" && body.spec !== null
        ? (body.spec as Record<string, unknown>)
        : {};
    const created: MockTenantProduct = {
      id: tenantProductSeq++,
      product_key: productKey,
      product_name: productName,
      product_name_en: optStr(body.product_name_en),
      category_code: optStr(body.category_code),
      cost_field: String(body.cost_field ?? "raw_price"),
      cost_basis: String(body.cost_basis ?? "pretax"),
      cost_unit: optStr(body.cost_unit),
      profit_mode: String(body.profit_mode ?? "margin_on_price"),
      profit_value: Number(body.profit_value ?? 0.06),
      misc_fee_rate: Number(body.misc_fee_rate ?? 0.03),
      spec,
      is_system: false,
      is_active: body.is_active !== false,
      created_at: nowIso(),
    };
    tenantProductsStore.push(created);
    return HttpResponse.json(tenantProductOut(created), { status: 201 });
  }),

  http.put("/api/v1/tenant-products/:id", async ({ params, request }) => {
    const product = tenantProductsStore.find(
      (p) => p.id === Number(params.id),
    );
    if (!product) {
      return HttpResponse.json(
        { detail: { error: "not_found", code: "PRODUCT_NOT_FOUND" } },
        { status: 404 },
      );
    }
    if (product.is_system) {
      return HttpResponse.json(
        {
          detail: {
            error: "forbidden",
            message: "系统级产品仅平台管理员可编辑",
          },
        },
        { status: 403 },
      );
    }
    const body = (await request.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    // 白名单照 `ws_products.py:_UPDATABLE_COLUMNS`（只改请求里显式出现的字段）
    for (const key of [
      "product_key",
      "product_name",
      "product_name_en",
      "category_code",
      "cost_field",
      "cost_basis",
      "cost_unit",
      "profit_mode",
      "misc_fee_rate",
      "is_active",
    ] as const) {
      if (!(key in body)) continue;
      const value = body[key];
      if (key === "is_active") product.is_active = value === true;
      else if (key === "misc_fee_rate") product.misc_fee_rate = Number(value);
      else (product as unknown as Record<string, unknown>)[key] =
        typeof value === "string" ? value : null;
    }
    if ("profit_value" in body)
      product.profit_value = Number(body.profit_value);
    if (
      "spec" in body &&
      typeof body.spec === "object" &&
      body.spec !== null
    ) {
      product.spec = body.spec as Record<string, unknown>;
    }
    return HttpResponse.json(tenantProductOut(product));
  }),

  http.delete("/api/v1/tenant-products/:id", ({ params }) => {
    const index = tenantProductsStore.findIndex(
      (p) => p.id === Number(params.id),
    );
    const product = index >= 0 ? tenantProductsStore[index] : undefined;
    if (!product) {
      return HttpResponse.json(
        { detail: { error: "not_found", code: "PRODUCT_NOT_FOUND" } },
        { status: 404 },
      );
    }
    if (product.is_system) {
      return HttpResponse.json(
        { detail: { error: "forbidden", message: "系统级产品不可删除" } },
        { status: 403 },
      );
    }
    // 与后端一致：删产品时一并清理基础信息 / 图片 / 工位绑定（ws_products.py:330-342）
    for (const file of fileObjectsStore) {
      if (file.owner_type === "product" && file.owner_id === product.product_key) {
        file.is_current = false;
        file.is_primary = false;
      }
    }
    productProfilesStore.delete(product.product_key);
    tenantProductStatusStore.delete(product.product_key);
    tenantProductsStore.splice(index, 1);
    return new HttpResponse(null, { status: 204 });
  }),

  // GET / POST tenant-product-status ← products-definitions-tab.tsx:276 / :287
  // 形状 = ws_products.py:454-455 / :486-488
  http.get("/api/v1/tenant-product-status", () => {
    return HttpResponse.json({
      items: [...tenantProductStatusStore.entries()].map(
        ([product_key, is_enabled]) => ({ product_key, is_enabled }),
      ),
    });
  }),

  http.post("/api/v1/tenant-product-status", async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as {
      product_key?: string;
      is_enabled?: boolean;
    };
    const productKey = String(body.product_key ?? "").trim();
    const tenantProduct = tenantProductsStore.find(
      (p) => p.product_key === productKey,
    );
    const registry = registryProduct(productKey);
    if (!tenantProduct && !registry) {
      return HttpResponse.json(
        { detail: { error: "not_found", code: "PRODUCT_NOT_FOUND" } },
        { status: 404 },
      );
    }
    const enabled = body.is_enabled !== false;
    tenantProductStatusStore.set(productKey, enabled);
    return HttpResponse.json({
      product_key: productKey,
      is_system: tenantProduct ? tenantProduct.is_system : true,
      is_enabled: enabled,
    });
  }),

  // ── 团队（成员 / 邀请 / 工位订阅）─────────────────────────────────────────
  // 形状 = ws_teams.py 的 `_team_out` / `_invite_out`、ws_workstations.py 的 `_sub_out`。
  // ⚠️ 静态抽取看不到这些路径：`use-team-admin.ts:160` 的 path 是**变量**
  //   （`/teams/${teamId}/members` 等 3 条），所以防漂移门禁把 3 条硬编码进 P1 表。
  http.get("/api/v1/teams/:id/members", ({ params }) => {
    if (Number(params.id) !== teamStore.id) return teamNotFound();
    const items = teamMembersStore.map((m) => ({
      user_id: m.user_id,
      email: m.email,
      display_name: m.display_name,
      role: m.role,
      // 注意：后端 list_members 刻意**不**回 console_access（ws_teams.py:281-288），
      // mock 也不加 —— 前端 normalizeMembers 把它缺省成 false，与生产一致。
      is_admin: isTeamAdmin(m.user_id, m.role),
    }));
    return HttpResponse.json({ items, total: items.length });
  }),

  http.put(
    "/api/v1/teams/:id/members/:userId/console-access",
    async ({ params, request }) => {
      if (Number(params.id) !== teamStore.id) return teamNotFound();
      const member = teamMembersStore.find(
        (m) => m.user_id === Number(params.userId),
      );
      if (!member) {
        return HttpResponse.json(
          { detail: { error: "not_found", code: "MEMBER_NOT_FOUND" } },
          { status: 404 },
        );
      }
      const body = (await request.json().catch(() => ({}))) as {
        allowed?: boolean;
      };
      member.console_access = body.allowed === true;
      return HttpResponse.json({
        user_id: member.user_id,
        console_access: member.console_access,
      });
    },
  ),

  http.delete("/api/v1/teams/:id/members/:userId", ({ params }) => {
    if (Number(params.id) !== teamStore.id) return teamNotFound();
    const userId = Number(params.userId);
    if (userId === teamStore.created_by) {
      return HttpResponse.json(
        {
          detail: {
            error: "conflict",
            code: "CANNOT_REMOVE_SELF",
            message: "不能移除团队管理员本人",
          },
        },
        { status: 409 },
      );
    }
    const index = teamMembersStore.findIndex((m) => m.user_id === userId);
    if (index < 0) {
      return HttpResponse.json(
        { detail: { error: "not_found", code: "MEMBER_NOT_FOUND" } },
        { status: 404 },
      );
    }
    teamMembersStore.splice(index, 1);
    return HttpResponse.json({ removed: true, user_id: userId });
  }),

  http.post("/api/v1/teams/:id/transfer", async ({ params, request }) => {
    if (Number(params.id) !== teamStore.id) return teamNotFound();
    const body = (await request.json().catch(() => ({}))) as {
      user_id?: number;
    };
    const target = Number(body.user_id);
    if (!Number.isFinite(target)) {
      return HttpResponse.json(
        {
          detail: {
            error: "validation",
            code: "TRANSFER_TARGET_REQUIRED",
            detail: "缺少转让目标",
          },
        },
        { status: 422 },
      );
    }
    if (target === teamStore.created_by) {
      return HttpResponse.json(
        {
          detail: {
            error: "validation",
            code: "TRANSFER_TO_SELF",
            detail: "不能把团队转让给自己",
          },
        },
        { status: 422 },
      );
    }
    if (!teamMembersStore.some((m) => m.user_id === target)) {
      return HttpResponse.json(
        {
          detail: {
            error: "validation",
            code: "TRANSFER_TARGET_NOT_MEMBER",
            detail: "转让目标必须是本团队成员",
          },
        },
        { status: 422 },
      );
    }
    teamStore.created_by = target;
    return HttpResponse.json(teamOut());
  }),

  // POST /teams ← team/components/team-setup.tsx:60。mock 登录身份已属于团队 1，
  // 后端同样 409 ALREADY_IN_TEAM（ws_teams.py:166-167）—— 如实用该分支，不假装能建。
  http.post("/api/v1/teams", () => {
    return HttpResponse.json(
      {
        detail: {
          error: "conflict",
          code: "ALREADY_IN_TEAM",
          message: "你已属于一个团队，不能再创建团队",
        },
      },
      { status: 409 },
    );
  }),

  http.get("/api/v1/teams/:id/invites", ({ params }) => {
    if (Number(params.id) !== teamStore.id) return teamNotFound();
    const items = teamInvitesStore.map(inviteOut);
    return HttpResponse.json({ items, total: items.length });
  }),

  http.post("/api/v1/teams/:id/invites", async ({ params, request }) => {
    if (Number(params.id) !== teamStore.id) return teamNotFound();
    const body = (await request.json().catch(() => ({}))) as {
      email?: string | null;
    };
    const email =
      typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    // 邮箱点名且对方已在团队里 ⇒ 后端 409（ws_teams.py:340-346）
    if (email && teamMembersStore.some((m) => m.email.toLowerCase() === email)) {
      return HttpResponse.json(
        {
          detail: {
            error: "conflict",
            code: "ALREADY_IN_TEAM",
            message: `${email} 已属于一个团队`,
          },
        },
        { status: 409 },
      );
    }
    const invite: MockTeamInvite = {
      id: teamInviteSeq++,
      email: email || null,
      token: `invite-mock-token-${String(teamInviteSeq).padStart(4, "0")}`,
      status: "pending",
      created_at: nowIso(),
      expires_at: new Date(Date.now() + 7 * 86400000).toISOString(),
      accepted_at: null,
      accepted_by: null,
    };
    teamInvitesStore.push(invite);
    // 发码 = 201（未创建/直入资源才 200），见 ws_teams.py:330-356
    return HttpResponse.json(
      {
        joined: false,
        invite_id: invite.id,
        token: invite.token,
        email: invite.email,
      },
      { status: 201 },
    );
  }),

  http.delete("/api/v1/teams/:id/invites/:inviteId", ({ params }) => {
    if (Number(params.id) !== teamStore.id) return teamNotFound();
    const invite = teamInvitesStore.find(
      (i) => i.id === Number(params.inviteId),
    );
    if (!invite) {
      return HttpResponse.json(
        { detail: { error: "not_found", code: "INVITE_NOT_FOUND" } },
        { status: 404 },
      );
    }
    invite.status = "revoked";
    return HttpResponse.json({ revoked: true, id: invite.id });
  }),

  // POST /teams/join ← team-setup.tsx:83。mock 身份已在团队里 ⇒ 后端同样 409。
  http.post("/api/v1/teams/join", () => {
    return HttpResponse.json(
      {
        detail: {
          error: "conflict",
          code: "ALREADY_IN_TEAM",
          message: "你已属于一个团队",
        },
      },
      { status: 409 },
    );
  }),

  http.get("/api/v1/teams/:id/subscriptions", ({ params }) => {
    if (Number(params.id) !== teamStore.id) return teamNotFound();
    const items = teamSubscriptionStore.map(subOut);
    return HttpResponse.json({ items, total: items.length });
  }),

  http.put(
    "/api/v1/teams/:id/subscriptions/:code",
    async ({ params, request }) => {
      if (Number(params.id) !== teamStore.id) return teamNotFound();
      const code = String(params.code);
      const known = [...SUBSCRIBABLE_WORKSTATIONS, FULL_CHAIN_CODE];
      if (!known.includes(code)) {
        return HttpResponse.json(
          {
            detail: {
              error: "validation",
              code: "UNKNOWN_WORKSTATION",
              detail: `未知工位编码：${code}`,
            },
          },
          { status: 422 },
        );
      }
      const body = (await request.json().catch(() => ({}))) as {
        active?: boolean;
        expires_at?: string | null;
      };
      let row = teamSubscriptionStore.find((s) => s.code === code);
      if (!row) {
        row = {
          code,
          active: true,
          expires_at: null,
          source: "manual",
          created_at: nowIso(),
        };
        teamSubscriptionStore.push(row);
      }
      row.active = body.active !== false;
      row.expires_at = optStr(body.expires_at);
      row.source = "manual";
      return HttpResponse.json(subSetOut(row));
    },
  ),

  http.delete("/api/v1/teams/:id/subscriptions/:code", ({ params }) => {
    if (Number(params.id) !== teamStore.id) return teamNotFound();
    const code = String(params.code);
    const row = teamSubscriptionStore.find((s) => s.code === code);
    if (!row) {
      return HttpResponse.json(
        { detail: { error: "not_found", code: "SUBSCRIPTION_NOT_FOUND" } },
        { status: 404 },
      );
    }
    row.active = false;
    return HttpResponse.json({ revoked: true, code });
  }),

  // ── 企业税档 / 产品税率（settings/tax-archives）─────────────────────────
  // 形状 = tax_archives.py:_row_out / _product_tax_out
  http.get("/api/v1/tax-archives", ({ request }) => {
    const includeInactive =
      new URL(request.url).searchParams.get("include_inactive") === "true";
    const items = taxArchivesStore
      .filter((a) => includeInactive || a.status === "active")
      .map(taxArchiveOut);
    return HttpResponse.json({ items, total: items.length });
  }),

  http.post("/api/v1/tax-archives", async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const name = String(body.name ?? "").trim();
    if (!name) {
      return HttpResponse.json(
        {
          detail: {
            error: "validation",
            code: "NAME_REQUIRED",
            detail: "档案名称不能为空",
          },
        },
        { status: 422 },
      );
    }
    const values = parseTaxValues(body.tax_values);
    if (typeof values === "string") return taxValuesError(values);
    const code =
      (typeof body.code === "string" ? body.code.trim() : "") ||
      `TAX-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${taxArchiveSeq}`;
    if (taxArchivesStore.some((a) => a.status === "active" && a.name === name)) {
      return HttpResponse.json(
        {
          detail: {
            error: "conflict",
            code: "NAME_TAKEN",
            detail: `税务档案名称「${name}」在本团队已存在`,
          },
        },
        { status: 409 },
      );
    }
    if (taxArchivesStore.some((a) => a.code === code)) {
      return HttpResponse.json(
        {
          detail: {
            error: "conflict",
            code: "CODE_TAKEN",
            detail: `税务档案编码「${code}」在本团队已存在`,
          },
        },
        { status: 409 },
      );
    }
    const at = nowIso();
    const row: MockTaxArchive = {
      id: taxArchiveSeq++,
      code,
      name,
      effective_from: optStr(body.effective_from),
      effective_to: optStr(body.effective_to),
      tax_values: values,
      source: optStr(body.source),
      status: "active",
      created_at: at,
      updated_at: at,
    };
    taxArchivesStore.push(row);
    return HttpResponse.json(taxArchiveOut(row), { status: 201 });
  }),

  http.patch("/api/v1/tax-archives/:id", async ({ params, request }) => {
    const row = taxArchivesStore.find((a) => a.id === Number(params.id));
    if (!row) {
      return HttpResponse.json(
        { detail: { error: "not_found", code: "TAX_ARCHIVE_NOT_FOUND" } },
        { status: 404 },
      );
    }
    const body = (await request.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    if ("name" in body) {
      const name = String(body.name ?? "").trim();
      if (!name) {
        return HttpResponse.json(
          {
            detail: {
              error: "validation",
              code: "NAME_REQUIRED",
              detail: "档案名称不能为空",
            },
          },
          { status: 422 },
        );
      }
      row.name = name;
    }
    if ("code" in body) row.code = optStr(body.code);
    if ("effective_from" in body)
      row.effective_from = optStr(body.effective_from);
    if ("effective_to" in body) row.effective_to = optStr(body.effective_to);
    if ("source" in body) row.source = optStr(body.source);
    if ("tax_values" in body && body.tax_values != null) {
      const values = parseTaxValues(body.tax_values);
      if (typeof values === "string") return taxValuesError(values);
      row.tax_values = values;
    }
    if ("status" in body) {
      const status = String(body.status ?? "");
      if (status !== "active" && status !== "inactive") {
        return HttpResponse.json(
          {
            detail: {
              error: "validation",
              code: "INVALID_STATUS",
              detail: "status 只能是 active / inactive",
            },
          },
          { status: 422 },
        );
      }
      row.status = status;
    }
    row.updated_at = nowIso();
    return HttpResponse.json(taxArchiveOut(row));
  }),

  http.get("/api/v1/product-tax-rates", () => {
    const items = productTaxRatesStore
      .filter((r) => r.status === "active")
      .map(productTaxOut);
    return HttpResponse.json({ items, total: items.length });
  }),

  http.post("/api/v1/product-tax-rates", async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const productKey = String(body.product_key ?? "").trim();
    if (!registryProduct(productKey)) {
      return HttpResponse.json(
        {
          detail: {
            error: "validation",
            code: "UNKNOWN_PRODUCT",
            detail: `产品 ${productKey} 不存在`,
          },
        },
        { status: 422 },
      );
    }
    const inputRate = parseTaxRate(body.input_vat_rate);
    const rebateRate = parseTaxRate(body.rebate_rate);
    if (typeof inputRate === "string") return taxValuesError(inputRate);
    if (typeof rebateRate === "string") return taxValuesError(rebateRate);
    if (inputRate === null && rebateRate === null) {
      return HttpResponse.json(
        {
          detail: {
            error: "validation",
            code: "TAX_VALUES_REQUIRED",
            detail: "进项增值税率、出口退税率至少填一个",
          },
        },
        { status: 422 },
      );
    }
    const existing = productTaxRatesStore.find(
      (r) => r.product_key === productKey,
    );
    if (existing && existing.status === "active") {
      return HttpResponse.json(
        {
          detail: {
            error: "conflict",
            code: "PRODUCT_TAX_EXISTS",
            detail: `产品 ${productKey} 已配置税率，请直接修改`,
          },
        },
        { status: 409 },
      );
    }
    const at = nowIso();
    if (existing) {
      existing.input_vat_rate = inputRate;
      existing.rebate_rate = rebateRate;
      existing.status = "active";
      existing.updated_at = at;
      return HttpResponse.json(productTaxOut(existing));
    }
    const row: MockProductTaxRate = {
      id: productTaxRateSeq++,
      product_key: productKey,
      input_vat_rate: inputRate,
      rebate_rate: rebateRate,
      status: "active",
      created_at: at,
      updated_at: at,
    };
    productTaxRatesStore.push(row);
    return HttpResponse.json(productTaxOut(row), { status: 201 });
  }),

  http.patch("/api/v1/product-tax-rates/:id", async ({ params, request }) => {
    const row = productTaxRatesStore.find(
      (r) => r.id === Number(params.id) && r.status === "active",
    );
    if (!row) {
      return HttpResponse.json(
        { detail: { error: "not_found", code: "PRODUCT_TAX_NOT_FOUND" } },
        { status: 404 },
      );
    }
    const body = (await request.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    if ("input_vat_rate" in body) {
      const rate = parseTaxRate(body.input_vat_rate);
      if (typeof rate === "string") return taxValuesError(rate);
      row.input_vat_rate = rate;
    }
    if ("rebate_rate" in body) {
      const rate = parseTaxRate(body.rebate_rate);
      if (typeof rate === "string") return taxValuesError(rate);
      row.rebate_rate = rate;
    }
    row.updated_at = nowIso();
    return HttpResponse.json(productTaxOut(row));
  }),

  http.delete("/api/v1/product-tax-rates/:id", ({ params }) => {
    const row = productTaxRatesStore.find(
      (r) => r.id === Number(params.id) && r.status === "active",
    );
    if (!row) {
      return HttpResponse.json(
        { detail: { error: "not_found", code: "PRODUCT_TAX_NOT_FOUND" } },
        { status: 404 },
      );
    }
    // 后端软删（status='inactive'，保留行便于审计）⇒ 响应 `{id,status}`（tax_archives.py:476-482）
    row.status = "inactive";
    row.updated_at = nowIso();
    return HttpResponse.json({ id: row.id, status: "inactive" });
  }),

  // ── 企业主体信息 / 公章（settings/company-profile）──────────────────────
  // GET ← trade-docs/hooks/use-trade-docs.ts:224；PUT ← :238
  // 形状 = main.py:4625-4635（14 字段 + configured；未配置时字段为 null，不 404）
  http.get("/api/v1/tenant/company-profile", () =>
    HttpResponse.json(companyProfileResponse()),
  ),

  http.put("/api/v1/tenant/company-profile", async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const nameEn = String(body.name_en ?? "").trim();
    if (!nameEn) {
      return HttpResponse.json(
        {
          detail: {
            error: "validation",
            code: "NAME_EN_REQUIRED",
            detail: "英文公司名必填（对外单据的卖方主体名）",
          },
        },
        { status: 422 },
      );
    }
    const swiftRaw =
      typeof body.swift_code === "string" ? body.swift_code.trim() : "";
    if (swiftRaw && !/^[A-Za-z0-9]{8}([A-Za-z0-9]{3})?$/.test(swiftRaw)) {
      return HttpResponse.json(
        {
          detail: {
            error: "validation",
            code: "INVALID_SWIFT",
            detail: "SWIFT 编码需为 8 或 11 位字母数字",
          },
        },
        { status: 422 },
      );
    }
    // 逐字段覆盖（含 NULL）：允许把填错的字段清空（main.py:4658-4663）
    const next: Record<string, string | null> = {};
    for (const field of COMPANY_PROFILE_FIELDS) {
      if (field === "name_en") next[field] = nameEn;
      else if (field === "swift_code")
        next[field] = swiftRaw ? swiftRaw.toUpperCase() : null;
      else {
        const value = body[field];
        next[field] = typeof value === "string" ? value : null;
      }
    }
    companyProfileStore = next;
    return HttpResponse.json(companyProfileResponse());
  }),

  // GET list ← company-seal-card.tsx:68；POST ← :88；image ← :135；
  // PUT default ← :103；DELETE ← :116。形状 = ws_seals.py:_to_meta
  http.get("/api/v1/tenant/company-seals", () => {
    const items = companySealsStore
      .slice()
      .sort(
        (a, b) =>
          Number(b.is_default) - Number(a.is_default) || a.id - b.id,
      )
      .map(sealOut);
    return HttpResponse.json({ items });
  }),

  http.post("/api/v1/tenant/company-seals", async ({ request }) => {
    const form = await request.formData();
    const nameRaw = form.get("name");
    const name = typeof nameRaw === "string" ? nameRaw.trim() : "";
    if (!name) {
      return HttpResponse.json(
        {
          detail: {
            error: "validation",
            code: "NAME_REQUIRED",
            detail: "请给章起个名字（如：公章 / 财务章）",
          },
        },
        { status: 422 },
      );
    }
    const fileEntry = form.get("file");
    if (!isBlobLike(fileEntry)) {
      return HttpResponse.json(
        {
          detail: {
            error: "validation",
            code: "EMPTY_FILE",
            detail: "上传内容为空",
          },
        },
        { status: 422 },
      );
    }
    const bytes = new Uint8Array(await fileEntry.arrayBuffer());
    if (bytes.byteLength === 0) {
      return HttpResponse.json(
        {
          detail: {
            error: "validation",
            code: "EMPTY_FILE",
            detail: "上传内容为空",
          },
        },
        { status: 422 },
      );
    }
    if (bytes.byteLength > 5 * 1024 * 1024) {
      return HttpResponse.json(
        {
          detail: {
            error: "validation",
            code: "FILE_TOO_LARGE",
            detail: "图片不能超过 5MB",
          },
        },
        { status: 413 },
      );
    }
    const size = pngSize(bytes);
    if (!size) {
      // 后端铁律：只收 PNG（kaas_common.trade_doc.validate_seal_image 只认 PNG 魔数）
      return HttpResponse.json(
        {
          detail: {
            error: "validation",
            code: "BAD_IMAGE",
            detail: "仅支持 PNG（前端会自动把其它格式转成透明底 PNG）",
          },
        },
        { status: 422 },
      );
    }
    if (companySealsStore.some((s) => s.name === name)) {
      return HttpResponse.json(
        {
          detail: {
            error: "conflict",
            code: "SEAL_NAME_TAKEN",
            detail: `已存在同名章「${name}」，请改名或先删除`,
          },
        },
        { status: 409 },
      );
    }
    const setDefaultRaw = form.get("set_default");
    const setDefault = setDefaultRaw === "true";
    if (setDefault) {
      for (const seal of companySealsStore) seal.is_default = false;
    }
    const created: MockCompanySeal = {
      id: companySealSeq++,
      name,
      mime: "image/png",
      width: size.width,
      height: size.height,
      // 首枚章自动成为默认（ws_seals.py:167-172）
      is_default: setDefault || !companySealsStore.some((s) => s.is_default),
      created_by: String(MOCK_ADMIN_USER.user_id),
      created_at: nowIso(),
    };
    companySealsStore.push(created);
    sealBytesStore.set(created.id, bytes);
    return HttpResponse.json(sealOut(created), { status: 201 });
  }),

  http.get("/api/v1/tenant/company-seals/:sealId/image", ({ params }) => {
    const seal = companySealsStore.find(
      (s) => s.id === Number(params.sealId),
    );
    if (!seal) {
      return HttpResponse.json(
        { detail: { error: "not_found", code: "SEAL_NOT_FOUND" } },
        { status: 404 },
      );
    }
    const stored = sealBytesStore.get(seal.id);
    return new HttpResponse(stored ?? MOCK_PNG_BYTES, {
      status: 200,
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "private, max-age=3600",
        "Content-Disposition": `inline; filename="seal-${seal.id}.png"`,
      },
    });
  }),

  http.put("/api/v1/tenant/company-seals/:sealId/default", ({ params }) => {
    const seal = companySealsStore.find(
      (s) => s.id === Number(params.sealId),
    );
    if (!seal) {
      return HttpResponse.json(
        { detail: { error: "not_found", code: "SEAL_NOT_FOUND" } },
        { status: 404 },
      );
    }
    for (const other of companySealsStore) other.is_default = false;
    seal.is_default = true;
    return HttpResponse.json(sealOut(seal));
  }),

  http.delete("/api/v1/tenant/company-seals/:sealId", ({ params }) => {
    const index = companySealsStore.findIndex(
      (s) => s.id === Number(params.sealId),
    );
    const seal = index >= 0 ? companySealsStore[index] : undefined;
    if (!seal) {
      return HttpResponse.json(
        { detail: { error: "not_found", code: "SEAL_NOT_FOUND" } },
        { status: 404 },
      );
    }
    if (seal.is_default && companySealsStore.length > 1) {
      return HttpResponse.json(
        {
          detail: {
            error: "conflict",
            code: "DEFAULT_SEAL",
            detail: "这是默认章，请先把其他章设为默认再删除",
          },
        },
        { status: 409 },
      );
    }
    companySealsStore.splice(index, 1);
    sealBytesStore.delete(seal.id);
    return HttpResponse.json({ deleted: true, id: seal.id });
  }),

  // ── 产品工位「复制系统产品」用的原始定义 ─────────────────────────────────
  // GET ← products-definitions-tab.tsx:742；形状 = quote_api.py:export_quote_product_spec
  http.get("/api/v1/export-quote/products/:productKey/spec", ({ params }) => {
    const product = registryProduct(String(params.productKey));
    if (!product) {
      return HttpResponse.json(
        {
          error: "unknown_product",
          message: `未知产品 ${String(params.productKey)}`,
        },
        { status: 404 },
      );
    }
    return HttpResponse.json({
      product_key: product.key,
      spec: {
        key: product.key,
        name: product.name,
        name_en: product.name_en,
        category_code: product.category_code,
      },
    });
  }),
];
