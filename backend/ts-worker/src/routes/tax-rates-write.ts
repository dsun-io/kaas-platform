// P2 §9 #4 前置 · tax-archives 写路径（POST/PATCH/DELETE）门面直连（AUTH_DB_SPLIT=on 时启用）。
//
// 真源逐条直译：
// - POST   /api/v1/tax-archives        backend/worker/src/tax_archives.py:218-245
// - PATCH  /api/v1/tax-archives/{id}   backend/worker/src/tax_archives.py:248-292
// - DELETE /api/v1/tax-archives/{id}   backend/worker/src/tax_archives.py:295-314（软删 = status inactive）
// **纯校验的唯一真源** = backend/kaas_common/workstation/tax_archive_rules.py（2026-10-24 下沉）：
// 名称/编码归一、税率值范围、日期解析、状态机、PATCH 合并语义都在那里；本文件只是
// **协议层落点**（把同一份规则映射成 422/409/403 信封），业务判定不在这里新增。
//
// 边界：单表语义（tax_archives 一张表；teams 只读一次做团队管理员判定），无跨表事务。
// 开关：off（默认）⇒ **原样 forwardKernelRequest**（与 createProxyApp 同一句）；
//       on ⇒ 先判开关 ⇒ requireUser + 门面直连。判定次序与 P0/quotes-read 一致。
// 工作位闸门不在本文件做（门面闸门中间件统一覆盖）。
import { Hono, type Context } from "hono";

import { useDirectRoute } from "../boot-flag";
import { withDb, type Db } from "../db";
import { getEnv, type Env } from "../env";
import {
  tax_archives_ProductTaxRateIn,
  tax_archives_ProductTaxRatePatch,
  tax_archives_TaxArchiveCreate,
  tax_archives_TaxArchivePatch,
} from "../generated/schemas";
import { directDb } from "../hot-read";
import { httpError, parseBody, pyIso, respond } from "../http";
import { PRODUCT_KEYS } from "../product-registry";
import { forwardKernelRequest } from "../proxy";
import { isAdminRole, isTeamAdmin } from "../rules";
import { requireUser, type CurrentUser } from "../session";
import { taxArchiveOut } from "./quotes-read";

const DEFAULT_TENANT = "default";

/** 行别名（只按列名读取）。 */
type Row = Record<string, unknown>;

// ══════════════════════════════════════════════════════════════════════════════
// 共享纯校验的**门面落点**（真源 = kaas_common/workstation/tax_archive_rules.py）
// 只做"同一份规则的协议层映射"：错误码/文案/状态逐字对齐内核，便于两侧 parity 断言。
// ══════════════════════════════════════════════════════════════════════════════

/** 税率键白名单（tax_models.py:TaxArchive.tax_values；与共享内核 TAX_KEYS 同序）。 */
export const TAX_KEYS = ["output_vat_rate", "misc_fee_rate"] as const;
/** 档案状态（active/inactive；DELETE = 软删到 inactive）。 */
export const ARCHIVE_STATUSES = ["active", "inactive"] as const;

/** normalize_name：strip；空 → 422 NAME_REQUIRED（文案逐字对齐内核）。 */
export function normalizeName(raw: unknown): string {
  const text = raw === null || raw === undefined ? "" : String(raw).trim();
  if (!text) {
    throw httpError(422, {
      error: "validation", code: "NAME_REQUIRED", detail: "档案名称不能为空",
    });
  }
  return text;
}

/** normalize_code：strip；空（含纯空白）→ null（调用方决定沿用旧值 / 自动生成）。 */
export function normalizeCode(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  return text ? text : null;
}

/** validate_status：只允许 active / inactive，否则 422 INVALID_STATUS。 */
export function validateStatus(status: unknown): string {
  if (!(ARCHIVE_STATUSES as readonly unknown[]).includes(status)) {
    throw httpError(422, {
      error: "validation", code: "INVALID_STATUS",
      detail: "status 只能是 active / inactive",
    });
  }
  return status as string;
}

/** parse_effective_date：空 → null；非法 → 422 INVALID_DATE；合法 → 'YYYY-MM-DD'（DATE 列直传）。 */
export function parseEffectiveDate(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const text = String(value).slice(0, 10);
  const ok = /^\d{4}-\d{2}-\d{2}$/.test(text)
    && !Number.isNaN(new Date(text + "T00:00:00Z").getTime())
    && new Date(text + "T00:00:00Z").toISOString().slice(0, 10) === text;
  if (!ok) {
    throw httpError(422, {
      error: "validation", code: "INVALID_DATE",
      detail: "日期格式不合法：" + String(value) + "（应为 YYYY-MM-DD）",
    });
  }
  return text;
}

/** clean_tax_values：至少一项、逐项 ∈ [0,1]；错误码/文案逐字对齐共享内核。 */
export function cleanTaxValues(raw: unknown): Record<string, number> {
  if (raw === null || raw === undefined) return {};
  const source = raw as Record<string, unknown>;
  const values: Record<string, number> = {};
  for (const key of TAX_KEYS) {
    const value = source[key];
    if (value === null || value === undefined) continue;
    const number = Number(value);
    if (!(number >= 0 && number <= 1)) {
      throw httpError(422, {
        error: "validation", code: "INVALID_TAX_RATE",
        detail: key + " 必须在 0~1 之间（10% 请填 0.1）",
      });
    }
    values[key] = number;
  }
  if (Object.keys(values).length === 0) {
    throw httpError(422, {
      error: "validation", code: "TAX_VALUES_REQUIRED", detail: "至少填写一个税率项",
    });
  }
  return values;
}

// PATCH 的「只更新显式给出（非 null）字段」合并语义（= shared resolve_patch）。
// 校验顺序与内核一致：name → tax_values → effective_from → effective_to → status。
function resolvePatch(body: Record<string, unknown>, row: Row): {
  name: unknown; code: unknown; effective_from: unknown; effective_to: unknown;
  tax_values: unknown; source: unknown; status: unknown;
} {
  let name: unknown;
  if (body.name !== null && body.name !== undefined) {
    name = normalizeName(body.name);
  } else {
    name = row.name;
    if (!name) {
      throw httpError(422, {
        error: "validation", code: "NAME_REQUIRED", detail: "档案名称不能为空",
      });
    }
  }
  const code = body.code !== null && body.code !== undefined
    ? normalizeCode(body.code)
    : row.code;
  const values = body.tax_values !== null && body.tax_values !== undefined
    ? cleanTaxValues(body.tax_values)
    : (row.tax_values ?? {});
  const effectiveFrom = body.effective_from !== null && body.effective_from !== undefined
    ? parseEffectiveDate(body.effective_from)
    : (row.effective_from ?? null);
  const effectiveTo = body.effective_to !== null && body.effective_to !== undefined
    ? parseEffectiveDate(body.effective_to)
    : (row.effective_to ?? null);
  const source = body.source !== null && body.source !== undefined ? body.source : row.source;
  const status = body.status !== null && body.status !== undefined ? body.status : row.status;
  validateStatus(status);
  return {
    name, code, effective_from: effectiveFrom, effective_to: effectiveTo,
    tax_values: values, source, status,
  };
}

/** ensure_archive_team：档案必须属操作者团队（PATCH/DELETE；detail 由调用方给，逐字不同）。 */
export function ensureArchiveTeam(row: Row, teamId: unknown, detail: string): void {
  if (String(row.team_id) !== String(teamId)) {
    throw httpError(403, {
      error: "forbidden", code: "TEAM_ADMIN_REQUIRED", detail,
    });
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// 产品税率（product_tax_rates）写路径的**门面落点**
// 真源同共享内核 kaas_common/workstation/tax_archive_rules.py（同域并入）：
// 产品键归一 + 注册表白名单、两档税率范围、至少一项、PATCH 合并语义。
// ══════════════════════════════════════════════════════════════════════════════

/** 产品键归一：strip（迁移前就是这个口径；空/未知都落到 ensureKnownProduct 的 422）。 */
export function normalizeProductKey(raw: unknown): string {
  return raw === null || raw === undefined ? "" : String(raw).trim();
}

/** 产品必须在共享注册表里（真源 kaas_common.export_quote.products.has；TS 侧 = PRODUCT_KEYS）。 */
export function ensureKnownProduct(productKey: string): void {
  if (!PRODUCT_KEYS.includes(productKey)) {
    throw httpError(422, {
      error: "validation", code: "UNKNOWN_PRODUCT",
      detail: "产品 " + productKey + " 不存在",
    });
  }
}

/** 单档税率：null → null；其余转数且必须在 [0,1]，否则 422 INVALID_TAX_RATE（label 用中文）。 */
export function validateTaxRate(value: unknown, label: string): number | null {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  if (!(number >= 0 && number <= 1)) {
    throw httpError(422, {
      error: "validation", code: "INVALID_TAX_RATE",
      detail: label + " 必须在 0~1 之间（10% 请填 0.1）",
    });
  }
  return number;
}

/** POST 专用：两档至少填一项（PATCH 允许两档都为空，故不在此校验）。 */
export function ensureAtLeastOneRate(
  inputRate: number | null,
  rebateRate: number | null,
): void {
  if (inputRate === null && rebateRate === null) {
    throw httpError(422, {
      error: "validation", code: "TAX_VALUES_REQUIRED",
      detail: "进项增值税率、出口退税率至少填一个",
    });
  }
}

/** PATCH 合并语义：只覆盖显式给出的那一档，另一档沿用旧值（旧值数值化，同内核 float(...)）。 */
export function resolveRatePatch(
  body: Record<string, unknown>,
  row: Row,
): { input_vat_rate: number | null; rebate_rate: number | null } {
  let inputRate = row.input_vat_rate === null || row.input_vat_rate === undefined
    ? null : Number(row.input_vat_rate);
  let rebateRate = row.rebate_rate === null || row.rebate_rate === undefined
    ? null : Number(row.rebate_rate);
  if (body.input_vat_rate !== null && body.input_vat_rate !== undefined) {
    inputRate = validateTaxRate(body.input_vat_rate, "进项增值税率");
  }
  if (body.rebate_rate !== null && body.rebate_rate !== undefined) {
    rebateRate = validateTaxRate(body.rebate_rate, "出口退税率");
  }
  return { input_vat_rate: inputRate, rebate_rate: rebateRate };
}

/** _product_tax_out：7 键投影（与 quotes-read.ts 的 GET 投影同一份真源 tax_archives.py:282）。 */
export function productTaxRateOut(row: Row): Row {
  return {
    id: row.id === null || row.id === undefined ? null : Number(row.id),
    product_key: row.product_key ?? null,
    input_vat_rate: row.input_vat_rate === null || row.input_vat_rate === undefined
      ? null : Number(row.input_vat_rate),
    rebate_rate: row.rebate_rate === null || row.rebate_rate === undefined
      ? null : Number(row.rebate_rate),
    status: row.status ?? null,
    created_at: pyIso(row.created_at ?? null),
    updated_at: pyIso(row.updated_at ?? null),
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// DB 侧（单表语义）：团队闸门 / 唯一性 / 取号 / 读写 —— 与内核逐条对应
// ══════════════════════════════════════════════════════════════════════════════

/** _team_id(write=True) + _require_team_admin：无团队 403 TEAM_REQUIRED；非团队管理员 403。 */
async function requireTeamContext(env: Env, user: CurrentUser): Promise<number> {
  const teamId = user.team_id;
  if (teamId === null || teamId === undefined) {
    throw httpError(403, {
      error: "forbidden", code: "TEAM_REQUIRED",
      detail: "税务档案是团队级资源，当前账号没有团队",
    });
  }
  if (isAdminRole(user.role)) return teamId;
  const rows = await withDb(env, (sql: Db) =>
    sql.unsafe("SELECT created_by FROM teams WHERE id=$1", [teamId] as never[])) as unknown as Row[];
  const row = rows[0];
  if (!row || !isTeamAdmin(row.created_by, user.id, user.role)) {
    throw httpError(403, {
      error: "forbidden", code: "TEAM_ADMIN_REQUIRED",
      detail: "仅团队管理员可修改企业抬头/收款信息/公章",
    });
  }
  return teamId;
}

/** _check_unique：同团队内 name/code 唯一（不改库；命中 → 409，文案逐字对齐）。 */
async function checkUnique(
  env: Env, teamId: number, name: unknown, code: unknown, excludeId?: number,
): Promise<void> {
  const checks: Array<[string, unknown, string, string]> = [
    ["name", name, "名称", "NAME_TAKEN"],
    ["code", code, "编码", "CODE_TAKEN"],
  ];
  for (const [column, value, label, errorCode] of checks) {
    if (value === null || value === undefined || value === "") continue;
    await withDb(env, async (sql: Db) => {
      const params: unknown[] = [DEFAULT_TENANT, teamId, value];
      let text = "SELECT 1 FROM tax_archives WHERE tenant_id=$1 AND team_id=$2 AND "
        + column + "=$3";
      if (excludeId !== undefined) {
        params.push(excludeId);
        text += " AND id<>$4";
      }
      const rows = await sql.unsafe(text + " LIMIT 1", params as never[]);
      if ((rows as unknown as Row[]).length > 0) {
        throw httpError(409, {
          error: "conflict", code: errorCode,
          detail: "税务档案" + label + "「" + String(value) + "」在本团队已存在",
        });
      }
    });
  }
}

/** _next_code：TAX-yyyyMMdd-i（本地日期，i 从 1 试到 99；全占用 → 409）。 */
async function nextCode(env: Env, teamId: number): Promise<string> {
  const now = new Date();
  const base = "TAX-" + String(now.getFullYear())
    + String(now.getMonth() + 1).padStart(2, "0")
    + String(now.getDate()).padStart(2, "0");
  for (let i = 1; i < 100; i += 1) {
    const candidate = base + "-" + String(i);
    const rows = await withDb(env, (sql: Db) => sql.unsafe(
      "SELECT 1 FROM tax_archives WHERE tenant_id=$1 AND team_id=$2"
      + " AND code=$3 LIMIT 1",
      [DEFAULT_TENANT, teamId, candidate] as never[],
    )) as unknown as Row[];
    if (rows.length === 0) return candidate;
  }
  throw httpError(409, {
    error: "conflict", code: "CODE_GENERATION_FAILED",
    detail: "自动生成档案编码失败，请手动填写编码",
  });
}

/** _archive_or_404：tenant + id（+ 本团队过滤）；查不到一律 404（不泄露存在性）。 */
async function archiveOr404(env: Env, user: CurrentUser, archiveId: number): Promise<Row> {
  let text = "SELECT * FROM tax_archives WHERE tenant_id=$1 AND id=$2";
  const params: unknown[] = [DEFAULT_TENANT, archiveId];
  if (user.team_id !== null && user.team_id !== undefined) {
    params.push(user.team_id);
    text += " AND team_id=$3";
  }
  const rows = await withDb(env, (sql: Db) =>
    sql.unsafe(text, params as never[])) as unknown as Row[];
  const row = rows[0];
  if (!row) {
    throw httpError(404, {
      error: "not_found", code: "TAX_ARCHIVE_NOT_FOUND",
    });
  }
  return row;
}

/** _product_tax_or_404：tenant + status='active'（+ 本团队过滤）+ id；查不到一律 404。 */
async function productRateOr404(
  env: Env, user: CurrentUser, rateId: number,
): Promise<Row> {
  const where: string[] = ["tenant_id = $1", "status = 'active'"];
  const params: unknown[] = [DEFAULT_TENANT];
  if (user.team_id !== null && user.team_id !== undefined) {
    params.push(user.team_id);
    where.push("team_id = $" + String(params.length));
  }
  params.push(rateId);
  const text = "SELECT * FROM product_tax_rates WHERE " + where.join(" AND ")
    + " AND id = $" + String(params.length);
  const rows = await withDb(env, (sql: Db) =>
    sql.unsafe(text, params as never[])) as unknown as Row[];
  const row = rows[0];
  if (!row) {
    throw httpError(404, {
      error: "not_found", code: "PRODUCT_TAX_NOT_FOUND",
    });
  }
  return row;
}

// ── 三个写端点（与内核 handler 逐条对应）────────────────────────────────────

/** POST /api/v1/tax-archives（tax_archives.py:218-245）→ 201 + _row_out。 */
export async function createTaxArchiveDirect(
  c: Context,
  user: CurrentUser,
): Promise<Response> {
  const env = getEnv(c);
  const body = await parseBody(c, tax_archives_TaxArchiveCreate) as Record<string, unknown>;
  const teamId = await requireTeamContext(env, user);
  const name = normalizeName(body.name);
  const values = cleanTaxValues(body.tax_values);
  const code = normalizeCode(body.code) ?? await nextCode(env, teamId);
  await checkUnique(env, teamId, name, code);
  const effFrom = parseEffectiveDate(body.effective_from);
  const effTo = parseEffectiveDate(body.effective_to);
  const rows = await withDb(env, (sql: Db) => sql.unsafe(
    "INSERT INTO tax_archives"
    + " (tenant_id, team_id, code, name, effective_from, effective_to,"
    + "  tax_values, source, status, created_by)"
    + " VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,'active',$9)"
    + " RETURNING *",
    [DEFAULT_TENANT, teamId, code, name, effFrom, effTo,
      JSON.stringify(values), body.source ?? null, String(user.id)] as never[],
  )) as unknown as Row[];
  return c.json(taxArchiveOut(rows[0]!), 201);
}

/** PATCH /api/v1/tax-archives/{id}（tax_archives.py:248-292）→ 200 + _row_out。 */
export async function updateTaxArchiveDirect(
  c: Context,
  user: CurrentUser,
): Promise<Response> {
  const env = getEnv(c);
  const archiveId = Number(c.req.param("archive_id"));
  const body = await parseBody(c, tax_archives_TaxArchivePatch) as Record<string, unknown>;
  const teamId = await requireTeamContext(env, user);
  const row = await archiveOr404(env, user, archiveId);
  ensureArchiveTeam(row, teamId, "不能修改其他团队的税务档案");
  const fields = resolvePatch(body, row);
  await checkUnique(env, teamId, fields.name, fields.code, archiveId);
  const rows = await withDb(env, (sql: Db) => sql.unsafe(
    "UPDATE tax_archives SET name=$3, code=$4, effective_from=$5,"
    + " effective_to=$6, tax_values=$7::jsonb, source=$8, status=$9,"
    + " updated_at=now()"
    + " WHERE tenant_id=$1 AND id=$2 RETURNING *",
    [DEFAULT_TENANT, archiveId, fields.name, fields.code,
      fields.effective_from, fields.effective_to,
      JSON.stringify(fields.tax_values ?? {}), fields.source, fields.status] as never[],
  )) as unknown as Row[];
  return c.json(taxArchiveOut(rows[0]!));
}

/** DELETE /api/v1/tax-archives/{id}（tax_archives.py:295-314）→ 软删，返回 {id,status}。 */
export async function deleteTaxArchiveDirect(
  c: Context,
  user: CurrentUser,
): Promise<Response> {
  const env = getEnv(c);
  const archiveId = Number(c.req.param("archive_id"));
  const teamId = await requireTeamContext(env, user);
  const row = await archiveOr404(env, user, archiveId);
  ensureArchiveTeam(row, teamId, "不能停用其他团队的税务档案");
  await withDb(env, (sql: Db) => sql.unsafe(
    "UPDATE tax_archives SET status='inactive', updated_at=now()"
    + " WHERE tenant_id=$1 AND id=$2",
    [DEFAULT_TENANT, archiveId] as never[],
  ));
  return c.json({ id: archiveId, status: "inactive" });
}

// ── 产品税率（product_tax_rates）三个写端点（tax_archives.py:337/391/419）────

async function createProductTaxRateDirect(
  c: Context, user: CurrentUser,
): Promise<Response> {
  const env = getEnv(c);
  const body = await parseBody(c, tax_archives_ProductTaxRateIn) as Record<string, unknown>;
  const teamId = await requireTeamContext(env, user);
  const productKey = normalizeProductKey(body.product_key);
  ensureKnownProduct(productKey);
  const inputRate = validateTaxRate(body.input_vat_rate, "进项增值税率");
  const rebateRate = validateTaxRate(body.rebate_rate, "出口退税率");
  ensureAtLeastOneRate(inputRate, rebateRate);
  const existingRows = await withDb(env, (sql: Db) => sql.unsafe(
    "SELECT * FROM product_tax_rates WHERE tenant_id=$1 AND team_id=$2"
    + " AND product_key=$3 LIMIT 1",
    [DEFAULT_TENANT, teamId, productKey] as never[],
  )) as unknown as Row[];
  const existing = existingRows[0];
  if (existing !== undefined && existing.status === "active") {
    throw httpError(409, {
      error: "conflict", code: "PRODUCT_TAX_EXISTS",
      detail: "产品 " + productKey + " 已配置税率，请直接修改",
    });
  }
  if (existing !== undefined) {
    const rows = await withDb(env, (sql: Db) => sql.unsafe(
      "UPDATE product_tax_rates SET input_vat_rate=$3, rebate_rate=$4,"
      + " status='active', updated_at=now()"
      + " WHERE tenant_id=$1 AND id=$2 RETURNING *",
      [DEFAULT_TENANT, existing.id, inputRate, rebateRate] as never[],
    )) as unknown as Row[];
    return c.json(productTaxRateOut(rows[0]!), 201);
  }
  const rows = await withDb(env, (sql: Db) => sql.unsafe(
    "INSERT INTO product_tax_rates"
    + " (tenant_id, team_id, product_key, input_vat_rate, rebate_rate,"
    + "  status, created_by)"
    + " VALUES ($1,$2,$3,$4,$5,'active',$6) RETURNING *",
    [DEFAULT_TENANT, teamId, productKey, inputRate, rebateRate, String(user.id)] as never[],
  )) as unknown as Row[];
  return c.json(productTaxRateOut(rows[0]!), 201);
}

async function updateProductTaxRateDirect(
  c: Context, user: CurrentUser,
): Promise<Response> {
  const env = getEnv(c);
  const rateId = Number(c.req.param("rate_id"));
  const body = await parseBody(c, tax_archives_ProductTaxRatePatch) as Record<string, unknown>;
  await requireTeamContext(env, user);
  const row = await productRateOr404(env, user, rateId);
  const rates = resolveRatePatch(body, row);
  const rows = await withDb(env, (sql: Db) => sql.unsafe(
    "UPDATE product_tax_rates SET input_vat_rate=$3, rebate_rate=$4,"
    + " updated_at=now()"
    + " WHERE tenant_id=$1 AND id=$2 RETURNING *",
    [DEFAULT_TENANT, rateId, rates.input_vat_rate, rates.rebate_rate] as never[],
  )) as unknown as Row[];
  return c.json(productTaxRateOut(rows[0]!));
}

async function deleteProductTaxRateDirect(
  c: Context, user: CurrentUser,
): Promise<Response> {
  const env = getEnv(c);
  const rateId = Number(c.req.param("rate_id"));
  await requireTeamContext(env, user);
  await productRateOr404(env, user, rateId);
  await withDb(env, (sql: Db) => sql.unsafe(
    "UPDATE product_tax_rates SET status='inactive', updated_at=now()"
    + " WHERE tenant_id=$1 AND id=$2",
    [DEFAULT_TENANT, rateId] as never[],
  ));
  return c.json({ id: rateId, status: "inactive" });
}

// ══════════════════════════════════════════════════════════════════════════════
// 路由注册（由 src/index.ts 挂载在 /api/v1/tax-archives 透传 mount **之前**）：
// 只注册这三条写方法 —— GET 仍由 quotes-read.ts 的 tax-archives.list 管；
// off 时是**原样** forwardKernelRequest（与 createProxyApp 同一句）。
// ══════════════════════════════════════════════════════════════════════════════

const app = new Hono<{ Bindings: Env }>();

app.post("/api/v1/tax-archives", (c) => {
  if (useDirectRoute(getEnv(c), "tax-archives.create")) {
    return respond(c, async () => {
      const user = await requireUser(c);
      return directDb(c, () => createTaxArchiveDirect(c, user));
    });
  }
  return forwardKernelRequest(c);
});

app.patch("/api/v1/tax-archives/:archive_id", (c) => {
  if (useDirectRoute(getEnv(c), "tax-archives.update")) {
    return respond(c, async () => {
      const user = await requireUser(c);
      return directDb(c, () => updateTaxArchiveDirect(c, user));
    });
  }
  return forwardKernelRequest(c);
});

app.delete("/api/v1/tax-archives/:archive_id", (c) => {
  if (useDirectRoute(getEnv(c), "tax-archives.delete")) {
    return respond(c, async () => {
      const user = await requireUser(c);
      return directDb(c, () => deleteTaxArchiveDirect(c, user));
    });
  }
  return forwardKernelRequest(c);
});

app.post("/api/v1/product-tax-rates", (c) => {
  if (useDirectRoute(getEnv(c), "product-tax-rates.create")) {
    return respond(c, async () => {
      const user = await requireUser(c);
      return directDb(c, () => createProductTaxRateDirect(c, user));
    });
  }
  return forwardKernelRequest(c);
});

app.patch("/api/v1/product-tax-rates/:rate_id", (c) => {
  if (useDirectRoute(getEnv(c), "product-tax-rates.update")) {
    return respond(c, async () => {
      const user = await requireUser(c);
      return directDb(c, () => updateProductTaxRateDirect(c, user));
    });
  }
  return forwardKernelRequest(c);
});

app.delete("/api/v1/product-tax-rates/:rate_id", (c) => {
  if (useDirectRoute(getEnv(c), "product-tax-rates.delete")) {
    return respond(c, async () => {
      const user = await requireUser(c);
      return directDb(c, () => deleteProductTaxRateDirect(c, user));
    });
  }
  return forwardKernelRequest(c);
});

export default app;
