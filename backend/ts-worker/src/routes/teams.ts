/**
 * KaaS TS 门面 · teams 域（15 条路由）。
 *
 * 真源逐条对齐：
 * - backend/worker/src/ws_teams.py（团队/成员/邀请/转让/console-access 12 条）
 * - backend/worker/src/ws_workstations.py:140-218（团队订阅 3 条）
 *
 * 铁纪律：团队名称校验、邀请码生成/规范化/状态、团队管理员判定、转让目标校验
 * 全部来自 kaas_common/workstation/{teams,scope,subscriptions}.py。
 * 内核当前**没有** /internal/rules/* 端点（见 rules.ts 头注释），因此本域复用
 * rules.ts 的逐行镜像（TODO(TODO:TS3) 待内核暴露后切 KERNEL binding），
 * 本文件不重写任何判定，只做 SQL 接线/鉴权/协议转换。
 */
import { Hono } from "hono";
import { z } from "zod";

import { withDb, type Db, type Tx } from "../db";
import { getEnv, type Env } from "../env";
import { bool, httpError, num, num0, parseBody, parseQuery, pyIso, respond } from "../http";
import {
  allWorkstations,
  canTransitionApplication,
  FULL_CHAIN,
  generateInviteToken,
  INVITE_TTL_DAYS,
  inviteState,
  isAdminRole,
  isTeamAdmin,
  JOIN_APPLICATION_STATUS,
  normalizeInviteToken,
  resolveSignupWorkstations,
  RuleError,
  validateRejectReason,
  validateTeamName,
  validateTransferTarget,
} from "../rules";
import { inviteOut, subOut, subSetOut, teamOut } from "../serializers";
import { requireUser, type CurrentUser } from "../session";

const app = new Hono<{ Bindings: Env }>();

const DEFAULT_TENANT = "default";
const TOKEN_RETRY = 5;

type Row = Record<string, unknown>;

// ── 公共错误/判定（真源 ws_teams.py:_conflict / _rule_422 / _require_team_admin）──

function conflict(code: string, message: string) {
  return httpError(409, { error: "conflict", code, message });
}

function rule422(error: RuleError): never {
  throw httpError(422, { error: "validation", code: error.code, detail: error.detail });
}

/** 团队输出共用（ws_teams.py:_team_out 逐键对齐；序列化在 serializers.ts）。 */
function teamOutOf(team: Row, user: CurrentUser, memberCount: number): Record<string, unknown> {
  return teamOut(team, user, memberCount);
}

/** 团队管理员（团队创建者）或平台管理员才可管理该团队（ws_teams.py:104-109）。 */
function requireTeamAdmin(
  team: Row,
  user: CurrentUser,
  message = "仅团队管理员可管理该团队",
): void {
  if (!isTeamAdmin(team.created_by, user.id, user.role)) {
    throw httpError(403, { error: "forbidden", code: "NOT_TEAM_ADMIN", message });
  }
}

/** ws_teams.py:_team_or_404（按 tenant_id + id；不存在一律 404，不泄露存在性）。 */
async function teamOr404(sql: Db | Tx, teamId: number): Promise<Row> {
  const rows = await sql`
    SELECT * FROM teams WHERE tenant_id=${DEFAULT_TENANT} AND id=${teamId}`;
  const row = rows[0] as Row | undefined;
  if (!row) {
    throw httpError(404, { error: "not_found", code: "TEAM_NOT_FOUND" });
  }
  return row;
}

/** ws_teams.py:_member_count（users.team_id 计数）。 */
async function memberCount(sql: Db | Tx, teamId: number): Promise<number> {
  const rows = await sql`SELECT count(*) FROM users WHERE team_id=${teamId}`;
  return num0((rows[0] as Row | undefined)?.count);
}

/** ws_teams.py:_insert_invite（撞唯一约束重试；24 位字母表，撞码概率可忽略）。 */
async function insertInvite(
  tx: Tx,
  teamId: number,
  email: string | null,
  user: CurrentUser,
): Promise<Row> {
  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);
  for (let attempt = 0; attempt < TOKEN_RETRY; attempt += 1) {
    const token = generateInviteToken();
    try {
      const rows = await tx`
        INSERT INTO team_invites
               (tenant_id, team_id, email, token, invited_by, status, expires_at)
        VALUES (${DEFAULT_TENANT}, ${teamId}, ${email}, ${token}, ${user.id}, 'pending', ${expiresAt})
        RETURNING id, token, email, status, created_at, expires_at`;
      return rows[0] as Row;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes("uq_team_invites_token") && !message.includes("duplicate key")) {
        throw err;
      }
    }
  }
  throw httpError(500, {
    error: "internal_error", code: "INVITE_TOKEN_GENERATION_FAILED",
  });
}

// ── 订阅辅助（ws_workstations.py:46-118）────────────────────────────────────

/** 生效工位编码全集 = 全部工位 + full_chain（ws_workstations.py:_known_codes）。 */
function knownSubscriptionCodes(): string[] {
  return [...new Set([...allWorkstations(), FULL_CHAIN])].sort();
}

/** ws_workstations.py:_validate_code（未知工位 422，detail 文案逐字对齐）。 */
function validateSubscriptionCode(code: string): string {
  const text = (code ?? "").trim().toLowerCase();
  if (!new Set(knownSubscriptionCodes()).has(text)) {
    throw httpError(422, {
      error: "validation", code: "UNKNOWN_WORKSTATION",
      detail: `未知工位：${code}；可选：${knownSubscriptionCodes().join(", ")}`,
    });
  }
  return text;
}

/** ws_workstations.py:_parse_expires（ISO 时间；非法 422 INVALID_EXPIRES_AT）。 */
function parseExpires(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value.replace("Z", "+00:00"));
  if (Number.isNaN(parsed.getTime())) {
    throw httpError(422, {
      error: "validation", code: "INVALID_EXPIRES_AT",
      detail: "expires_at 需为 ISO 时间，如 2026-12-31T00:00:00+08:00",
    });
  }
  return parsed;
}

/** 订阅管理闸门（ws_workstations.py:_require_team_admin：404 先于 403）。 */
async function subscriptionTeamOr403(
  sql: Db | Tx,
  teamId: number,
  user: CurrentUser,
): Promise<Row> {
  const rows = await sql`
    SELECT * FROM teams WHERE id=${teamId} AND tenant_id=${DEFAULT_TENANT}`;
  const team = rows[0] as Row | undefined;
  if (!team) {
    throw httpError(404, { error: "not_found", code: "TEAM_NOT_FOUND" });
  }
  if (!isTeamAdmin(team.created_by, user.id, user.role)) {
    throw httpError(403, {
      error: "forbidden", code: "NOT_TEAM_ADMIN",
      message: "仅团队管理员可管理该团队的工位开通",
    });
  }
  return team;
}

// ── 入参 schema（pydantic 模型逐字段对齐；TODO(TODO:TS1) 改代码生成）──────────

const teamCreateSchema = z.object({
  name: z.string(),
  workstations: z.array(z.string()).nullish(),
});

const teamPatchSchema = z.object({ name: z.string() });
const inviteCreateSchema = z.object({ email: z.string().nullish() });
const joinSchema = z.object({ token: z.string() });
const transferSchema = z.object({ user_id: z.coerce.number().int() });
const consoleAccessSchema = z.object({ allowed: z.boolean() });
const subscriptionSchema = z.object({
  active: z.boolean().default(true),
  expires_at: z.string().nullish(),
});

const teamIdParam = z.object({ team_id: z.coerce.number().int() });
const memberParam = z.object({
  team_id: z.coerce.number().int(),
  user_id: z.coerce.number().int(),
});
const inviteParam = z.object({
  team_id: z.coerce.number().int(),
  invite_id: z.coerce.number().int(),
});
const applicationParam = z.object({
  team_id: z.coerce.number().int(),
  application_id: z.coerce.number().int(),
});
const applicationIdParam = z.object({ application_id: z.coerce.number().int() });
const applicationRejectSchema = z.object({ reason: z.string().nullish() });
const subscriptionParam = z.object({
  team_id: z.coerce.number().int(),
  code: z.string(),
});

// ── 团队 ────────────────────────────────────────────────────────────────────

// POST /api/v1/teams（ws_teams.py:160-196，201）
app.post("/api/v1/teams", (c) => respond(c, async () => {
  const user = await requireUser(c);
  const body = await parseBody(c, teamCreateSchema);
  if (user.team_id !== null) {
    throw conflict("ALREADY_IN_TEAM", "你已属于一个团队，不能再创建团队");
  }
  let name: string;
  try {
    name = validateTeamName(body.name);
  } catch (err) {
    if (err instanceof RuleError) rule422(err);
    throw err;
  }
  const result = await withDb(getEnv(c), (sql) => sql.begin(async (tx) => {
    const exists = await tx`
      SELECT 1 FROM teams WHERE tenant_id=${DEFAULT_TENANT} AND name=${name}`;
    if (exists.length > 0) {
      throw conflict("TEAM_NAME_TAKEN", `已存在同名团队「${name}」`);
    }
    const inserted = await tx`
      INSERT INTO teams (tenant_id, name, created_by) VALUES (${DEFAULT_TENANT}, ${name}, ${user.id})
      RETURNING *`;
    const team = inserted[0] as Row;
    await tx`
      UPDATE users SET team_id=${num(team.id)}, updated_at=now() WHERE id=${user.id}`;
    let chosen: string[];
    try {
      chosen = resolveSignupWorkstations(body.workstations);
    } catch (err) {
      if (err instanceof RuleError) rule422(err);
      throw err;
    }
    for (const ws of chosen) {
      await tx`
        INSERT INTO team_subscriptions (team_id, code, active, source)
        VALUES (${num(team.id)}, ${ws}, true, 'signup')
        ON CONFLICT (team_id, code) DO UPDATE SET
          active = true, source = 'signup', updated_at = now()`;
    }
    return { team, chosen };
  }));
  return c.json({ ...teamOutOf(result.team, user, 1), workstations: result.chosen }, 201);
}));

// GET /api/v1/teams/me（ws_teams.py:221-243；刻意不按 tenant_id 过滤）
app.get("/api/v1/teams/me", (c) => respond(c, async () => {
  const user = await requireUser(c);
  const payload = await withDb(getEnv(c), async (sql) => {
    const rows = await sql`
      SELECT t.* FROM teams t JOIN users u ON u.team_id = t.id WHERE u.id=${user.id}`;
    const team = rows[0] as Row | undefined;
    if (!team) {
      return { team: null, is_admin: false, member_count: 0 };
    }
    const count = await memberCount(sql, num(team.id) as number);
    return {
      team: teamOutOf(team, user, count),
      is_admin: isTeamAdmin(team.created_by, user.id, user.role),
      member_count: count,
    };
  });
  return c.json(payload);
}));

// GET /api/v1/teams（ws_teams.py:246-305；仅平台运营：internal + 管理员）
app.get("/api/v1/teams", (c) => respond(c, async () => {
  const user = await requireUser(c);
  if (user.account_type !== "internal" || !isAdminRole(user.role)) {
    throw httpError(403, {
      error: "forbidden", code: "ADMIN_ONLY",
      message: "仅平台管理员可查看全部团队",
    });
  }
  const payload = await withDb(getEnv(c), async (sql) => {
    const rows = await sql`
      SELECT t.id, t.name, t.created_by, t.created_at,
             cu.email AS created_by_email,
             cu.display_name AS created_by_name,
             (SELECT count(*) FROM users m WHERE m.team_id = t.id) AS member_count,
             count(ts.code) AS workstation_count,
             coalesce(array_agg(ts.code ORDER BY ts.code)
                      FILTER (WHERE ts.code IS NOT NULL),
                      ARRAY[]::text[]) AS workstation_codes
        FROM teams t
        LEFT JOIN users cu ON cu.id = t.created_by
        LEFT JOIN team_subscriptions ts
               ON ts.team_id = t.id AND ts.active
       WHERE t.tenant_id = ${DEFAULT_TENANT}
       GROUP BY t.id, t.name, t.created_by, t.created_at,
                cu.email, cu.display_name
       ORDER BY t.created_at, t.id`;
    const items = (rows as Row[]).map((row) => ({
      id: num(row.id),
      name: row.name,
      created_by: num(row.created_by),
      created_by_email: row.created_by_email ?? null,
      created_by_name: row.created_by_name ?? null,
      member_count: num0(row.member_count),
      workstation_count: num0(row.workstation_count),
      workstation_codes: (row.workstation_codes as string[] | null) ?? [],
      created_at: pyIso(row.created_at),
    }));
    return { items, total: items.length };
  });
  return c.json(payload);
}));

// PATCH /api/v1/teams/{team_id}（ws_teams.py:308-332）
app.patch("/api/v1/teams/:team_id", (c) => respond(c, async () => {
  const user = await requireUser(c);
  const { team_id: teamId } = parseQuery(teamIdParam, c.req.param(), "path");
  const body = await parseBody(c, teamPatchSchema);
  let name: string;
  try {
    name = validateTeamName(body.name);
  } catch (err) {
    if (err instanceof RuleError) rule422(err);
    throw err;
  }
  const payload = await withDb(getEnv(c), (sql) => sql.begin(async (tx) => {
    const team = await teamOr404(tx, teamId);
    requireTeamAdmin(team, user);
    const taken = await tx`
      SELECT 1 FROM teams WHERE tenant_id=${DEFAULT_TENANT} AND name=${name} AND id<>${teamId}`;
    if (taken.length > 0) {
      throw conflict("TEAM_NAME_TAKEN", `已存在同名团队「${name}」`);
    }
    const updated = await tx`
      UPDATE teams SET name=${name}, updated_at=now() WHERE id=${teamId} RETURNING *`;
    const row = updated[0] as Row;
    const count = await memberCount(tx, teamId);
    return teamOutOf(row, user, count);
  }));
  return c.json(payload);
}));

// GET /api/v1/teams/{team_id}/members（ws_teams.py:335-352）
app.get("/api/v1/teams/:team_id/members", (c) => respond(c, async () => {
  const user = await requireUser(c);
  const { team_id: teamId } = parseQuery(teamIdParam, c.req.param(), "path");
  const payload = await withDb(getEnv(c), async (sql) => {
    const team = await teamOr404(sql, teamId);
    requireTeamAdmin(team, user);
    const rows = await sql`
      SELECT id, email, display_name, role FROM users WHERE team_id=${teamId} ORDER BY id`;
    const items = (rows as Row[]).map((r) => ({
      user_id: r.id,
      email: r.email,
      display_name: r.display_name,
      role: r.role,
      is_admin: isTeamAdmin(team.created_by, r.id, r.role as string | null),
    }));
    return { items, total: items.length };
  });
  return c.json(payload);
}));

// DELETE /api/v1/teams/{team_id}/members/{user_id}（ws_teams.py:355-380）
app.delete("/api/v1/teams/:team_id/members/:user_id", (c) => respond(c, async () => {
  const user = await requireUser(c);
  const { team_id: teamId, user_id: userId } = parseQuery(memberParam, c.req.param(), "path");
  const payload = await withDb(getEnv(c), (sql) => sql.begin(async (tx) => {
    const team = await teamOr404(tx, teamId);
    requireTeamAdmin(team, user);
    if (String(team.created_by) === String(userId)) {
      throw conflict("CANNOT_REMOVE_SELF", "不能移除团队管理员本人");
    }
    const removed = await tx`
      UPDATE users SET team_id=NULL, updated_at=now()
       WHERE id=${userId} AND team_id=${teamId} RETURNING id`;
    if (removed.length === 0) {
      throw httpError(404, { error: "not_found", code: "MEMBER_NOT_FOUND" });
    }
    return { removed: true, user_id: userId };
  }));
  return c.json(payload);
}));

// ── 邀请 ────────────────────────────────────────────────────────────────────

// POST /api/v1/teams/{team_id}/invites（ws_teams.py:385-419；发码 201 / 邮箱直入 200）
app.post("/api/v1/teams/:team_id/invites", (c) => respond(c, async () => {
  const user = await requireUser(c);
  const { team_id: teamId } = parseQuery(teamIdParam, c.req.param(), "path");
  const body = await parseBody(c, inviteCreateSchema);
  const email = (body.email ?? "").trim().toLowerCase() || null;
  const payload = await withDb(getEnv(c), (sql) => sql.begin(async (tx) => {
    const team = await teamOr404(tx, teamId);
    requireTeamAdmin(team, user);
    if (email !== null) {
      const target = await tx`
        SELECT id, team_id FROM users WHERE lower(email)=${email}`;
      const targetRow = target[0] as Row | undefined;
      if (targetRow) {
        if (targetRow.team_id !== null && targetRow.team_id !== undefined) {
          throw conflict("ALREADY_IN_TEAM", `${email} 已属于一个团队`);
        }
        await tx`
          UPDATE users SET team_id=${teamId}, updated_at=now() WHERE id=${num(targetRow.id)}`;
        return { status: 200 as const, body: { joined: true, user_id: num(targetRow.id), email } };
      }
    }
    const invite = await insertInvite(tx, teamId, email, user);
    return {
      status: 201 as const,
      body: { joined: false, invite_id: num(invite.id), token: invite.token, email },
    };
  }));
  return c.json(payload.body, payload.status);
}));

// GET /api/v1/teams/{team_id}/invites（ws_teams.py:422-436）
app.get("/api/v1/teams/:team_id/invites", (c) => respond(c, async () => {
  const user = await requireUser(c);
  const { team_id: teamId } = parseQuery(teamIdParam, c.req.param(), "path");
  const payload = await withDb(getEnv(c), async (sql) => {
    const team = await teamOr404(sql, teamId);
    requireTeamAdmin(team, user);
    const rows = await sql`
      SELECT id, email, token, status, created_at, expires_at, accepted_at, accepted_by
        FROM team_invites WHERE team_id=${teamId} ORDER BY id DESC`;
    const items = (rows as Row[]).map(inviteOut);
    return { items, total: items.length };
  });
  return c.json(payload);
}));

// DELETE /api/v1/teams/{team_id}/invites/{invite_id}（ws_teams.py:439-457）
app.delete("/api/v1/teams/:team_id/invites/:invite_id", (c) => respond(c, async () => {
  const user = await requireUser(c);
  const { team_id: teamId, invite_id: inviteId } = parseQuery(inviteParam, c.req.param(), "path");
  const payload = await withDb(getEnv(c), (sql) => sql.begin(async (tx) => {
    const team = await teamOr404(tx, teamId);
    requireTeamAdmin(team, user);
    const row = await tx`
      UPDATE team_invites SET status='revoked'
       WHERE id=${inviteId} AND team_id=${teamId} RETURNING id`;
    if (row.length === 0) {
      throw httpError(404, { error: "not_found", code: "INVITE_NOT_FOUND" });
    }
    return { revoked: true, id: inviteId };
  }));
  return c.json(payload);
}));

// POST /api/v1/teams/join（ws_teams.py:460-501；注册后凭码入队，同样适用于已登录账号）
app.post("/api/v1/teams/join", (c) => respond(c, async () => {
  const user = await requireUser(c);
  const body = await parseBody(c, joinSchema);
  if (user.team_id !== null) {
    throw conflict("ALREADY_IN_TEAM", "你已属于一个团队");
  }
  const token = normalizeInviteToken(body.token);
  if (!token) {
    throw httpError(422, {
      error: "validation", code: "INVALID_INVITE_TOKEN", detail: "邀请码不能为空",
    });
  }
  const payload = await withDb(getEnv(c), (sql) => sql.begin(async (tx) => {
    const rows = await tx`SELECT * FROM team_invites WHERE token=${token}`;
    const invite = (rows[0] as Row | undefined) ?? null;
    const state = inviteState(invite);
    if (state === "not_found") {
      throw httpError(404, { error: "not_found", code: "INVITE_NOT_FOUND" });
    }
    if (state === "revoked") {
      throw httpError(410, { error: "gone", code: "INVITE_REVOKED" });
    }
    if (state === "used") {
      throw conflict("INVITE_ALREADY_USED", "该邀请码已被使用");
    }
    if (state === "expired") {
      throw httpError(410, { error: "gone", code: "INVITE_EXPIRED" });
    }
    const team = await teamOr404(tx, num((invite as Row).team_id) as number);
    await tx`
      UPDATE users SET team_id=${num(team.id)}, updated_at=now() WHERE id=${user.id}`;
    await tx`
      UPDATE team_invites SET status='accepted', accepted_at=now(), accepted_by=${user.id}
       WHERE id=${num((invite as Row).id)}`;
    const count = await memberCount(tx, num(team.id) as number);
    return { joined: true, team: teamOutOf(team, user, count) };
  }));
  return c.json(payload);
}));

// ── 加入申请（ws_join_applications.py，2026-10-22） ─────────────────────────

/** 申请输出（ws_join_applications.py:_application_out 逐键对齐）。 */
function applicationOut(row: Row): Record<string, unknown> {
  return {
    id: num(row.id),
    team_id: num(row.team_id),
    team_name: row.team_name ?? null,
    user_id: num(row.user_id),
    email: row.email,
    display_name: row.display_name,
    message: row.message ?? null,
    status: row.status,
    reject_reason: row.reject_reason ?? null,
    reviewed_by: num(row.reviewed_by),
    reviewed_at: pyIso(row.reviewed_at),
    created_at: pyIso(row.created_at),
  };
}

// GET /api/v1/teams/check-name（公开：注册页查重，只返回布尔，不暴露团队列表）
app.get("/api/v1/teams/check-name", (c) => respond(c, async () => {
  let normalized: string;
  try {
    normalized = validateTeamName(c.req.query("name") ?? "");
  } catch (err) {
    if (err instanceof RuleError) rule422(err);
    throw err;
  }
  const payload = await withDb(getEnv(c), async (sql) => {
    const rows = await sql`
      SELECT 1 FROM teams WHERE tenant_id=${DEFAULT_TENANT} AND name=${normalized}`;
    return { name: normalized, exists: rows.length > 0 };
  });
  return c.json(payload);
}));

// GET /api/v1/teams/{team_id}/join-applications?status=（ws_join_applications.py:list_applications）
app.get("/api/v1/teams/:team_id/join-applications", (c) => respond(c, async () => {
  const user = await requireUser(c);
  const { team_id: teamId } = parseQuery(teamIdParam, c.req.param(), "path");
  const status = c.req.query("status") ?? "pending";
  if (status !== "all" && !(JOIN_APPLICATION_STATUS as readonly string[]).includes(status)) {
    throw httpError(422, {
      error: "validation", code: "INVALID_STATUS",
      detail: "status 只能是 pending/all/" + JOIN_APPLICATION_STATUS.join("/"),
    });
  }
  const payload = await withDb(getEnv(c), async (sql) => {
    const team = await teamOr404(sql, teamId);
    requireTeamAdmin(team, user);
    const rows = status === "all"
      ? await sql`
          SELECT * FROM team_join_applications WHERE team_id=${teamId}
           ORDER BY (status = 'pending') DESC, id DESC`
      : await sql`
          SELECT * FROM team_join_applications WHERE team_id=${teamId} AND status=${status}
           ORDER BY id DESC`;
    const items = (rows as Row[]).map(applicationOut);
    return { items, total: items.length };
  });
  return c.json(payload);
}));

// POST /api/v1/teams/{team_id}/join-applications/{id}/approve（ws_join_applications.py:approve）
app.post("/api/v1/teams/:team_id/join-applications/:application_id/approve", (c) => respond(c, async () => {
  const user = await requireUser(c);
  const { team_id: teamId, application_id: applicationId } =
    parseQuery(applicationParam, c.req.param(), "path");
  const payload = await withDb(getEnv(c), (sql) => sql.begin(async (tx) => {
    const team = await teamOr404(tx, teamId);
    requireTeamAdmin(team, user);
    const rows = await tx`
      SELECT * FROM team_join_applications WHERE id=${applicationId} FOR UPDATE`;
    const row = (rows[0] as Row | undefined) ?? null;
    if (!row || num(row.team_id) !== teamId) {
      throw httpError(404, { error: "not_found", code: "APPLICATION_NOT_FOUND" });
    }
    if (!canTransitionApplication(row.status as string | null, "approved")) {
      throw conflict("APPLICATION_ALREADY_REVIEWED", "该申请已被处理，不能重复审核");
    }
    const targetRows = await tx`SELECT id, team_id FROM users WHERE id=${num(row.user_id)}`;
    const target = targetRows[0] as Row | undefined;
    if (!target) {
      throw httpError(404, { error: "not_found", code: "USER_NOT_FOUND" });
    }
    if (target.team_id !== null && target.team_id !== undefined) {
      throw conflict("ALREADY_IN_TEAM", "该申请人已属于一个团队，不能重复入团");
    }
    await tx`
      UPDATE users SET team_id=${teamId}, updated_at=now() WHERE id=${num(target.id)}`;
    const updated = await tx`
      UPDATE team_join_applications
         SET status='approved', reviewed_by=${user.id}, reviewed_at=now(), updated_at=now()
       WHERE id=${applicationId} RETURNING *`;
    const count = await memberCount(tx, teamId);
    return { approved: true, application: applicationOut(updated[0] as Row), member_count: count };
  }));
  return c.json(payload);
}));

// POST /api/v1/teams/{team_id}/join-applications/{id}/reject（ws_join_applications.py:reject）
app.post("/api/v1/teams/:team_id/join-applications/:application_id/reject", (c) => respond(c, async () => {
  const user = await requireUser(c);
  const { team_id: teamId, application_id: applicationId } =
    parseQuery(applicationParam, c.req.param(), "path");
  const body = await parseBody(c, applicationRejectSchema);
  let reason: string | null;
  try {
    reason = validateRejectReason(body.reason);
  } catch (err) {
    if (err instanceof RuleError) rule422(err);
    throw err;
  }
  const payload = await withDb(getEnv(c), (sql) => sql.begin(async (tx) => {
    const team = await teamOr404(tx, teamId);
    requireTeamAdmin(team, user);
    const rows = await tx`
      SELECT * FROM team_join_applications WHERE id=${applicationId} FOR UPDATE`;
    const row = (rows[0] as Row | undefined) ?? null;
    if (!row || num(row.team_id) !== teamId) {
      throw httpError(404, { error: "not_found", code: "APPLICATION_NOT_FOUND" });
    }
    if (!canTransitionApplication(row.status as string | null, "rejected")) {
      throw conflict("APPLICATION_ALREADY_REVIEWED", "该申请已被处理，不能重复审核");
    }
    const updated = await tx`
      UPDATE team_join_applications
         SET status='rejected', reviewed_by=${user.id}, reviewed_at=now(),
             reject_reason=${reason}, updated_at=now()
       WHERE id=${applicationId} RETURNING *`;
    return { rejected: true, application: applicationOut(updated[0] as Row) };
  }));
  return c.json(payload);
}));

// GET /api/v1/me/join-application（ws_join_applications.py:my_join_application）
app.get("/api/v1/me/join-application", (c) => respond(c, async () => {
  const user = await requireUser(c);
  const payload = await withDb(getEnv(c), async (sql) => {
    const rows = await sql`
      SELECT a.*, t.name AS team_name
        FROM team_join_applications a JOIN teams t ON t.id = a.team_id
       WHERE a.user_id=${user.id} ORDER BY a.id DESC LIMIT 1`;
    return { application: rows.length > 0 ? applicationOut(rows[0] as Row) : null };
  });
  return c.json(payload);
}));

// POST /api/v1/join-applications/{id}/cancel（ws_join_applications.py:cancel_application）
app.post("/api/v1/join-applications/:application_id/cancel", (c) => respond(c, async () => {
  const user = await requireUser(c);
  const { application_id: applicationId } =
    parseQuery(applicationIdParam, c.req.param(), "path");
  const payload = await withDb(getEnv(c), (sql) => sql.begin(async (tx) => {
    const rows = await tx`
      SELECT * FROM team_join_applications WHERE id=${applicationId} FOR UPDATE`;
    const row = (rows[0] as Row | undefined) ?? null;
    // 非本人访问一律 404（不暴露"这条申请存在但不属于你"）
    if (!row || num(row.user_id) !== user.id) {
      throw httpError(404, { error: "not_found", code: "APPLICATION_NOT_FOUND" });
    }
    if (!canTransitionApplication(row.status as string | null, "canceled")) {
      throw conflict("APPLICATION_ALREADY_REVIEWED", "该申请已被处理，无法撤回");
    }
    const updated = await tx`
      UPDATE team_join_applications SET status='canceled', updated_at=now()
       WHERE id=${applicationId} RETURNING *`;
    const out = applicationOut(updated[0] as Row);
    const trows = await tx`SELECT name FROM teams WHERE id=${num(out.team_id)}`;
    const trow = trows[0] as Row | undefined;
    if (trow) out.team_name = trow.name;
    return { canceled: true, application: out };
  }));
  return c.json(payload);
}));

// POST /api/v1/teams/{team_id}/transfer（ws_teams.py:507-544）
app.post("/api/v1/teams/:team_id/transfer", (c) => respond(c, async () => {
  const user = await requireUser(c);
  const { team_id: teamId } = parseQuery(teamIdParam, c.req.param(), "path");
  const body = await parseBody(c, transferSchema);
  const payload = await withDb(getEnv(c), async (sql) => {
    const team = await teamOr404(sql, teamId);
    requireTeamAdmin(team, user);
    const rows = await sql`SELECT id FROM users WHERE team_id=${teamId}`;
    try {
      validateTransferTarget({
        targetUserId: body.user_id,
        currentOwnerId: team.created_by,
        memberUserIds: (rows as Row[]).map((r) => r.id),
      });
    } catch (err) {
      if (err instanceof RuleError) rule422(err);
      throw err;
    }
    await sql`
      UPDATE teams SET created_by=${body.user_id} WHERE tenant_id=${DEFAULT_TENANT} AND id=${teamId}`;
    team.created_by = body.user_id;
    const count = await memberCount(sql, teamId);
    return teamOutOf(team, user, count);
  });
  return c.json(payload);
}));

// PUT /api/v1/teams/{team_id}/members/{user_id}/console-access（ws_teams.py:547-571）
app.put("/api/v1/teams/:team_id/members/:user_id/console-access", (c) => respond(c, async () => {
  const user = await requireUser(c);
  const { team_id: teamId, user_id: userId } = parseQuery(memberParam, c.req.param(), "path");
  const body = await parseBody(c, consoleAccessSchema);
  const payload = await withDb(getEnv(c), (sql) => sql.begin(async (tx) => {
    const team = await teamOr404(tx, teamId);
    requireTeamAdmin(team, user);
    const rows = await tx`
      UPDATE users SET console_access=${body.allowed}, updated_at=now()
       WHERE id=${userId} AND team_id=${teamId} RETURNING id, console_access`;
    const row = rows[0] as Row | undefined;
    if (!row) {
      throw httpError(404, { error: "not_found", code: "MEMBER_NOT_FOUND" });
    }
    return { user_id: num(row.id), console_access: bool(row.console_access) };
  }));
  return c.json(payload);
}));

// ── 团队订阅（ws_workstations.py:140-218）───────────────────────────────────

// GET /api/v1/teams/{team_id}/subscriptions
app.get("/api/v1/teams/:team_id/subscriptions", (c) => respond(c, async () => {
  const user = await requireUser(c);
  const { team_id: teamId } = parseQuery(teamIdParam, c.req.param(), "path");
  const payload = await withDb(getEnv(c), async (sql) => {
    await subscriptionTeamOr403(sql, teamId, user);
    const rows = await sql`
      SELECT * FROM team_subscriptions WHERE team_id=${teamId} ORDER BY code`;
    const items = (rows as Row[]).map(subOut);
    return { items, total: items.length };
  });
  return c.json(payload);
}));

// PUT /api/v1/teams/{team_id}/subscriptions/{code}（幂等 upsert）
app.put("/api/v1/teams/:team_id/subscriptions/:code", (c) => respond(c, async () => {
  const user = await requireUser(c);
  const { team_id: teamId, code } = parseQuery(subscriptionParam, c.req.param(), "path");
  const target = validateSubscriptionCode(code);
  const body = await parseBody(c, subscriptionSchema);
  const expires = parseExpires(body.expires_at);
  const payload = await withDb(getEnv(c), (sql) => sql.begin(async (tx) => {
    await subscriptionTeamOr403(tx, teamId, user);
    const rows = await tx`
      INSERT INTO team_subscriptions (team_id, code, active, expires_at, source)
      VALUES (${teamId}, ${target}, ${body.active}, ${expires}, 'manual')
      ON CONFLICT (team_id, code) DO UPDATE SET
        active = EXCLUDED.active, expires_at = EXCLUDED.expires_at,
        source = 'manual', updated_at = now()
      RETURNING *`;
    return subSetOut(rows[0] as Row);
  }));
  return c.json(payload);
}));

// DELETE /api/v1/teams/{team_id}/subscriptions/{code}
app.delete("/api/v1/teams/:team_id/subscriptions/:code", (c) => respond(c, async () => {
  const user = await requireUser(c);
  const { team_id: teamId, code } = parseQuery(subscriptionParam, c.req.param(), "path");
  const target = validateSubscriptionCode(code);
  const payload = await withDb(getEnv(c), (sql) => sql.begin(async (tx) => {
    await subscriptionTeamOr403(tx, teamId, user);
    const rows = await tx`
      UPDATE team_subscriptions SET active=false, updated_at=now()
       WHERE team_id=${teamId} AND code=${target} RETURNING id`;
    if (rows.length === 0) {
      throw httpError(404, { error: "not_found", code: "SUBSCRIPTION_NOT_FOUND" });
    }
    return { revoked: true, code: target };
  }));
  return c.json(payload);
}));

export default app;
