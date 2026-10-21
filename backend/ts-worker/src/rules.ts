/**
 * KaaS TS 门面 · 共享内核纯函数的**逐行镜像**（临时，非第二份实现）。
 *
 * ⚠️ TODO(TODO:TS3)：本文件全部内容 = backend/kaas_common/workstation/{scope,teams,
 * customer_rules,inquiry_rules,number_rules,subscriptions,customer_records}.py 的
 * **机械直译**（逐行对齐，不改任何判定）。KERNEL（backend/worker）目前没有任何
 * /internal 规则端点可供 Service Binding 调用；按 W3 Phase 2 执行口径
 * （「KERNEL 该端点尚不可用 → 镜像 + 登记 + 测试锁死，待内核暴露 /internal/rules/*
 * 后删除本文件改走 kernel.ts 调用」），先以冻结测试（tests/rules.test.ts）锁死语义，
 * 并在 README「金标差异登记」备案。判定本身**禁止在本仓库其他地方重写**。
 *
 * 每段标注 Python 真源文件与行号区间，便于后续核对与删除。
 */

// ── kaas_common/workstation/scope.py（全文 103 行逐行对齐）──────────────────

/** 角色映射：旧角色 → 三层角色体系（真源 = scope.py:_ROLE_MAP，改口径只改 Python 侧）。 */
const ROLE_MAP: Record<string, string> = {
  system_admin: "system_admin",
  admin: "system_admin", // 历史遗留角色，等价于系统管理员
  owner: "customer_owner",
  customer_owner: "customer_owner",
  user: "customer_member",
  customer_member: "customer_member",
};

export const ADMIN_ROLES = new Set(["system_admin", "admin"]);

/** 旧角色 → 三层角色。未知角色按最小权限（customer_member）处理。 */
export function effectiveRole(role: string | null | undefined): string {
  return ROLE_MAP[role ?? ""] ?? "customer_member";
}

/** 是否管理员（全租户可见）。 */
export function isAdminRole(role: string | null | undefined): boolean {
  return effectiveRole(role) === "system_admin";
}

function sameLoose(a: unknown, b: unknown): boolean {
  /** 宽松相等：owner_id / team_id 在库里可能是 TEXT 也可能是 BIGINT（scope.py:_same）。 */
  if (a === null || a === undefined || b === null || b === undefined) return false;
  return String(a) === String(b);
}

export interface CanViewInput {
  role?: string | null;
  ownerId?: unknown;
  ownerScope?: string | null;
  teamId?: unknown;
  viewerId?: unknown;
  viewerTeamId?: unknown;
}

/** 这条数据对该访问者是否可见（scope.py:can_view，四层判定逐条一致）。 */
export function canView(input: CanViewInput): boolean {
  if (isAdminRole(input.role)) return true;
  if (input.ownerScope === "tenant") return true;
  if (sameLoose(input.ownerId, input.viewerId)) return true;
  // 同团队：行的 team_id 与访问者的团队都非空且相同；行 team_id 为空不放行。
  if (input.teamId !== null && input.teamId !== undefined
    && input.viewerTeamId !== null && input.viewerTeamId !== undefined) {
    return sameLoose(input.teamId, input.viewerTeamId);
  }
  return false;
}

/** 写权限：管理员可改全部；成员只能改自己名下的数据；无属主历史数据不拦。 */
export function canWrite(input: { role?: string | null; ownerId?: unknown; viewerId?: unknown }): boolean {
  if (isAdminRole(input.role)) return true;
  if (input.ownerId === null || input.ownerId === undefined) return true;
  return sameLoose(input.ownerId, input.viewerId);
}

// ── kaas_common/workstation/teams.py（全文 151 行逐行对齐）───────────────────

export const INVITE_STATUS = ["pending", "accepted", "revoked"] as const;
export const INVITE_TTL_DAYS = 14;
export const TEAM_NAME_MAX = 40;

/** 邀请码字符集：URL 安全、去除容易看错的 0/O/1/l/I（teams.py:_TOKEN_ALPHABET）。 */
const TOKEN_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
const TOKEN_LENGTH = 24;

/** 团队业务规则违例（对应 Python TeamRuleError；code 供 API 层落 detail.code）。 */
export class RuleError extends Error {
  readonly code: string;
  readonly detail: string;
  constructor(code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "RuleError";
    this.code = code;
    this.detail = detail;
  }
}

/** 团队名规范化 + 校验：去首尾空白、折叠内部空白、长度 1..40。 */
export function validateTeamName(name: string | null | undefined): string {
  const normalized = (name ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    throw new RuleError("INVALID_TEAM_NAME", "团队名称不能为空");
  }
  if (normalized.length > TEAM_NAME_MAX) {
    throw new RuleError("INVALID_TEAM_NAME", `团队名称不能超过 ${TEAM_NAME_MAX} 个字符`);
  }
  return normalized;
}

/** 生成邀请码（URL 安全、无易混字符、24 位 ≈ 140 bit 熵）。 */
export function generateInviteToken(): string {
  // crypto.getRandomValues 拒绝采样（对齐 secrets.choice 均匀性）
  const out: string[] = [];
  const rand = new Uint8Array(TOKEN_LENGTH);
  crypto.getRandomValues(rand);
  for (const byte of rand) {
    out.push(TOKEN_ALPHABET[byte % TOKEN_ALPHABET.length] as string);
  }
  return out.join("");
}

/** 规范化用户粘贴进来的邀请码（取 token= 值 / 去空白 / 去首尾斜杠）。 */
export function normalizeInviteToken(raw: string | null | undefined): string {
  let text = (raw ?? "").trim();
  if (!text) return "";
  const match = /[?&]token=([^&\s]+)/.exec(text);
  if (match) {
    text = match[1] as string;
  }
  return text.trim().replace(/^\/+|\/+$/g, "");
}

function asDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** 邀请码状态：usable | not_found | revoked | used | expired。 */
export function inviteState(
  invite: Record<string, unknown> | null | undefined,
  now: Date = new Date(),
): "usable" | "not_found" | "revoked" | "used" | "expired" {
  if (invite === null || invite === undefined) return "not_found";
  const status = (invite.status as string | null | undefined) ?? "pending";
  if (status === "revoked") return "revoked";
  if (status === "accepted") return "used";
  const expiresAt = asDate(invite.expires_at);
  if (expiresAt !== null && expiresAt.getTime() <= now.getTime()) {
    return "expired";
  }
  return "usable";
}

/** 是否可管理该团队：团队管理员（团队创建者）或平台管理员。 */
export function isTeamAdmin(teamCreatedBy: unknown, userId: unknown, role?: string | null): boolean {
  if (isAdminRole(role)) return true;
  if (teamCreatedBy === null || teamCreatedBy === undefined || userId === null || userId === undefined) {
    return false;
  }
  return String(teamCreatedBy) === String(userId);
}

/** 转让团队管理员的策略无关校验（真源 teams.py:validate_transfer_target）。 */
export function validateTransferTarget(input: {
  targetUserId: unknown;
  currentOwnerId: unknown;
  memberUserIds: Iterable<unknown>;
}): void {
  if (input.targetUserId === null || input.targetUserId === undefined) {
    throw new RuleError("TRANSFER_TARGET_REQUIRED", "缺少转让目标");
  }
  const target = String(input.targetUserId);
  if (input.currentOwnerId !== null && input.currentOwnerId !== undefined
    && target === String(input.currentOwnerId)) {
    throw new RuleError("TRANSFER_TO_SELF", "不能把团队转让给自己");
  }
  const members = new Set<string>();
  for (const m of input.memberUserIds) members.add(String(m));
  if (!members.has(target)) {
    throw new RuleError("TRANSFER_TARGET_NOT_MEMBER", "转让目标必须是本团队成员");
  }
}

// ── kaas_common/workstation/customer_rules.py（本域用到的子集，逐行对齐）──────

/** 「开启中的订单」（customer_rules.py:OPEN_ORDER_STATUSES）。 */
export const OPEN_ORDER_STATUSES = ["pending", "confirmed", "producing", "shipped"] as const;

/** 客户阶段可手动设置的值（ordered 是推导值，不允许手写）。 */
export const MANUAL_CUSTOMER_STAGES = ["active", "inactive"] as const;

/** 把库里的客户阶段归一成手动值 active / inactive（customer_rules.py:normalize_manual_stage）。 */
export function normalizeManualStage(stage: string | null | undefined): string {
  return stage === "inactive" || stage === "lost" ? "inactive" : "active";
}

/** 校验手动客户阶段是否合法；非法时返回错误信息（对齐 Python 返回 (ok, msg)）。 */
export function validateManualStage(target: string | null | undefined): { ok: boolean; msg: string } {
  if (target === "active" || target === "inactive") {
    return { ok: true, msg: "" };
  }
  if (target === "ordered") {
    return { ok: false, msg: "「已下单」由开启中的订单自动推导，不能手动设置" };
  }
  return {
    ok: false,
    msg: `客户阶段只能是 ${JSON.stringify([...MANUAL_CUSTOMER_STAGES])}（手动）或 ordered（订单推导）；`
      + `收到 ${JSON.stringify(target)}。询盘/报价/订单属于单据阶段，不是客户阶段`,
  };
}

/**
 * 客户阶段推导 SQL（main.py:_customer_stage_sql 逐字直译）。
 * 名下有开启中的订单 ⇒ 'ordered'；否则 inactive/lost ⇒ 'inactive'；其余 'active'。
 */
export function customerStageSql(alias: string = "c"): string {
  return (
    `CASE WHEN EXISTS (SELECT 1 FROM orders o`
    + ` WHERE o.tenant_id = ${alias}.tenant_id AND o.customer_id = ${alias}.id`
    + ` AND o.status IN ('pending','confirmed','producing','shipped')) THEN 'ordered'`
    + ` WHEN ${alias}.stage IN ('inactive','lost') THEN 'inactive'`
    + ` ELSE 'active' END`
  );
}

// ── kaas_common/workstation/inquiry_rules.py（全文逐行对齐）──────────────────

const ABBR_STRIP_RE = /[^A-Z0-9]/g;
const WORD_RE = /[A-Za-z]+/g;
const COUNTRY_RE = /^[A-Za-z]{2}$/;

/** 客户缩写归一：大写、去掉非字母数字；长度不足 2 或超过 6 → null。 */
export function normalizeAbbr(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim().toUpperCase().replace(ABBR_STRIP_RE, "");
  if (text.length < 2 || text.length > 6) return null;
  return text;
}

/** 没有显式缩写时的兜底：拉丁词首（最多 3 位）→ C{id} → 'C'。 */
export function deriveCustomerAbbr(name: string | null | undefined, customerId?: number | null): string {
  const words = (name ?? "").match(WORD_RE) ?? [];
  if (words.length > 0) {
    const initials = words.slice(0, 3).map((w) => w[0] as string).join("").toUpperCase();
    if (initials.length >= 2) return initials;
    // 只有一个英文词（如 "ACME"）→ 取前 3 个字母
    if ((words[0] as string).length >= 2) {
      return (words[0] as string).slice(0, 3).toUpperCase();
    }
  }
  if (customerId !== null && customerId !== undefined) {
    return `C${customerId}`;
  }
  return "C";
}

/** 国家转 ISO2；空/不合法 → XX。 */
export function sanitizeCountry(raw: string | null | undefined): string {
  const text = (raw ?? "").trim();
  if (COUNTRY_RE.test(text)) return text.toUpperCase();
  return "XX";
}

// ── kaas_common/workstation/number_rules.py（本域用到的子集，逐行对齐）────────

/** 类型代码（number_rules.py:DOC_TYPE_PREFIX；本域只用 inquiry=INQ，全表照抄防漂移）。 */
export const DOC_TYPE_PREFIX: Record<string, string> = {
  quotation: "QUO", pi: "PI", contract: "CON", ci: "CI", pl: "PL",
  shipping_advice: "SA", draft: "DR", beneficiary_cert: "BEN",
  beneficiary_decl: "BD",
  non_wood_packing: "NWP", weight_list: "WL", quality_cert: "QC",
  manufacturer_cert: "MC", bl: "BL", co: "CO", insurance: "INS",
  customs_declaration: "CD", fumigation_cert: "FUM", saso_coc: "COC",
  vessel_cert: "VC", export_license: "EL", ciq: "CIQ",
  other: "DOC", order: "ORD", shipment: "SHP",
  inquiry: "INQ",
};

const TOKEN_STRIP_RE = /[^A-Z0-9]/g;
const MAX_CUSTOMER_TOKEN = 8;

/** 编号允许：字母/数字/中文 + 常见分隔符；不允许空白与控制字符。 */
const NUMBER_RE = /^[A-Za-z0-9_一-鿿][A-Za-z0-9_一-鿿._\/#-]*$/;
const MAX_NUMBER_LEN = 64;

/** 编号不合法（对应 Python NumberError）。 */
export class NumberRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NumberRuleError";
  }
}

type CustomerLike = { get: (key: string) => unknown };

function getCustomer(customer: CustomerLike | null | undefined, key: string): unknown {
  return customer?.get(key);
}

/** 从客户档案生成编号里的客户段：显式缩写 > 拉丁词首 > C{id}。 */
export function customerToken(customer: CustomerLike | null | undefined): string {
  if (customer === null || customer === undefined) return "C";
  const abbr = normalizeAbbr(getCustomer(customer, "abbr") as string | null | undefined);
  if (abbr) return abbr;
  const token = deriveCustomerAbbr(
    (getCustomer(customer, "name") ?? getCustomer(customer, "company_name")) as string | null | undefined,
    getCustomer(customer, "id") as number | null | undefined
      ?? getCustomer(customer, "customer_id") as number | null | undefined,
  );
  return (String(token).toUpperCase().replace(TOKEN_STRIP_RE, "") || "C").slice(0, MAX_CUSTOMER_TOKEN);
}

/** 本地时间戳 yyyyMMddHHmmss（对齐 Python datetime.now().strftime，两侧运行时均为 UTC）。 */
function tsLocal(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 统一编号：类型-国家-客户-时间戳（number_rules.py:build_number）。 */
export function buildNumber(
  docType: string,
  customer: CustomerLike | null | undefined,
  createdAt: Date | null = null,
  options: { suffix?: number } = {},
): string {
  const prefix = DOC_TYPE_PREFIX[docType] ?? docType.toUpperCase().slice(0, 3);
  let country = "XX";
  if (customer !== null && customer !== undefined) {
    country = sanitizeCountry(getCustomer(customer, "country") as string | null | undefined);
  }
  const ts = tsLocal(createdAt ?? new Date());
  const base = `${prefix}-${country}-${customerToken(customer)}-${ts}`;
  const suffix = options.suffix ?? 0;
  return suffix <= 1 ? base : `${base}-${suffix}`;
}

/** 去空白并校验手改编号；空/非法 → NumberRuleError（number_rules.py:normalize_number）。 */
export function normalizeNumber(value: string | null | undefined): string {
  const text = (value ?? "").toString().trim();
  if (!text) {
    throw new NumberRuleError("编号不能为空；留空时应由系统自动生成");
  }
  if (text.length > MAX_NUMBER_LEN) {
    throw new NumberRuleError(`编号不能超过 ${MAX_NUMBER_LEN} 个字符`);
  }
  if (!NUMBER_RE.test(text)) {
    throw new NumberRuleError("编号只能包含字母/数字/中文及 . _ / # -，不能含空格或控制字符");
  }
  return text;
}

// ── kaas_common/workstation/subscriptions.py（本域用到的子集，逐行对齐）───────

/** 全工位套餐：开通它等于开通所有工位。 */
export const FULL_CHAIN = "full_chain";

/** 工位 key 清单（subscriptions.py:WORKSTATION_PATHS 的 key 集；本域只消费 all_workstations）。 */
const WORKSTATION_KEYS: string[] = [
  "customers", "orders", "leadgen", "outreach", "quotes", "research", "shipments", "trade-docs", "intel",
];

/** 全部工位编码（字母序，对齐 all_workstations()）。 */
export function allWorkstations(): string[] {
  return [...WORKSTATION_KEYS].sort();
}

/**
 * 建团队/注册时勾选的工位 → 要开通的编码清单
 * （ws_teams.py:_resolve_signup_workstations 逐字直译；非法 → RuleError UNKNOWN_WORKSTATION）。
 * 不传（undefined）= 默认全部工位；传空数组 = 零开通。
 */
export function resolveSignupWorkstations(chosen: string[] | null | undefined): string[] {
  if (chosen === null || chosen === undefined) return allWorkstations();
  const known = new Set(allWorkstations());
  const out: string[] = [];
  for (const raw of chosen) {
    const code = (raw ?? "").trim().toLowerCase();
    if (!known.has(code)) {
      throw new RuleError(
        "UNKNOWN_WORKSTATION",
        `未知工位：${raw}；可选：${[...known].sort().join(", ")}`,
      );
    }
    if (!out.includes(code)) {
      out.push(code);
    }
  }
  return out;
}

// ── kaas_common/workstation/customer_records.py（build_records 逐行对齐）──────

function recGet(row: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) {
    if (name in row) return row[name];
  }
  return null;
}

function recIso(value: unknown): unknown {
  return value instanceof Date ? pyIsoLike(value) : value;
}

function pyIsoLike(d: Date): string {
  return d.toISOString().replace("Z", "+00:00");
}

/** 金额统一成字符串：Decimal 直接 JSON 化会丢精度（postgres.js numeric 已是 string，原样保留）。 */
function money(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  return String(value);
}

function recNum(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function quoteOut(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: recNum(row.id),
    quote_no: recGet(row, "quote_no"),
    status: recGet(row, "status"),
    currency: recGet(row, "currency"),
    total_amount: money(recGet(row, "total_amount")),
    created_at: recIso(recGet(row, "created_at")),
    inquiry_id: recNum(recGet(row, "inquiry_id")),
  };
}

function orderOut(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: recNum(row.id),
    order_no: recGet(row, "order_no"),
    status: recGet(row, "status"),
    currency: recGet(row, "currency"),
    total_amount: money(recGet(row, "total_amount")),
    created_at: recIso(recGet(row, "created_at")),
  };
}

function docOut(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: recNum(row.id),
    doc_no: recGet(row, "doc_no"),
    doc_type: recGet(row, "doc_type"),
    status: recGet(row, "status"),
    currency: recGet(row, "currency"),
    total_amount: money(recGet(row, "total_amount")),
    created_at: recIso(recGet(row, "created_at")),
  };
}

export interface RecordsNode {
  documents?: unknown[];
  orders?: unknown[];
  [key: string]: unknown;
}

/**
 * 报价 → 报价单 / 订单 → 单证的包含关系树装配（customer_records.py:build_records）。
 * 父对象缺失或已被删除的单证/订单 → 落 direct，不允许从树上消失。
 */
export function buildRecords(
  customer: Record<string, unknown>,
  quotes: Record<string, unknown>[],
  orders: Record<string, unknown>[],
  docs: Record<string, unknown>[],
): Record<string, unknown> {
  const quoteNodes = new Map<unknown, RecordsNode>();
  for (const r of quotes) {
    quoteNodes.set(r.id, { ...quoteOut(r), documents: [], orders: [] });
  }
  const orderNodes = new Map<unknown, RecordsNode>();
  for (const r of orders) {
    orderNodes.set(r.id, { ...orderOut(r), documents: [] });
  }
  const direct: RecordsNode = { orders: [], documents: [] };

  for (const d of docs) {
    const item = docOut(d);
    const qid = recGet(d, "quote_id");
    const oid = recGet(d, "order_id");
    if (qid !== null && qid !== undefined && quoteNodes.has(qid)) {
      (quoteNodes.get(qid) as RecordsNode).documents!.push(item);
    } else if (oid !== null && oid !== undefined && orderNodes.has(oid)) {
      (orderNodes.get(oid) as RecordsNode).documents!.push(item);
    } else {
      (direct.documents as unknown[]).push(item);
    }
  }

  for (const r of orders) {
    const node = orderNodes.get(r.id) as RecordsNode;
    const qid = recGet(r, "quote_id");
    if (qid !== null && qid !== undefined && quoteNodes.has(qid)) {
      (quoteNodes.get(qid) as RecordsNode).orders!.push(node);
    } else {
      (direct.orders as unknown[]).push(node);
    }
  }

  const name = recGet(customer, "company_name", "name");
  return {
    customer: { id: recNum(recGet(customer, "id")), name, team_id: recGet(customer, "team_id") },
    counts: { quotes: quoteNodes.size, orders: orderNodes.size, documents: docs.length },
    quotes: [...quoteNodes.values()],
    direct,
  };
}
