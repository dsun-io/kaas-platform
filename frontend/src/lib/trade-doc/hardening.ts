/**
 * A7 单证加固的**共享契约**（事实 / 一致性 / lint / 收款 / 单证清单）。
 *
 * 形状真源 = `backend/worker/src/ws_docs_hardening.py`（逐字段对照，2026-10-21）：
 *   GET    /trade-docs/{id}/facts                        → `list_trade_doc_facts`
 *   POST   /trade-docs/{id}/facts/confirm                → `confirm_trade_doc_facts`
 *   PATCH  /trade-docs/{id}/facts/{fact_key}             → `patch_trade_doc_fact`
 *   GET    /trade-docs/{id}/consistency                  → `get_trade_doc_consistency`
 *   POST   /trade-docs/{id}/lint                         → `lint_trade_doc`
 *   GET    /trade-docs/{id}/receipts                     → `list_trade_doc_receipts`
 *   POST   /trade-docs/{id}/receipts                     → `create_trade_doc_receipt`
 *   GET    /trade-docs/{id}/doc-set                      → `get_trade_doc_doc_set`
 *   PUT    /trade-docs/{id}/doc-set                      → `put_trade_doc_doc_set`
 *   POST   /trade-docs/{id}/doc-set/{doc_type}/receipt   → `record_doc_set_receipt`
 *   （`POST .../verify-export` 后端有，前端**刻意不接**：需 PDF 文本/图片抽取能力，
 *     见任务口径"导出后自检暂不接 UI"，不在此登记类型以免被误用。）
 *
 * 为什么单独一个文件：四个面板 + 签发闸门读的是同一套字段；类型/标签/错误解析各写一份
 * 必然漂移（G1 老毛病）。这里只放**纯数据与纯函数**，不引 React。
 */

// ── 事实 ────────────────────────────────────────────────────────────────────

/** 信任级：`confirmed` 已确认 / `unverified` 待确认（付款条款解析结果一律是这个）/ `inferred` 推断 */
export type FactTrust = "confirmed" | "unverified" | "inferred";

/** 内核 `_fact_dict()` 的逐字段投影（`ws_docs_hardening.py:399-413`）。 */
export interface DocFact {
  key: string;
  /** **只读**：值的唯一真源是单证 payload（PATCH 改 value 后端 422） */
  value: string;
  trust: FactTrust;
  source: string | null;
  /** true = 派生单只能原值引用，改了就 FACT_IMMUTABLE */
  immutable: boolean;
  text_zh: string | null;
  text_en: string | null;
  confirmed_by: string | null;
  confirmed_at: string | null;
  evidence_ref: string | null;
  /** 金额类事实的币种（界面按币种显示容差口径） */
  currency: string | null;
}

/** `_summary()`：界面顶部"✓ 已确认 N / ⚠ 待确认 M"的唯一来源。 */
export interface FactsSummary {
  total: number;
  confirmed: number;
  unverified: number;
  inferred: number;
}

export interface DocFactsResponse {
  doc_id: number;
  doc_type: string | null;
  doc_no: string | null;
  status: string | null;
  items: DocFact[];
  summary: FactsSummary;
}

export interface FactsConfirmResponse {
  doc_id: number;
  /** 本次被确认的 key（空 keys 提交时 = 全部未确认项） */
  confirmed: string[];
  summary: FactsSummary;
}

/** PATCH 可改的处置字段 —— 注意**没有 value**（给入口就是给自己埋 422）。 */
export interface FactPatchInput {
  trust?: FactTrust;
  immutable?: boolean;
  text_zh?: string | null;
  text_en?: string | null;
  evidence_ref?: string | null;
}

export interface FactPatchResponse {
  doc_id: number;
  item: DocFact;
}

// ── 跨单证一致性 ────────────────────────────────────────────────────────────

/**
 * 三档状态（内核 `consistency.py:78-80` 的文案口径）：
 * `conflict` 冲突（红，阻断）/ `equivalent` 等价措辞（黄，可见不阻断）/ `missing` 缺失（灰）
 */
export type ConsistencyStatus = "conflict" | "equivalent" | "missing";

export interface ConsistencyItem {
  /** 红/黄由 severity 决定；三档展示再按 status 分（见 `CONSISTENCY_META`） */
  severity: "error" | "warning";
  code: string;
  key: string;
  status: ConsistencyStatus;
  /** 基线单证 id（字符串，与后端 domain.doc_ids 同型） */
  baseline_doc: string;
  /** `{doc_id: 该单证的值}` */
  values: Record<string, string>;
  detail: string;
}

export interface ConsistencyResponse {
  ok: boolean;
  domain: { root: string; doc_ids: string[] };
  items: ConsistencyItem[];
}

// ── lint（签发前预检）──────────────────────────────────────────────────────

/** blocking 项：四种 code 决定"能不能签"，detail 是给人看的原因。 */
export interface BlockingItem {
  code: string;
  keys?: string[];
  detail: string;
  evidence_ref?: string | null;
  original?: string | null;
  provided?: string | null;
  doc_type?: string | null;
  doc_id?: number | null;
  doc_no?: string | null;
  target_doc_id?: number | null;
}

export interface LintWarning {
  code: string;
  key?: string;
  detail: string;
  expected?: string | null;
  provided?: string | null;
}

export interface LintResponse {
  doc_id: number;
  ok: boolean;
  blocking: BlockingItem[];
  warnings: LintWarning[];
  summary: { blocking: number; warnings: number; facts: FactsSummary };
}

// ── 收款登记 ────────────────────────────────────────────────────────────────

/**
 * 核销状态：`reconciled` 自动核销（diff_reason=fx_rounding，绿）/
 * `short_paid` 短收挂账（红）/ `manual` 手工登记无账期（灰，不冒充已核销）。
 * 注意徽标按 `diff_reason` 着色更贴切 —— 二者由后端成对给出，这里两者都收。
 */
export type ReceiptStatus = "reconciled" | "short_paid" | "manual";
export type ReceiptDiffReason = "fx_rounding" | "short_paid" | "manual";

export interface DocReceipt {
  id: number;
  schedule_type: string | null;
  /** 后端 `decimal_text()` 已转成字符串（保留精度，前端不 parseFloat 再丢精度） */
  schedule_amount: string | null;
  received_amount: string;
  currency: string;
  received_at: string | null;
  bank_ref: string | null;
  notes: string | null;
  diff: string | null;
  diff_reason: ReceiptDiffReason | null;
  fx_rate_used: string | null;
  status: ReceiptStatus;
  created_by: string | null;
  created_at: string | null;
}

export interface ReceiptsResponse {
  doc_id: number;
  items: DocReceipt[];
  total: number;
}

export interface ReceiptVerdict {
  diff: string;
  tolerance: string;
  auto_cleared: boolean;
  diff_reason: ReceiptDiffReason;
}

export interface CreateReceiptInput {
  schedule_type?: string | null;
  schedule_amount?: string | null;
  received_amount: string;
  currency: string;
  bank_ref?: string | null;
  notes?: string | null;
}

export interface CreateReceiptResponse {
  doc_id: number;
  item: DocReceipt;
  verdict: ReceiptVerdict;
}

// ── 单证清单 ────────────────────────────────────────────────────────────────

/** 清单角色：`not_by_us`（对方出单）需要回执登记。 */
export type DocSetRole = "required" | "optional" | "not_by_us";
export type DocSetIssuer =
  | "ours"
  | "buyer"
  | "third_party:ccpit"
  | "carrier"
  | "insurer";
export type DocSetStatus = "pending" | "received" | "waived";

export interface DocSetItem {
  doc_type: string;
  role: DocSetRole;
  issuer: DocSetIssuer;
  trigger_expr: string | null;
  evidence_required: boolean;
  status: DocSetStatus;
  waived_reason: string | null;
  received_doc_id: number | null;
  received_at: string | null;
}

export interface DocSetResponse {
  doc_id: number;
  items: DocSetItem[];
  /** PUT 的响应没有 total（`put_trade_doc_doc_set` 只回 items） */
  total?: number;
}

export interface DocSetPutInput {
  items: Array<{
    doc_type: string;
    role: DocSetRole;
    issuer: DocSetIssuer;
    trigger_expr?: string | null;
    evidence_required?: boolean;
  }>;
}

export interface DocSetReceiptInput {
  action: "receive" | "waive";
  received_doc_id?: number | null;
  waived_reason?: string | null;
}

export interface DocSetReceiptResponse {
  doc_id: number;
  item: DocSetItem;
}

// ── 枚举与标签（后端 `kaas_common/domain/enums.py` / ws_docs_hardening 常量）──

export const SCHEDULE_TYPES = ["deposit", "balance", "full"] as const;
export const CURRENCIES = [
  "USD",
  "CNY",
  "EUR",
  "GBP",
  "JPY",
  "AUD",
  "CAD",
  "HKD",
] as const;
export const DOC_SET_ROLES: readonly DocSetRole[] = [
  "required",
  "optional",
  "not_by_us",
];
export const DOC_SET_ISSUERS: readonly DocSetIssuer[] = [
  "ours",
  "buyer",
  "third_party:ccpit",
  "carrier",
  "insurer",
];

export type Tone = "default" | "success" | "warning" | "danger" | "info" | "purple";

export const FACT_TRUST_META: Record<
  FactTrust,
  { label: string; tone: Tone; hint: string }
> = {
  confirmed: { label: "已确认", tone: "success", hint: "已人工核对" },
  unverified: {
    label: "待确认",
    tone: "danger",
    hint: "解析/推断出的值，未经人工核对；签发前必须确认",
  },
  inferred: {
    label: "推断",
    tone: "warning",
    hint: "由上游或规则推断，签发前需确认",
  },
};

export const CONSISTENCY_META: Record<
  ConsistencyStatus,
  { label: string; tone: Tone; hint: string }
> = {
  conflict: {
    label: "冲突",
    tone: "danger",
    hint: "不同单证对同一事实给了不同值 —— 阻断导出/签发，必须核对",
  },
  equivalent: {
    label: "等价措辞",
    tone: "warning",
    hint: "同一事实的两种等价写法（大小写/空格/标点不同），可见但不阻断",
  },
  missing: {
    label: "缺失",
    tone: "default",
    hint: "基线有、本单证没有这个事实 —— 不阻断，但可能漏项",
  },
};

export const DOC_SET_ROLE_LABEL: Record<DocSetRole, string> = {
  required: "必须提供",
  optional: "可选",
  not_by_us: "对方出具（需回执）",
};

/** 收款徽标三档（按 `diff_reason` 着色；`status` 与其成对给出）。 */
export const RECEIPT_META: Record<
  ReceiptDiffReason,
  { label: string; tone: Tone; hint: string }
> = {
  fx_rounding: {
    label: "汇率尾差·自动核销",
    tone: "success",
    hint: "差额在容差内（银行手续费/汇率尾差）",
  },
  short_paid: {
    label: "短收挂账",
    tone: "danger",
    hint: "差额超出容差，需业务决定催收还是让利",
  },
  manual: {
    label: "手工登记",
    tone: "default",
    hint: "未提供账期金额，无从核销（不冒充已核销）",
  },
};

/** 收款徽标取用（未知取值兜底成 manual，绝不 undefined）。 */
export function receiptMeta(
  key: string | null | undefined,
): { label: string; tone: Tone; hint: string } {
  if (key === "fx_rounding" || key === "short_paid" || key === "manual") {
    return RECEIPT_META[key];
  }
  return RECEIPT_META.manual;
}

export const DOC_SET_ISSUER_LABEL: Record<DocSetIssuer, string> = {
  ours: "我方",
  buyer: "买方",
  "third_party:ccpit": "第三方·贸促会",
  carrier: "承运人",
  insurer: "保险人",
};

export const DOC_SET_STATUS_META: Record<
  DocSetStatus,
  { label: string; tone: Tone }
> = {
  pending: { label: "待回执", tone: "warning" },
  received: { label: "已收到", tone: "success" },
  waived: { label: "已豁免", tone: "default" },
};

/**
 * 收款容差 = max(该币种 5 美分等值, 金额 × 0.1%)。
 * 与内核 `kaas_common/workstation/receipt_rules.py:28-39` **同一张表同一公式** ——
 * 前端只用它做"预计会怎么判"的输入提示，判定以后端为准。
 */
const CURRENCY_ABS_TOLERANCE: Record<string, number> = {
  USD: 0.05,
  EUR: 0.05,
  CNY: 0.35,
  GBP: 0.05,
  JPY: 5,
  AUD: 0.05,
  CAD: 0.05,
  HKD: 0.4,
};

export function receiptTolerance(currency: string, amount: number): number {
  const abs = CURRENCY_ABS_TOLERANCE[(currency || "").toUpperCase()] ?? 0.05;
  return Math.max(abs, Math.abs(amount) * 0.001);
}

// ── 签发闸门的 422 解析 ─────────────────────────────────────────────────────

/** 签发被拒时界面要展示的阻断清单（后端 422 的 `detail.blocking`）。 */
export interface ConfirmBlocked {
  code: string;
  message: string;
  blocking: BlockingItem[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * 从 confirm 的 422 里取出阻断清单。
 *
 * 后端形状（`ws_docs_ext.confirm_trade_doc`，A7 接入处）：
 * `{"detail": {"error":"validation","code":"FACT_UNVERIFIED","detail":"…","blocking":[…]}}`
 * —— 比通用错误体多一个 `blocking`，所以不能只用 `normalizeApiError`（它只归一律文/码）。
 * **不是加固阻断**（例如普通校验/网络错误）时返回 null，交由调用方按原逻辑提示。
 */
export function parseConfirmBlocked(error: unknown): ConfirmBlocked | null {
  const response = asRecord(asRecord(error)?.["response"]);
  const body = asRecord(response?.["data"]);
  const detail = asRecord(body?.["detail"]);
  if (!detail) return null;
  const blocking = detail["blocking"];
  if (!Array.isArray(blocking) || blocking.length === 0) return null;
  const items = blocking
    .map((raw) => asRecord(raw))
    .filter((raw): raw is Record<string, unknown> => raw !== null)
    .map((raw) => ({
      code: String(raw["code"] ?? "UNKNOWN"),
      keys: Array.isArray(raw["keys"])
        ? raw["keys"].map((key) => String(key))
        : undefined,
      detail: String(raw["detail"] ?? ""),
      evidence_ref:
        typeof raw["evidence_ref"] === "string" ? raw["evidence_ref"] : null,
      original: typeof raw["original"] === "string" ? raw["original"] : null,
      provided: typeof raw["provided"] === "string" ? raw["provided"] : null,
      doc_type: typeof raw["doc_type"] === "string" ? raw["doc_type"] : null,
      doc_id: typeof raw["doc_id"] === "number" ? raw["doc_id"] : null,
      doc_no: typeof raw["doc_no"] === "string" ? raw["doc_no"] : null,
      target_doc_id:
        typeof raw["target_doc_id"] === "number" ? raw["target_doc_id"] : null,
    }));
  return {
    code: String(detail["code"] ?? items[0]?.code ?? "FACT_UNVERIFIED"),
    message: String(detail["detail"] ?? ""),
    blocking: items,
  };
}
