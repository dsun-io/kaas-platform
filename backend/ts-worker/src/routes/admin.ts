/**
 * KaaS TS 门面 · admin 域（11 条路由）。
 *
 * 真源逐条对齐：
 * - backend/worker/src/main.py:2824-3077（feature flag / tenants / audit-log / archive-logs）
 * - backend/worker/src/ws_admin_accounts.py:53-141（账号列表 / 停用恢复）
 * - backend/worker/src/ws_admin_proposals.py:71-187（属性沉淀提案 3 条）
 *
 * 闸门两种口径（**不可混用**，错误体形状不同，前端按 code/message 区分）：
 * - 平台运营（main.py:158 / ws_admin_proposals.py:32）= internal 账号 + 管理员角色
 *   → 403 {error:"forbidden", message:"Platform operator required"}
 * - 系统管理员（ws_admin_accounts.py:31）→ 403 {error:"forbidden"}（无 message）
 *
 * 角色判定走 rules.ts 的 isAdminRole（kaas_common.workstation.scope 镜像，TODO(TODO:TS3)）。
 */
import { Hono } from "hono";
import { z } from "zod";

import { withDb, type Db } from "../db";
import { getEnv, type Env } from "../env";
import { httpError, num, num0, parseBody, parseQuery, pyIso, respond } from "../http";
import { isAdminRole } from "../rules";
import { requireUser, type CurrentUser } from "../session";
import { ws_admin_accounts_AccountStatusIn } from "../generated/schemas";

const app = new Hono<{ Bindings: Env }>();

const DEFAULT_TENANT = "default";

type Row = Record<string, unknown>;

/** main.py:158 _require_platform_ops：internal 账号 + 管理员角色，缺一即 403。 */
function requirePlatformOps(user: CurrentUser): void {
  if (user.account_type !== "internal" || !isAdminRole(user.role)) {
    throw httpError(403, { error: "forbidden", message: "Platform operator required" });
  }
}

/** ws_admin_accounts.py:31 _require_system_admin（错误体只有 error 键）。 */
function requireSystemAdmin(user: CurrentUser): void {
  if (user.account_type !== "internal" || !isAdminRole(user.role)) {
    throw httpError(403, { error: "forbidden" });
  }
}

/** FastAPI 的 bool() 语义（字符串 "false" 也是真值 —— 与 Python 一致）。 */
function pyBool(value: unknown): boolean {
  if (typeof value === "string") return value.length > 0;
  return Boolean(value);
}

// ── feature flag / tenants / 审计（main.py）─────────────────────────────────

// GET /api/v1/admin/feature_flag（main.py:2824）
app.get("/api/v1/admin/feature_flag", (c) => respond(c, async () => {
  const user = await requireUser(c);
  requirePlatformOps(user);
  const query = parseQuery(z.object({
    tenant_id: z.string().optional(),
    flag_name: z.string().optional(),
  }), c.req.query());
  const tid = (query.tenant_id || DEFAULT_TENANT).trim() || DEFAULT_TENANT;
  if (tid !== DEFAULT_TENANT) {
    throw httpError(404, { error: "not_found", code: "TENANT_NOT_FOUND" });
  }
  const rows = await withDb(getEnv(c), (sql: Db) => sql.unsafe(
    "SELECT flag_name, flag_value FROM feature_flags WHERE tenant_id = $1",
    [DEFAULT_TENANT] as never[],
  )) as unknown as Row[];
  const flags: Record<string, boolean> = {};
  for (const row of rows) flags[String(row.flag_name)] = pyBool(row.flag_value);
  return c.json({ [DEFAULT_TENANT]: flags });
}));

// POST /api/v1/admin/feature_flag（main.py:2858；兼容后端/前端两种请求体）
app.post("/api/v1/admin/feature_flag", (c) => respond(c, async () => {
  const user = await requireUser(c);
  requirePlatformOps(user);
  const body = await parseBody(c, z.record(z.unknown()));
  const flagName = String(body.flag_name ?? body.flag_key ?? "").trim();
  if (!flagName) {
    // 注意：Python 这里 detail 是**字符串**（不是对象），逐字对齐
    throw httpError(422, "flag_name is required");
  }
  const flagValue = "flag_value" in body ? pyBool(body.flag_value) : pyBool(body.enabled ?? false);
  const tenantId = String(body.tenant_id ?? DEFAULT_TENANT).trim() || DEFAULT_TENANT;
  const result = await withDb(getEnv(c), async (sql: Db) => {
    const oldRows = await sql.unsafe(
      "SELECT flag_value FROM feature_flags WHERE tenant_id = $1 AND flag_name = $2",
      [tenantId, flagName] as never[],
    );
    const oldRow = (oldRows as unknown as Row[])[0];
    const oldValue = oldRow ? pyBool(oldRow.flag_value) : false;
    const upserted = await sql.unsafe(
      "INSERT INTO feature_flags (tenant_id, flag_name, flag_value, updated_by)"
      + " VALUES ($1, $2, $3, $4)"
      + " ON CONFLICT (tenant_id, flag_name) DO UPDATE SET"
      + " flag_value = EXCLUDED.flag_value, updated_at = now(),"
      + " updated_by = EXCLUDED.updated_by RETURNING id",
      [tenantId, flagName, flagValue, String(user.id)] as never[],
    );
    const row = (upserted as unknown as Row[])[0] as Row;
    await sql.unsafe(
      "INSERT INTO feature_flag_audit (action, actor_id, tenant_id, resource_type,"
      + " resource_id, flag_name, old_value, new_value, reason)"
      + " VALUES ('feature_flag_change', $1, $2, 'feature_flag', $3, $4, $5, $6, $7)",
      [String(user.id), tenantId, String(row.id), flagName,
        String(oldValue), String(flagValue), body.reason ?? null] as never[],
    );
    return { oldValue };
  });
  return c.json({
    tenant_id: tenantId,
    flag_name: flagName,
    old_value: result.oldValue,
    new_value: flagValue,
    flag_value: flagValue,
  });
}));

// GET /api/v1/admin/tenants（main.py:2910；单租户形态：恒 1 条，不伪造多条）
app.get("/api/v1/admin/tenants", (c) => respond(c, async () => {
  const user = await requireUser(c);
  requirePlatformOps(user);
  return c.json({
    tenants: [{ tenant_id: DEFAULT_TENANT, display_name: DEFAULT_TENANT, is_active: true }],
  });
}));

// POST /api/v1/admin/tenants/reload（main.py:2927；Worker 无 yaml，仅记审计 no-op）
app.post("/api/v1/admin/tenants/reload", (c) => respond(c, async () => {
  const user = await requireUser(c);
  requirePlatformOps(user);
  await withDb(getEnv(c), (sql: Db) => sql.unsafe(
    "INSERT INTO feature_flag_audit (action, actor_id, tenant_id, resource_type, reason)"
    + " VALUES ('tenants_reload', $1, $2, 'tenants', 'worker 单租户无 yaml，no-op 记账')",
    [String(user.id), DEFAULT_TENANT] as never[],
  ));
  return c.json({
    reloaded_count: 1,
    active_tenants: [{
      tenant_id: DEFAULT_TENANT, display_name: DEFAULT_TENANT,
      locale: "zh-CN", region: "CN", is_active: true,
    }],
  });
}));

// GET /api/v1/admin/audit-log（main.py:2956；越界钳位而非 422）
app.get("/api/v1/admin/audit-log", (c) => respond(c, async () => {
  const user = await requireUser(c);
  requirePlatformOps(user);
  const query = parseQuery(z.object({
    page: z.coerce.number().int().default(1),
    page_size: z.coerce.number().int().default(20),
    action: z.string().optional(),
    actor_id: z.string().optional(),
    resource_type: z.string().optional(),
    since: z.string().optional(),
    until: z.string().optional(),
  }), c.req.query());
  const page = Math.max(query.page, 1);
  const pageSize = Math.min(Math.max(query.page_size, 1), 100);
  const params: unknown[] = [];
  const where: string[] = [];
  const filters: Array<[string, string | undefined]> = [
    ["action", query.action],
    ["actor_id", query.actor_id],
    ["resource_type", query.resource_type],
  ];
  for (const [column, value] of filters) {
    if (value) {
      params.push(value);
      where.push(column + " = $" + String(params.length));
    }
  }
  if (query.since) {
    params.push(query.since);
    where.push("created_at >= $" + String(params.length) + "::date");
  }
  if (query.until) {
    params.push(query.until);
    where.push("created_at < ($" + String(params.length) + "::date + interval '1 day')");
  }
  const whereSql = where.length > 0 ? " WHERE " + where.join(" AND ") : "";
  const limitIdx = params.length + 1;
  const offsetIdx = params.length + 2;
  const payload = await withDb(getEnv(c), async (sql: Db) => {
    const totalRows = await sql.unsafe(
      "SELECT count(*) AS n FROM feature_flag_audit" + whereSql, params as never[],
    );
    const rows = await sql.unsafe(
      "SELECT id, action, actor_id, resource_type, resource_id, tenant_id,"
      + " flag_name, old_value, new_value, reason, created_at"
      + " FROM feature_flag_audit" + whereSql
      + " ORDER BY id DESC LIMIT $" + String(limitIdx) + " OFFSET $" + String(offsetIdx),
      [...params, pageSize, (page - 1) * pageSize] as never[],
    );
    return {
      total: num0((totalRows as unknown as Row[])[0]?.n),
      rows: rows as unknown as Row[],
    };
  });
  const items = payload.rows.map((row) => ({
    id: num(row.id),
    action: row.action,
    actor_id: row.actor_id,
    resource_type: row.resource_type,
    resource_id: row.resource_id,
    tenant_id: row.tenant_id,
    flag_key: row.flag_name,
    enabled_before: row.old_value,
    enabled_after: row.new_value,
    reason: row.reason,
    timestamp: pyIso(row.created_at),
  }));
  return c.json({ items, total: payload.total, page, page_size: pageSize });
}));

// GET /api/v1/admin/archive-logs（main.py:3024；tenant_id 恒 '*' ⇒ 不加租户过滤）
app.get("/api/v1/admin/archive-logs", (c) => respond(c, async () => {
  const user = await requireUser(c);
  requirePlatformOps(user);
  const query = parseQuery(z.object({
    page: z.coerce.number().int().default(1),
    page_size: z.coerce.number().int().default(20),
    month: z.string().optional(),
  }), c.req.query());
  const page = Math.max(query.page, 1);
  const pageSize = Math.min(Math.max(query.page_size, 1), 100);
  const month = (query.month ?? "").trim();
  let where = "WHERE TRUE";
  const args: unknown[] = [];
  if (month) {
    args.push(month);
    where += " AND month = $" + String(args.length);
  }
  const payload = await withDb(getEnv(c), async (sql: Db) => {
    const totalRows = await sql.unsafe(
      "SELECT count(*) AS n FROM events_archive_log " + where, args as never[],
    );
    const rows = await sql.unsafe(
      "SELECT id, month, minio_path, status, archived_at FROM events_archive_log " + where
      + " ORDER BY archived_at DESC, id DESC LIMIT $" + String(args.length + 1)
      + " OFFSET $" + String(args.length + 2),
      [...args, pageSize, (page - 1) * pageSize] as never[],
    );
    return {
      total: num0((totalRows as unknown as Row[])[0]?.n),
      rows: rows as unknown as Row[],
    };
  });
  const items = payload.rows.map((row) => ({
    id: String(row.id),
    month: row.month,
    path: row.minio_path,
    status: row.status,
    archived_at: pyIso(row.archived_at),
  }));
  return c.json({ items, total: payload.total, page, page_size: pageSize });
}));

// ── 账号治理（ws_admin_accounts.py）─────────────────────────────────────────

/** ws_admin_accounts.py:36 _account_out：白名单序列化（绝不含 password_hash/token）。 */
function accountOut(row: Row): Record<string, unknown> {
  const role = String(row.role ?? "");
  return {
    id: num(row.id),
    email: row.email,
    display_name: row.display_name,
    account_type: row.account_type,
    role: role === "admin" ? "system_admin" : role === "owner" ? "customer_owner"
      : role === "user" ? "customer_member" : role,
    status: row.status,
    team_id: num(row.team_id),
    team_name: row.team_name ?? null,
    console_access: Boolean(row.console_access),
    created_at: pyIso(row.created_at),
    updated_at: pyIso(row.updated_at),
  };
}

// GET /api/v1/admin/accounts（ws_admin_accounts.py:53；limit/offset 越界 422）
app.get("/api/v1/admin/accounts", (c) => respond(c, async () => {
  const user = await requireUser(c);
  requireSystemAdmin(user);
  const query = parseQuery(z.object({
    limit: z.coerce.number().int().gte(1).lte(1000).default(500),
    offset: z.coerce.number().int().gte(0).default(0),
  }), c.req.query());
  const payload = await withDb(getEnv(c), async (sql: Db) => {
    const totalRows = await sql.unsafe("SELECT count(*) AS n FROM users", [] as never[]);
    const rows = await sql.unsafe(
      "SELECT u.id, u.email, u.display_name, u.account_type, u.role, u.status,"
      + " u.team_id, u.console_access, u.created_at, u.updated_at, t.name AS team_name"
      + " FROM users u LEFT JOIN teams t ON t.id = u.team_id"
      + " ORDER BY u.id LIMIT $1 OFFSET $2",
      [query.limit, query.offset] as never[],
    );
    return {
      total: num0((totalRows as unknown as Row[])[0]?.n),
      rows: rows as unknown as Row[],
    };
  });
  return c.json({ accounts: payload.rows.map(accountOut), total: payload.total });
}));

// PATCH /api/v1/admin/accounts/{user_id}（ws_admin_accounts.py:80）
app.patch("/api/v1/admin/accounts/:user_id", (c) => respond(c, async () => {
  const user = await requireUser(c);
  requireSystemAdmin(user);
  const userId = Number(c.req.param("user_id"));
  const body = await parseBody(c, ws_admin_accounts_AccountStatusIn);
  const target = String(body.status ?? "").trim().toLowerCase();
  if (target !== "active" && target !== "disabled") {
    throw httpError(422, {
      error: "validation_error", message: "status must be active|disabled",
    });
  }
  const account = await withDb(getEnv(c), (sql: Db) => sql.begin(async (tx) => {
    const foundRows = await tx.unsafe(
      "SELECT id, email, display_name, account_type, role, status, team_id,"
      + " console_access, created_at, updated_at FROM users WHERE id=$1",
      [userId] as never[],
    );
    let row = (foundRows as unknown as Row[])[0];
    if (!row) {
      throw httpError(404, { error: "not_found" });
    }
    if (target === "disabled") {
      if (num(row.id) === user.id) {
        throw httpError(409, { error: "conflict", code: "SELF_PROTECT" });
      }
      if (row.status === "active" && isAdminRole(String(row.role))) {
        // 竞态修复：锁「全部 active 管理员行」再计数（并发禁用在 FOR UPDATE 上串行化）
        const locked = await tx.unsafe(
          "SELECT id FROM users WHERE status='active'"
          + " AND role IN ('system_admin','admin') FOR UPDATE",
          [] as never[],
        );
        if ((locked as unknown as Row[]).length <= 1) {
          throw httpError(409, { error: "conflict", code: "LAST_ADMIN" });
        }
      }
    }
    const updatedRows = await tx.unsafe(
      "UPDATE users SET status=$2, updated_at=now() WHERE id=$1"
      + " RETURNING id, email, display_name, account_type, role, status,"
      + " team_id, console_access, created_at, updated_at",
      [userId, target] as never[],
    );
    row = (updatedRows as unknown as Row[])[0] as Row;
    let teamName: unknown = null;
    if (row.team_id !== null && row.team_id !== undefined) {
      const teamRows = await tx.unsafe("SELECT name FROM teams WHERE id=$1", [row.team_id] as never[]);
      teamName = (teamRows as unknown as Row[])[0]?.name ?? null;
    }
    return { ...row, team_name: teamName };
  }));
  return c.json({ account: accountOut(account) });
}));

// ── 属性沉淀提案（ws_admin_proposals.py）────────────────────────────────────

/** ws_admin_proposals.py:41 _proposal_out。 */
function proposalOut(row: Row): Record<string, unknown> {
  const score = row.recommendation_score;
  return {
    id: num(row.id),
    tenant_id: row.tenant_id,
    category_id: row.category_id,
    proposed_name: row.proposed_name,
    proposed_type: row.proposed_type,
    group_code: row.group_code,
    status: row.status,
    occurrence_count: num(row.occurrence_count),
    recommended_for_promotion: row.recommended_for_promotion,
    recommendation_score: score === null || score === undefined ? null : Number(score),
    created_at: pyIso(row.created_at),
  };
}

/** ws_admin_proposals.py:59 _recommended_out。 */
function recommendedOut(row: Row): Record<string, unknown> {
  const score = row.recommendation_score;
  return {
    id: num(row.id),
    tenant_id: row.tenant_id,
    proposed_name: row.proposed_name,
    recommendation_score: score === null || score === undefined ? null : Number(score),
    recommended_at: pyIso(row.recommended_at),
  };
}

// GET /api/v1/admin/spec/attribute-proposals（ws_admin_proposals.py:71）
app.get("/api/v1/admin/spec/attribute-proposals", (c) => respond(c, async () => {
  const user = await requireUser(c);
  requirePlatformOps(user);
  const status = c.req.query("status");
  const rows = await withDb(getEnv(c), (sql: Db) => sql.unsafe(
    "SELECT id, tenant_id, category_id, proposed_name, proposed_type, group_code,"
    + " status, occurrence_count, recommended_for_promotion, recommendation_score,"
    + " created_at FROM attribute_proposals"
    + " WHERE ($1::text IS NULL OR status = $1) ORDER BY created_at DESC",
    [status ?? null] as never[],
  )) as unknown as Row[];
  return c.json({ items: rows.map(proposalOut) });
}));

// GET /api/v1/admin/spec/attribute-proposals/recommended（ws_admin_proposals.py:91）
app.get("/api/v1/admin/spec/attribute-proposals/recommended", (c) => respond(c, async () => {
  const user = await requireUser(c);
  requirePlatformOps(user);
  const rows = await withDb(getEnv(c), (sql: Db) => sql.unsafe(
    "SELECT id, tenant_id, proposed_name, recommendation_score, recommended_at"
    + " FROM attribute_proposals WHERE recommended_for_promotion IS TRUE AND status = 'pending'"
    + " ORDER BY recommendation_score DESC",
    [] as never[],
  )) as unknown as Row[];
  return c.json({ items: rows.map(recommendedOut) });
}));

// PATCH /api/v1/admin/spec/attribute-proposals/{proposal_id}（ws_admin_proposals.py:108）
// 注意：Python 侧「提案不存在 / 非法 action」是 **200 + {error:...}**，不是 4xx —— 逐字对齐。
app.patch("/api/v1/admin/spec/attribute-proposals/:proposal_id", (c) => respond(c, async () => {
  const user = await requireUser(c);
  requirePlatformOps(user);
  const proposalId = Number(c.req.param("proposal_id"));
  const body = await parseBody(c, z.record(z.unknown()));
  const action = body.action;
  const reviewNote = body.note ?? null;
  const reviewer = String(user.id);
  const result = await withDb(getEnv(c), (sql: Db) => sql.begin(async (tx) => {
    const proposalRows = await tx.unsafe(
      "SELECT id, proposed_name, proposed_type, group_code, proposed_unit,"
      + " proposed_unit_group, private_attribute_id FROM attribute_proposals WHERE id=$1",
      [proposalId] as never[],
    );
    const proposal = (proposalRows as unknown as Row[])[0];
    if (!proposal) {
      return { error: "not_found" };
    }
    if (action === "approve") {
      const code = body.code
        ? String(body.code)
        : String(proposal.proposed_name ?? "").toLowerCase().replace(/ /g, "_");
      const inserted = await tx.unsafe(
        "INSERT INTO spec_attributes (code, name, aliases, group_code, data_type,"
        + " unit, unit_group, scope, source, status, promoted_from, created_by)"
        + " VALUES ($1, $2, '[]'::jsonb, $3, $4, $5, $6, 'public', 'promoted', 'active',"
        + " $7, $8) RETURNING id",
        [code, proposal.proposed_name, proposal.group_code, proposal.proposed_type,
          proposal.proposed_unit, proposal.proposed_unit_group,
          proposal.private_attribute_id, reviewer] as never[],
      );
      const newAttributeId = (inserted as unknown as Row[])[0]?.id ?? null;
      await tx.unsafe(
        "UPDATE attribute_proposals SET status='promoted', reviewer=$2, review_note=$3,"
        + " reviewed_at=now(), promoted_attribute_id=$4 WHERE id=$1",
        [proposalId, reviewer, reviewNote, newAttributeId] as never[],
      );
      return {
        id: proposalId, status: "promoted", promoted_attribute_id: num(newAttributeId),
      };
    }
    if (action === "reject") {
      await tx.unsafe(
        "UPDATE attribute_proposals SET status='rejected', reviewer=$2, review_note=$3,"
        + " reviewed_at=now() WHERE id=$1",
        [proposalId, reviewer, reviewNote] as never[],
      );
      return { id: proposalId, status: "rejected" };
    }
    if (action === "merge") {
      const targetId = body.target_attribute_id;
      if (!targetId) {
        return { error: "target_attribute_id required for merge" };
      }
      await tx.unsafe(
        "UPDATE attribute_proposals SET status='merged', reviewer=$2, review_note=$3,"
        + " reviewed_at=now(), promoted_attribute_id=$4 WHERE id=$1",
        [proposalId, reviewer, reviewNote, targetId] as never[],
      );
      return { id: proposalId, status: "merged", merged_into: targetId };
    }
    return { error: "invalid_action" };
  }));
  return c.json(result);
}));

export default app;
