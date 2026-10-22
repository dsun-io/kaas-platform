/**
 * KaaS TS 门面 · auth 域（9 条路由，对齐 backend/worker/src/main.py Auth 段 :295-943）。
 *
 * 协议层本职：密码校验 / JWT 签发 / 会话装载 / 参数校验。
 * 发信本波不接 Resend（TODO(TODO:TS2)：RESEND_API_KEY 未配到 edge，
 * 接入列入切流前检查单）—— forgot-password 落库 token 并记录日志，
 * 响应形状与 Python 完全相同。
 */
import { Hono } from "hono";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";

import { verifyPassword } from "../auth";
import { withDb, type Db, type Tx } from "../db";
import { getEnv, requireSecret, type Env } from "../env";
import { httpError, parseBody, respond } from "../http";
import {
  createToken,
  hashPassword,
  profilePayload,
  requireUser,
  teamNameOf,
  authPayload,
} from "../session";
import {
  inviteState,
  normalizeInviteToken,
  resolveSignupWorkstations as resolveSignupWorkstationsCompat,
  RuleError,
  validateApplicationMessage,
  validateTeamName,
} from "../rules";

const app = new Hono<{ Bindings: Env }>();

// 入参 schema 当前手写（TODO(TODO:TS1)：待 pydantic→zod 生成器覆盖本域后替换）。

/** token 只存哈希，30 分钟过期，用后即废（main.py:_RESET_TTL_MINUTES）。 */
const RESET_TTL_MINUTES = 30;

/** 重置 token 存储哈希（main.py:_hash_reset_token：secrets.token_urlsafe(32) 的 sha256 hex）。 */
function hashResetToken(raw: string): string {
  return createHash("sha256").update(raw, "utf-8").digest("hex");
}

/** secrets.token_urlsafe(32)：32 字节 → base64url（无填充）43 字符。 */
function tokenUrlSafe(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

const DEFAULT_FRONTEND_BASE = "https://kaas.powervoy.com";

// ── POST /api/v1/auth/bootstrap-admin（main.py:295-335）──────────────────────
const bootstrapSchema = z.object({
  email: z.string(),
  password: z.string(),
  display_name: z.string(),
});

app.post("/bootstrap-admin", (c) => respond(c, async () => {
  const env = getEnv(c);
  const setupToken = env.ADMIN_SETUP_TOKEN;
  if (typeof setupToken !== "string" || setupToken.length === 0) {
    throw httpError(503, "ADMIN_SETUP_TOKEN not configured");
  }
  const authorization = c.req.header("Authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) {
    // 与 orchestrator 同口径：缺凭据 = 401（PARITY-DIFF-1）
    throw httpError(401, "Not authenticated");
  }
  const provided = Buffer.from(authorization.slice("Bearer ".length), "utf-8");
  const expected = Buffer.from(setupToken, "utf-8");
  const equal = provided.length === expected.length && timingSafeEqual(provided, expected);
  if (!equal) {
    throw httpError(403, "Invalid setup token");
  }
  const body = await parseBody(c, bootstrapSchema);
  // 与 orchestrator 同口径：密码 ≥8（PARITY-DIFF-2）
  if ((body.password ?? "").length < 8) {
    throw httpError(422, "validation_error: Password must be at least 8 characters");
  }
  const email = body.email.toLowerCase();
  const result = await withDb(env, async (sql: Db) => {
    const existing = await sql`
      SELECT id FROM users WHERE account_type='internal' AND role='system_admin' LIMIT 1`;
    if (existing.length > 0) {
      throw httpError(403, "System already initialized");
    }
    // 邮箱查重预检（PARITY-DIFF-3：撞唯一约束原是 500）
    const dup = await sql`SELECT 1 FROM users WHERE email=${email}`;
    if (dup.length > 0) {
      throw httpError(409, "conflict: Email already registered");
    }
    const rows = await sql`
      INSERT INTO users (email, password_hash, display_name,
             account_type, role, plan, status, is_tenant_admin, created_at, updated_at)
      VALUES (${email}, ${await hashPassword(body.password)}, ${body.display_name},
             'internal','system_admin','internal','active',false,NOW(),NOW())
      RETURNING id, email, display_name, account_type, role, plan, team_id, console_access`;
    return rows[0] as Record<string, unknown>;
  });
  const token = await createToken(Number(result.id), requireSecret(env, "JWT_SECRET"));
  return c.json(authPayload({
    id: Number(result.id),
    email: result.email as string,
    display_name: result.display_name as string,
    account_type: result.account_type as string,
    role: result.role as string,
    plan: result.plan as string | null,
    team_id: result.team_id === null || result.team_id === undefined ? null : Number(result.team_id),
    console_access: result.console_access === true,
  }, token));
}));

// ── POST /api/v1/auth/login（main.py:338-354）────────────────────────────────
const loginSchema = z.object({
  email: z.string(),
  password: z.string(),
});

app.post("/login", (c) => respond(c, async () => {
  const env = getEnv(c);
  const body = await parseBody(c, loginSchema);
  const rows = await withDb(env, (sql: Db) => sql`
    SELECT id, email, password_hash, display_name, account_type, role, status,
           team_id, console_access, plan FROM users WHERE email=${body.email.trim().toLowerCase()}`);
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row || !(await verifyPassword(body.password, row.password_hash as string))) {
    throw httpError(401, "Invalid credentials");
  }
  if (row.status !== "active") {
    // 与 orchestrator 同口径：密码正确但账号被禁用 → 403（PARITY-DIFF-7）
    throw httpError(403, "forbidden: Account is disabled");
  }
  const token = await createToken(Number(row.id), requireSecret(env, "JWT_SECRET"));
  const teamId = row.team_id === null || row.team_id === undefined ? null : Number(row.team_id);
  return c.json(authPayload({
    id: Number(row.id),
    email: row.email as string,
    display_name: row.display_name as string,
    account_type: row.account_type as string,
    role: row.role as string,
    plan: row.plan as string | null,
    team_id: teamId,
    console_access: row.console_access === true,
  }, token, await teamNameOf(env, teamId)));
}));

// ── GET /api/v1/auth/me（main.py:390-406）───────────────────────────────────
app.get("/me", (c) => respond(c, async () => {
  const env = getEnv(c);
  const user = await requireUser(c);
  return c.json({
    ...profilePayload(user),
    team_name: await teamNameOf(env, user.team_id),
  });
}));

// ── POST /api/v1/auth/logout（main.py:409-417）──────────────────────────────
app.post("/logout", (c) => respond(c, async () => {
  // stateless JWT：服务端没有会话可销毁（与 orchestrator 同响应体）
  return c.json({ message: "Logged out (client should discard token)" });
}));

// ── PATCH /api/v1/auth/me（main.py:450-477）─────────────────────────────────
const updateMeSchema = z.object({
  display_name: z.string(),
});

app.patch("/me", (c) => respond(c, async () => {
  const user = await requireUser(c);
  const body = await parseBody(c, updateMeSchema);
  const displayName = (body.display_name ?? "").trim();
  if (!displayName) {
    throw httpError(422, { error: "validation", code: "DISPLAY_NAME_REQUIRED", detail: "显示名不能为空" });
  }
  if (displayName.length > 64) {
    throw httpError(422, { error: "validation", code: "DISPLAY_NAME_TOO_LONG", detail: "显示名最长 64 个字符" });
  }
  const rows = await withDb(getEnv(c), (sql: Db) => sql`
    UPDATE users SET display_name=${displayName}, updated_at=NOW() WHERE id=${user.id}
    RETURNING id, email, display_name, account_type, role, plan, team_id,
              console_access, is_tenant_admin`);
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) {
    throw httpError(404, { error: "not_found", code: "USER_NOT_FOUND", detail: "账号不存在" });
  }
  const merged = {
    ...user,
    display_name: row.display_name as string,
    email: row.email as string,
    account_type: row.account_type as string,
    role: row.role as string,
    plan: (row.plan as string | null) ?? null,
    team_id: row.team_id === null || row.team_id === undefined ? null : Number(row.team_id),
    console_access: row.console_access === true,
    is_tenant_admin: row.is_tenant_admin === true,
  };
  return c.json(profilePayload(merged));
}));

// ── POST /api/v1/auth/change-password（main.py:479-508）─────────────────────
const changePasswordSchema = z.object({
  current_password: z.string(),
  new_password: z.string(),
});

app.post("/change-password", (c) => respond(c, async () => {
  const user = await requireUser(c);
  const body = await parseBody(c, changePasswordSchema);
  const newPassword = body.new_password ?? "";
  if (newPassword.length < 8) {
    throw httpError(422, {
      error: "validation", code: "PASSWORD_TOO_SHORT",
      detail: "Password must be at least 8 characters",
    });
  }
  const rows = await withDb(getEnv(c), async (sql: Db) => {
    const found = await sql`SELECT password_hash FROM users WHERE id=${user.id}`;
    const row = found[0] as Record<string, unknown> | undefined;
    if (!row || !(await verifyPassword(body.current_password ?? "", row.password_hash as string))) {
      // 不泄露账号状态
      throw httpError(403, { error: "forbidden", code: "INVALID_CURRENT_PASSWORD", detail: "当前密码不正确" });
    }
    await sql`UPDATE users SET password_hash=${await hashPassword(newPassword)}, updated_at=NOW() WHERE id=${user.id}`;
  });
  void rows;
  return c.json({ message: "Password updated" });
}));

// ── POST /api/v1/auth/forgot-password（main.py:672-705）─────────────────────
const forgotSchema = z.object({
  email: z.string().default(""),
});

app.post("/forgot-password", (c) => respond(c, async () => {
  const env = getEnv(c);
  const body = await parseBody(c, forgotSchema);
  /** 不泄露邮箱存在性：响应恒为 {"ok": true, ...}。 */
  const email = (body.email ?? "").trim().toLowerCase();
  if (!email || !email.includes("@")) {
    throw httpError(422, "validation_error: email is required");
  }
  await withDb(env, (sql: Db) => sql.begin(async (tx: Tx) => {
    const found = await tx`
      SELECT id, email, status FROM users WHERE email=${email}`;
    const row = found[0] as Record<string, unknown> | undefined;
    if (row && row.status === "active") {
      const rawToken = tokenUrlSafe(32);
      await tx`
        UPDATE password_reset_tokens SET used_at=NOW() WHERE user_id=${Number(row.id)} AND used_at IS NULL`;
      await tx`
        INSERT INTO password_reset_tokens
               (user_id, token_hash, expires_at, requested_ip, created_at)
        VALUES (${Number(row.id)}, ${hashResetToken(rawToken)},
                ${new Date(Date.now() + RESET_TTL_MINUTES * 60_000)},
                ${c.req.header("CF-Connecting-IP") ?? null}, NOW())`;
      const base = (env.FRONTEND_BASE_URL || DEFAULT_FRONTEND_BASE).replace(/\/+$/, "");
      const resetLink = `${base}/reset-password?token=${rawToken}`;
      // TODO(TODO:TS2)：接入 Resend 发信。RESEND_API_KEY 未配到 edge（切流前检查单），
      // 本波只记录日志、不发信；响应形状与 Python 相同（发信失败本就不影响响应）。
      console.log(JSON.stringify({
        event: "password_reset_email_deferred",
        to: row.email,
        reset_link: resetLink,
        reason: "RESEND_API_KEY not configured on kaas-edge (TODO:TS2)",
      }));
    }
  }));
  return c.json({ ok: true, message: "如果该邮箱已注册，重置链接已发送" });
}));

// ── POST /api/v1/auth/reset-password（main.py:708-743）──────────────────────
const resetSchema = z.object({
  token: z.string().default(""),
  new_password: z.string().default(""),
});

app.post("/reset-password", (c) => respond(c, async () => {
  const body = await parseBody(c, resetSchema);
  /** 无效/过期/已用统一 400 invalid_token。 */
  const token = (body.token ?? "").trim();
  const newPassword = body.new_password ?? "";
  if (!token) {
    throw httpError(422, "validation_error: token is required");
  }
  if (newPassword.length < 8) {
    throw httpError(422, "validation_error: Password must be at least 8 characters");
  }
  await withDb(getEnv(c), async (sql: Db) => {
    await sql.begin(async (tx: Tx) => {
      const found = await tx`
        SELECT t.id AS token_id, t.user_id, u.status
          FROM password_reset_tokens t JOIN users u ON u.id = t.user_id
         WHERE t.token_hash=${hashResetToken(token)} AND t.used_at IS NULL
           AND t.expires_at > NOW() AND u.status='active'`;
      const row = found[0] as Record<string, unknown> | undefined;
      if (!row) {
        throw httpError(400, { error: "invalid_token", message: "重置链接无效或已过期，请重新申请" });
      }
      await tx`
        UPDATE users SET password_hash=${await hashPassword(newPassword)}, updated_at=NOW()
         WHERE id=${Number(row.user_id)}`;
      await tx`
        UPDATE password_reset_tokens SET used_at=NOW()
         WHERE user_id=${Number(row.user_id)} AND used_at IS NULL`;
    });
  });
  return c.json({ ok: true, message: "密码已重置，请用新密码登录" });
}));

// ── POST /api/v1/auth/register（main.py:746-943）─────────────────────────────
/** 与 dev 同一清单（前端注册页的下拉就是这些值）。 */
const CATEGORIES = new Set([
  "fencing", "mesh_panel_roll", "woven_mesh", "welded_mesh", "perforated_mesh",
  "wire_rope", "filter_mesh", "gabion_protection", "custom_wire_mesh", "other",
]);

const registerSchema = z.object({
  email: z.string(),
  password: z.string(),
  display_name: z.string(),
  company_name: z.string().nullish(),
  product_category: z.string(),
  contact: z.string().nullish(),
  invite_token: z.string().nullish(),
  team_name: z.string().nullish(),
  // 2026-10-22：加入申请（与 invite_token / team_name 三方互斥）
  apply_team_name: z.string().nullish(),
  apply_message: z.string().nullish(),
  workstations: z.array(z.string()).nullish(),
});

function rule422(error: RuleError): never {
  throw httpError(422, { error: "validation", code: error.code, detail: error.detail });
}

app.post("/register", (c) => respond(c, async () => {
  const env = getEnv(c);
  const body = await parseBody(c, registerSchema);

  const email = (body.email ?? "").trim().toLowerCase();
  const password = body.password ?? "";
  const displayName = (body.display_name ?? "").trim();
  const productCategory = (body.product_category ?? "").trim().toLowerCase();
  const inviteRaw = (body.invite_token ?? "").trim();
  const teamNameRaw = (body.team_name ?? "").trim();
  const applyTeamNameRaw = (body.apply_team_name ?? "").trim();
  const applyMessageRaw = (body.apply_message ?? "").trim();

  if (!email || !password || !displayName) {
    throw httpError(422, "validation_error: email, password, display_name are required");
  }
  if (!productCategory || !CATEGORIES.has(productCategory)) {
    throw httpError(422, (
      "validation_error: product_category is required and must be one of: "
      + [...CATEGORIES].sort().join(", ")
    ));
  }
  if (password.length < 8) {
    throw httpError(422, "validation_error: Password must be at least 8 characters");
  }
  if (!email.includes("@") || !email.split("@").pop()!.includes(".")) {
    throw httpError(422, "validation_error: Invalid email format");
  }
  // 团队动作三方互斥（2026-10-22 起，与内核 main.py 同口径）：
  // 邀请码 / 新建团队 / 加入申请，一次注册只能做一个
  const teamActions = [Boolean(inviteRaw), Boolean(teamNameRaw), Boolean(applyTeamNameRaw)];
  if (teamActions.filter(Boolean).length > 1) {
    throw httpError(422, {
      error: "validation", code: "TEAM_ACTION_CONFLICT",
      detail: "只能三选一：凭邀请码加入现有团队、新建一个团队、或向已存在团队发起加入申请",
    });
  }

  // 工位编码在解析期校验（即使不建团队也要 422，PARITY-DIFF-10）
  let chosenWorkstations: string[];
  try {
    chosenWorkstations = resolveSignupWorkstationsCompat(body.workstations);
  } catch (e) {
    if (e instanceof RuleError) rule422(e);
    throw e;
  }

  const result = await withDb(env, async (sql: Db) => {
    return sql.begin(async (tx: Tx) => {
      // ── 团队动作预校验（放在建账号之前，失败即整体回滚）──
      let invite: Record<string, unknown> | null = null;
      if (inviteRaw) {
        const token = normalizeInviteToken(inviteRaw);
        // FOR UPDATE：一次一码的并发保证（与内核 main.py 同口径）
        const rows = await tx`SELECT * FROM team_invites WHERE token=${token} FOR UPDATE`;
        invite = (rows[0] as Record<string, unknown> | undefined) ?? null;
        const state = inviteState(invite);
        if (state === "not_found") {
          throw httpError(404, { error: "not_found", code: "INVITE_NOT_FOUND" });
        }
        if (state === "revoked") {
          throw httpError(410, { error: "gone", code: "INVITE_REVOKED" });
        }
        if (state === "used") {
          throw httpError(409, { error: "conflict", code: "INVITE_ALREADY_USED" });
        }
        if (state === "expired") {
          throw httpError(410, { error: "gone", code: "INVITE_EXPIRED" });
        }
      }

      // ── 加入申请预校验（2026-10-22；放在建账号之前，失败即整体回滚）──
      // 顺序与邀请码对齐：团队不存在 404 优先于邮箱占用 409（PARITY-DIFF-12 同思路）。
      let applyTeamId: number | null = null;
      let applyTeamNameOut: string | null = null;
      let applyMessage: string | null = null;
      if (applyTeamNameRaw) {
        try {
          applyMessage = validateApplicationMessage(applyMessageRaw);
          const applyTeamNameNorm = validateTeamName(applyTeamNameRaw);
          const arows = await tx`
            SELECT id, name FROM teams WHERE tenant_id=${"default"} AND name=${applyTeamNameNorm}`;
          const ateam = arows[0] as Record<string, unknown> | undefined;
          if (!ateam) {
            throw httpError(404, {
              error: "not_found", code: "TEAM_NOT_FOUND",
              message: `团队「${applyTeamNameNorm}」不存在：可向团队管理员要邀请码，或改为新建团队`,
            });
          }
          applyTeamId = Number(ateam.id);
          applyTeamNameOut = ateam.name as string;
        } catch (e) {
          if (e instanceof RuleError) rule422(e);
          throw e;
        }
      }

      let newTeamName: string | null = null;
      if (teamNameRaw) {
        try {
          newTeamName = validateTeamName(teamNameRaw);
        } catch (e) {
          if (e instanceof RuleError) rule422(e);
          throw e;
        }
        const taken = await tx`
          SELECT 1 FROM teams WHERE tenant_id=${"default"} AND name=${newTeamName}`;
        if (taken.length > 0) {
          throw httpError(409, {
            error: "conflict", code: "TEAM_NAME_TAKEN",
            message: `已存在同名团队「${newTeamName}」`,
          });
        }
      }

      // 邮箱查重放在团队动作预校验之后（与 orchestrator 同口径，PARITY-DIFF-12）
      const dup = await tx`SELECT 1 FROM users WHERE email=${email}`;
      if (dup.length > 0) {
        throw httpError(409, "conflict: Email already registered");
      }

      // 建团队的成为团队管理员（role=owner）；凭码加入或发起申请的是普通成员（role=user）
      const role = invite !== null || applyTeamId !== null ? "user" : "owner";
      const inserted = await tx`
        INSERT INTO users (email, password_hash, display_name, account_type, role,
               plan, status, is_tenant_admin)
        VALUES (${email}, ${await hashPassword(password)}, ${displayName},
               'customer',${role},'free','active',false)
        RETURNING id, email, display_name, account_type, role, status`;
      const userRow = inserted[0] as Record<string, unknown>;
      const uid = Number(userRow.id);

      // 不再为注册者创建 customers 行：公司身份由团队承载。
      let teamId: number | null = null;
      let teamNameOut: string | null = null;
      let applicationOut: Record<string, unknown> | null = null;

      const openWorkstations = async (tid: number): Promise<void> => {
        for (const wsCode of chosenWorkstations) {
          await tx`
            INSERT INTO team_subscriptions (team_id, code, active, source)
            VALUES (${tid},${wsCode},true,'signup')
            ON CONFLICT (team_id, code) DO UPDATE SET
              active = true, source = 'signup', updated_at = now()`;
        }
      };

      if (invite !== null) {
        teamId = Number(invite.team_id);
        await tx`UPDATE users SET team_id=${teamId} WHERE id=${uid}`;
        await tx`
          UPDATE team_invites SET status='accepted', accepted_at=now(), accepted_by=${uid}
           WHERE id=${Number(invite.id)}`;
        const trows = await tx`SELECT name FROM teams WHERE id=${teamId}`;
        const trow = trows[0] as Record<string, unknown> | undefined;
        teamNameOut = (trow?.name as string | undefined) ?? null;
      } else if (newTeamName) {
        // 只有显式传 team_name 才建团队（2026-10-19 去掉 company_name 兜底）
        const team = await tx`
          INSERT INTO teams (tenant_id, name, created_by) VALUES (${"default"}, ${newTeamName}, ${uid})
          RETURNING id, name`;
        const t = team[0] as Record<string, unknown>;
        teamId = Number(t.id);
        teamNameOut = t.name as string;
        await tx`UPDATE users SET team_id=${teamId} WHERE id=${uid}`;
        await openWorkstations(teamId);
      } else if (applyTeamId !== null) {
        // 加入申请（2026-10-22）：账号建成但**不入团**，等团队管理员审核通过才落 team_id
        const appRows = await tx`
          INSERT INTO team_join_applications
                 (tenant_id, team_id, user_id, email, display_name, message, status)
          VALUES (${"default"}, ${applyTeamId}, ${uid}, ${email}, ${displayName},
                  ${applyMessage}, 'pending')
          RETURNING id`;
        applicationOut = {
          id: Number((appRows[0] as Record<string, unknown>).id),
          team_id: applyTeamId,
          team_name: applyTeamNameOut,
          status: "pending",
        };
      }
      return { userRow, uid, teamId, teamNameOut, applicationOut };
    });
  });

  // 扁平响应：前端 buildUser() 读 user_id / team_id / team_name / console_access
  return c.json({
    user_id: result.uid,
    email: result.userRow.email,
    display_name: result.userRow.display_name,
    account_type: result.userRow.account_type,
    role: result.userRow.role,
    plan: "free",
    team_id: result.teamId,
    team_name: result.teamNameOut,
    // 加入申请待审标记（2026-10-22）：未申请时为 null，不破坏旧客户端
    application: result.applicationOut,
    console_access: false, // 官网数据后台权限：默认关闭，由团队管理员授予
    access_token: await createToken(result.uid, requireSecret(env, "JWT_SECRET")),
    token_type: "bearer",
  });
}));

export default app;
