/**
 * KaaS TS 门面 · outreach 域（12 条路由）。
 *
 * 真源逐条对齐 backend/worker/src/chain.py（外联工位）：
 * - GET    /api/v1/outreach/mailboxes                     chain.py:1685 mb_list
 * - POST   /api/v1/outreach/mailboxes                     chain.py:1695 mb_create
 * - PATCH  /api/v1/outreach/mailboxes/{mailbox_id}        chain.py:1719 mb_patch
 * - POST   /api/v1/outreach/mailboxes/{mailbox_id}/test   chain.py:1752 mb_test
 * - GET    /api/v1/outreach/campaigns                     chain.py:1790 camp_list
 * - POST   /api/v1/outreach/campaigns                     chain.py:1800 camp_create
 * - POST   /api/v1/outreach/generate                      chain.py:1814 camp_generate
 * - POST   /api/v1/outreach/campaigns/{campaign_id}/send  chain.py:1822 camp_send
 * - GET    /api/v1/outreach/messages                      chain.py:1899 msg_list
 * - GET    /api/v1/outreach/messages/{message_id}         chain.py:1928 msg_get
 * - POST   /api/v1/outreach/messages/{message_id}/retry   chain.py:1941 msg_retry
 * - POST   /api/v1/outreach/webhook                       chain.py:1977 outreach_webhook
 *
 * 业务闸门（订阅 / 状态机 / 每日限额）由 rules.ts 的枚举与状态机镜像承载；
 * 发信是**协议转换**（Resend HTTP），AI 生成走 KERNEL Service Binding（不重写模板链）。
 */
import { Hono } from "hono";
import { z } from "zod";

import { withDb, type Db } from "../db";
import { getEnv, type Env } from "../env";
import { httpError, num, parseBody, parseQuery, pyIso, respond } from "../http";
import {
  chain_CampaignCreate,
  chain_CampaignSend,
  chain_MailboxCreate,
  chain_MailboxPatch,
  chain_TaskRun,
} from "../generated/schemas";
import { KernelError, callKernel } from "../kernel";
import { requireUser } from "../session";

const app = new Hono<{ Bindings: Env }>();

const DEFAULT_TENANT = "default";

/** Resend 发信端点（chain.py:49）。 */
const RESEND_API_URL = "https://api.resend.com/emails";

/** 工位订阅码（chain.py:234 SUB_CODES）。 */
const SUB_CODES: Record<string, string[]> = {
  leadgen: ["leadgen_starter", "leadgen_pro", "full_chain"],
  outreach: ["outreach_starter", "outreach_pro", "full_chain"],
  intel: ["intel_trade_starter", "intel_full", "full_chain"],
  research: ["intel_research_starter", "intel_full", "full_chain"],
};

/** 模板变量（chain.py:50 VAR_RE）。 */
const VAR_RE = /\{\{\s*(\w+)\s*\}\}/g;

type Row = Record<string, unknown>;

// ── 协议助手（chain.py 对应段落的逐行直译）───────────────────────────────────

/** chain.py:242 _require_sub：无订阅 ⇒ 404 SUBSCRIPTION_REQUIRED（不是 403）。 */
async function requireSub(sql: Db, workstation: string): Promise<void> {
  const codes = SUB_CODES[workstation]!;
  const rows = await sql.unsafe(
    "SELECT 1 FROM tenant_subscriptions WHERE tenant_id=$1"
    + " AND code IN ($2,$3,$4) AND active=true",
    [DEFAULT_TENANT, ...codes] as never[],
  );
  if ((rows as unknown as Row[]).length === 0) {
    throw httpError(404, {
      error: "subscription_required", code: "SUBSCRIPTION_REQUIRED",
      workstation, codes,
    });
  }
}

/** chain.py:92 _mask：≤8 位全遮，否则前 4 + **** + 后 4。 */
function mask(key: string | null | undefined): string | null {
  if (!key) return null;
  return key.length <= 8 ? "****" : key.slice(0, 4) + "****" + key.slice(-4);
}

/** chain.py:1674 _row_to_mailbox（密钥只出掩码，绝不回传明文）。 */
function rowToMailbox(row: Row): Record<string, unknown> {
  const apiKey = (row.api_key as string | null) ?? null;
  return {
    id: num(row.id),
    email: row.email,
    name: row.name,
    provider: row.provider,
    api_key_masked: mask(apiKey),
    has_own_key: Boolean(apiKey),
    is_default: row.is_default,
    daily_limit: num(row.daily_limit),
    sent_today: num(row.sent_today),
    last_sent_date: pyIso(row.last_sent_date),
    enabled: row.enabled,
  };
}

/** dict(row) 的 JSON 投影：datetime/date → isoformat（FastAPI jsonable_encoder 等价）。 */
function pyRow(row: Row): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = value instanceof Date ? pyIso(value) : value;
  }
  return out;
}

/** chain.py:1585 render_template：{{ var }} → 变量值（缺省空串）。 */
function renderTemplate(template: string, variables: Record<string, string>): string {
  return String(template ?? "").replace(VAR_RE, (_m, name: string) => variables[name] ?? "");
}

/** chain.py:1589 _lead_variables。 */
function leadVariables(lead: Row, mailbox: Row): Record<string, string> {
  return {
    name: String(lead.company_name ?? ""),
    company: String(lead.company_name ?? ""),
    city: String(lead.city ?? ""),
    country: String(lead.country ?? ""),
    region: String(lead.region ?? ""),
    opening_line: String(lead.opening_line ?? ""),
    sender_name: String(mailbox?.name ?? ""),
  };
}

/** chain.py:1601 _resolve_api_key：邮箱自己的 key 优先，否则请求期环境变量。 */
function resolveApiKey(mailbox: Row, env: Env): string | null {
  const own = mailbox.api_key as string | null;
  const fromEnv = env.RESEND_API_KEY;
  return own || (typeof fromEnv === "string" && fromEnv ? fromEnv : null);
}

/** chain.py:53 _http_post_json（只保留本域需要的 POST JSON 形态）。 */
async function postJson(
  url: string,
  headers: Record<string, string>,
  payload: unknown,
): Promise<{ status: number; text: string }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });
  return { status: res.status, text: await res.text() };
}

/** chain.py:1608 _send_one：经 Resend 发单封并回写消息/邮箱/线索状态。 */
async function sendOne(sql: Db, msg: Row, mailbox: Row, env: Env): Promise<Record<string, unknown>> {
  const apiKey = resolveApiKey(mailbox, env);
  if (!apiKey) {
    const err = "未配置 Resend API Key（邮箱 api_key 或环境变量 RESEND_API_KEY）";
    await sql.unsafe(
      "UPDATE outreach_messages SET status='failed', error=$3 WHERE id=$1 AND tenant_id=$2",
      [msg.id, DEFAULT_TENANT, err] as never[],
    );
    return { status: "failed", error: err };
  }
  const today = new Date().toISOString().slice(0, 10);
  let sentToday = Number(mailbox.sent_today ?? 0);
  const lastSent = mailbox.last_sent_date;
  if (lastSent instanceof Date && lastSent.toISOString().slice(0, 10) !== today) {
    sentToday = 0;
  }
  if (mailbox.daily_limit !== null && mailbox.daily_limit !== undefined
    && sentToday >= Number(mailbox.daily_limit)) {
    const err = "超出每日限额 " + String(mailbox.daily_limit);
    await sql.unsafe(
      "UPDATE outreach_messages SET status='failed', error=$3 WHERE id=$1 AND tenant_id=$2",
      [msg.id, DEFAULT_TENANT, err] as never[],
    );
    return { status: "failed", error: err };
  }
  try {
    const { status, text } = await postJson(RESEND_API_URL, { Authorization: "Bearer " + apiKey }, {
      from: String(mailbox.name || mailbox.email) + " <" + String(mailbox.email) + ">",
      to: [msg.to_email],
      subject: msg.subject,
      text: msg.body_rendered,
    });
    if (status !== 200 && status !== 201) {
      throw new Error("HTTP " + String(status) + ": " + text.slice(0, 300));
    }
    const data = JSON.parse(text) as { id?: string };
    await sql.unsafe(
      "UPDATE outreach_messages SET status='sent', resend_message_id=$3,"
      + " sent_at=NOW(), error=NULL WHERE id=$1 AND tenant_id=$2",
      [msg.id, DEFAULT_TENANT, data.id ?? null] as never[],
    );
    await sql.unsafe(
      "UPDATE outreach_mailboxes SET sent_today=COALESCE($3,0)+1, last_sent_date=$4"
      + " WHERE id=$1 AND tenant_id=$2",
      [mailbox.id, DEFAULT_TENANT, sentToday, today] as never[],
    );
    if (msg.lead_id) {
      await sql.unsafe(
        "UPDATE lead_candidates SET outreach_status='sent', updated_at=NOW()"
        + " WHERE tenant_id=$1 AND id=$2",
        [DEFAULT_TENANT, msg.lead_id] as never[],
      );
    }
    return { status: "sent" };
  } catch (err) {
    const message = String((err as Error)?.message ?? err).slice(0, 500);
    await sql.unsafe(
      "UPDATE outreach_messages SET status='failed', error=$3 WHERE id=$1 AND tenant_id=$2",
      [msg.id, DEFAULT_TENANT, message] as never[],
    );
    return { status: "failed", error: message };
  }
}

/** 默认可用邮箱（chain.py:1845 / 1966 的两处同款查询）。 */
async function defaultMailbox(sql: Db): Promise<Row | undefined> {
  const rows = await sql.unsafe(
    "SELECT * FROM outreach_mailboxes WHERE tenant_id=$1 AND is_default=true AND enabled=true",
    [DEFAULT_TENANT] as never[],
  );
  return (rows as unknown as Row[])[0];
}

// ── 邮箱 ─────────────────────────────────────────────────────────────────────

// GET /api/v1/outreach/mailboxes（chain.py:1685）
app.get("/api/v1/outreach/mailboxes", (c) => respond(c, async () => {
  await requireUser(c);
  const rows = await withDb(getEnv(c), async (sql: Db) => {
    await requireSub(sql, "outreach");
    return sql.unsafe(
      "SELECT * FROM outreach_mailboxes WHERE tenant_id=$1 ORDER BY is_default DESC, created_at",
      [DEFAULT_TENANT] as never[],
    ) as unknown as Row[];
  });
  return c.json({ items: rows.map(rowToMailbox), total: rows.length });
}));

// POST /api/v1/outreach/mailboxes（chain.py:1695）
app.post("/api/v1/outreach/mailboxes", (c) => respond(c, async () => {
  await requireUser(c);
  const body = await parseBody(c, chain_MailboxCreate);
  const row = await withDb(getEnv(c), async (sql: Db) => {
    await requireSub(sql, "outreach");
    const existing = await sql.unsafe(
      "SELECT id FROM outreach_mailboxes WHERE tenant_id=$1 AND email=$2",
      [DEFAULT_TENANT, body.email] as never[],
    );
    if ((existing as unknown as Row[]).length > 0) {
      throw httpError(409, { error: "conflict", code: "DUPLICATE_MAILBOX" });
    }
    if (body.is_default) {
      // 先清旧默认再插新行（避免新行被一起刷掉）
      await sql.unsafe(
        "UPDATE outreach_mailboxes SET is_default=false WHERE tenant_id=$1 AND is_default=true",
        [DEFAULT_TENANT] as never[],
      );
    }
    const inserted = await sql.unsafe(
      "INSERT INTO outreach_mailboxes (tenant_id, email, name, api_key, is_default, daily_limit)"
      + " VALUES ($1,$2,$3,$4,$5,$6) RETURNING *",
      [DEFAULT_TENANT, body.email, body.name ?? null, body.api_key ?? null,
        body.is_default, body.daily_limit ?? null] as never[],
    );
    return (inserted as unknown as Row[])[0] as Row;
  });
  return c.json(rowToMailbox(row), 201);
}));

// PATCH /api/v1/outreach/mailboxes/{mailbox_id}（chain.py:1719）
app.patch("/api/v1/outreach/mailboxes/:mailbox_id", (c) => respond(c, async () => {
  await requireUser(c);
  const mailboxId = Number(c.req.param("mailbox_id"));
  const body = await parseBody(c, chain_MailboxPatch);
  const row = await withDb(getEnv(c), async (sql: Db) => {
    await requireSub(sql, "outreach");
    const found = await sql.unsafe(
      "SELECT * FROM outreach_mailboxes WHERE id=$1 AND tenant_id=$2",
      [mailboxId, DEFAULT_TENANT] as never[],
    );
    if ((found as unknown as Row[]).length === 0) {
      throw httpError(404, { error: "not_found", code: "MAILBOX_NOT_FOUND" });
    }
    if (body.name !== null && body.name !== undefined) {
      await sql.unsafe("UPDATE outreach_mailboxes SET name=$3 WHERE id=$1 AND tenant_id=$2",
        [mailboxId, DEFAULT_TENANT, body.name] as never[]);
    }
    if (body.api_key !== null && body.api_key !== undefined) {
      await sql.unsafe("UPDATE outreach_mailboxes SET api_key=$3 WHERE id=$1 AND tenant_id=$2",
        [mailboxId, DEFAULT_TENANT, body.api_key || null] as never[]);
    }
    if (body.daily_limit !== null && body.daily_limit !== undefined) {
      await sql.unsafe("UPDATE outreach_mailboxes SET daily_limit=$3 WHERE id=$1 AND tenant_id=$2",
        [mailboxId, DEFAULT_TENANT, body.daily_limit] as never[]);
    }
    if (body.enabled !== null && body.enabled !== undefined) {
      await sql.unsafe("UPDATE outreach_mailboxes SET enabled=$3 WHERE id=$1 AND tenant_id=$2",
        [mailboxId, DEFAULT_TENANT, body.enabled] as never[]);
    }
    if (body.is_default) {
      await sql.unsafe(
        "UPDATE outreach_mailboxes SET is_default=false"
        + " WHERE tenant_id=$1 AND is_default=true AND id<>$2",
        [DEFAULT_TENANT, mailboxId] as never[],
      );
      await sql.unsafe("UPDATE outreach_mailboxes SET is_default=true WHERE id=$1",
        [mailboxId] as never[]);
    }
    const rows = await sql.unsafe("SELECT * FROM outreach_mailboxes WHERE id=$1",
      [mailboxId] as never[]);
    return (rows as unknown as Row[])[0] as Row;
  });
  return c.json(rowToMailbox(row));
}));

// POST /api/v1/outreach/mailboxes/{mailbox_id}/test?to=（chain.py:1752）
app.post("/api/v1/outreach/mailboxes/:mailbox_id/test", (c) => respond(c, async () => {
  await requireUser(c);
  const mailboxId = Number(c.req.param("mailbox_id"));
  const query = parseQuery(z.object({ to: z.string() }), c.req.query());
  const env = getEnv(c);
  const mailbox = await withDb(env, async (sql: Db) => {
    await requireSub(sql, "outreach");
    const rows = await sql.unsafe(
      "SELECT * FROM outreach_mailboxes WHERE id=$1 AND tenant_id=$2",
      [mailboxId, DEFAULT_TENANT] as never[],
    );
    const row = (rows as unknown as Row[])[0];
    if (!row) {
      throw httpError(404, { error: "not_found", code: "MAILBOX_NOT_FOUND" });
    }
    return row;
  });
  const apiKey = resolveApiKey(mailbox, env);
  if (!apiKey) {
    return c.json({
      status: "failed",
      error: "未配置 Resend API Key（邮箱 api_key 或环境变量 RESEND_API_KEY）",
    });
  }
  try {
    const { status, text } = await postJson(RESEND_API_URL, { Authorization: "Bearer " + apiKey }, {
      from: String(mailbox.name || mailbox.email) + " <" + String(mailbox.email) + ">",
      to: [query.to],
      subject: "[KaaS] Mailbox test from " + String(mailbox.email),
      text: "This is a connectivity test email sent from the KaaS outreach workstation.",
    });
    if (status !== 200 && status !== 201) {
      throw new Error("HTTP " + String(status) + ": " + text.slice(0, 300));
    }
    const data = JSON.parse(text) as { id?: string };
    return c.json({ status: "sent", resend_message_id: data.id ?? null });
  } catch (err) {
    return c.json({ status: "failed", error: String((err as Error)?.message ?? err).slice(0, 500) });
  }
}));

// ── 活动 ─────────────────────────────────────────────────────────────────────

// GET /api/v1/outreach/campaigns（chain.py:1790）
app.get("/api/v1/outreach/campaigns", (c) => respond(c, async () => {
  await requireUser(c);
  const rows = await withDb(getEnv(c), async (sql: Db) => {
    await requireSub(sql, "outreach");
    return sql.unsafe(
      "SELECT * FROM outreach_campaigns WHERE tenant_id=$1 ORDER BY id DESC",
      [DEFAULT_TENANT] as never[],
    ) as unknown as Row[];
  });
  return c.json({ items: rows.map(pyRow) });
}));

// POST /api/v1/outreach/campaigns（chain.py:1800）
app.post("/api/v1/outreach/campaigns", (c) => respond(c, async () => {
  await requireUser(c);
  const body = await parseBody(c, chain_CampaignCreate);
  const row = await withDb(getEnv(c), async (sql: Db) => {
    await requireSub(sql, "outreach");
    const inserted = await sql.unsafe(
      "INSERT INTO outreach_campaigns"
      + " (tenant_id, name, subject_template, body_template, mailbox_id, status)"
      + " VALUES ($1,$2,$3,$4,$5,'draft') RETURNING *",
      [DEFAULT_TENANT, body.name, body.subject_template, body.body_template,
        body.mailbox_id ?? null] as never[],
    );
    return (inserted as unknown as Row[])[0] as Row;
  });
  return c.json(pyRow(row), 201);
}));

// POST /api/v1/outreach/generate（chain.py:1814 camp_generate）
// AI 任务链（模板/供应商/用量）是内核能力，门面不重写：透传 KERNEL 后原样回响应。
// TODO(TODO:TS4)：KERNEL binding 接线后改为 callKernel；未接线时按内核不可达口径回 503。
app.post("/api/v1/outreach/generate", (c) => respond(c, async () => {
  await requireUser(c);
  const body = await parseBody(c, chain_TaskRun);
  const sql = await withDb(getEnv(c), async (tx: Db) => {
    await requireSub(tx, "outreach");
    return null;
  });
  void sql;
  const env = getEnv(c);
  const kernel = env.KERNEL;
  if (!kernel || typeof kernel.fetch !== "function") {
    throw httpError(503, {
      error: "kernel_error", message: "kernel binding not configured (KERNEL)", status: 503,
    });
  }
  // 错误信封与 proxy.ts 同口径：内核不可达 → 502；内核 5xx → 原 status + kernel_error
  let res: Response;
  try {
    res = await callKernel(kernel, "/api/v1/outreach/generate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: c.req.header("Authorization") ?? "",
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    const status = err instanceof KernelError ? err.status : 502;
    return c.json(
      {
        error: "kernel_error",
        message: err instanceof KernelError ? err.message : "kernel unreachable",
        status,
      },
      status as 502,
    );
  }
  if (res.status >= 500) {
    const text = await res.text();
    return c.json(
      { error: "kernel_error", message: text.slice(0, 500), status: res.status },
      res.status as 500,
    );
  }
  return new Response(res.body, {
    status: res.status,
    headers: { "Content-Type": res.headers.get("Content-Type") ?? "application/json" },
  });
}));

// POST /api/v1/outreach/campaigns/{campaign_id}/send（chain.py:1822）
app.post("/api/v1/outreach/campaigns/:campaign_id/send", (c) => respond(c, async () => {
  await requireUser(c);
  const campaignId = Number(c.req.param("campaign_id"));
  const body = await parseBody(c, chain_CampaignSend);
  const env = getEnv(c);
  const result = await withDb(env, async (sql: Db) => {
    await requireSub(sql, "outreach");
    const found = await sql.unsafe(
      "SELECT * FROM outreach_campaigns WHERE id=$1 AND tenant_id=$2",
      [campaignId, DEFAULT_TENANT] as never[],
    );
    const campaign = (found as unknown as Row[])[0];
    if (!campaign) {
      throw httpError(404, { error: "not_found", code: "CAMPAIGN_NOT_FOUND" });
    }
    if (campaign.status === "sending") {
      throw httpError(409, { error: "conflict", code: "ALREADY_SENDING" });
    }
    let mailbox: Row | undefined;
    if (campaign.mailbox_id) {
      const mbRows = await sql.unsafe(
        "SELECT * FROM outreach_mailboxes WHERE id=$1 AND tenant_id=$2",
        [campaign.mailbox_id, DEFAULT_TENANT] as never[],
      );
      mailbox = (mbRows as unknown as Row[])[0];
      if (!mailbox) {
        throw httpError(404, { error: "not_found", code: "MAILBOX_NOT_FOUND" });
      }
      if (!mailbox.enabled) {
        throw httpError(409, { error: "conflict", code: "MAILBOX_DISABLED" });
      }
    } else {
      mailbox = await defaultMailbox(sql);
      if (!mailbox) {
        throw httpError(422, { error: "validation", code: "NO_DEFAULT_MAILBOX" });
      }
    }
    const idPlaceholders = body.lead_ids.map((_id, idx) => "$" + String(idx + 2)).join(",");
    const leads = await sql.unsafe(
      "SELECT * FROM lead_candidates WHERE tenant_id=$1 AND id IN (" + idPlaceholders + ")",
      [DEFAULT_TENANT, ...body.lead_ids] as never[],
    ) as unknown as Row[];
    if (leads.length === 0) {
      throw httpError(422, { error: "validation", code: "NO_LEADS" });
    }
    const messages: Row[] = [];
    for (const lead of leads) {
      const variables = leadVariables(lead, mailbox);
      const inserted = await sql.unsafe(
        "INSERT INTO outreach_messages"
        + " (tenant_id, campaign_id, lead_id, to_email, to_name, subject, body_rendered, status)"
        + " VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, status",
        [DEFAULT_TENANT, campaignId, lead.id, lead.email ?? "", lead.company_name,
          renderTemplate(String(campaign.subject_template ?? ""), variables),
          renderTemplate(String(campaign.body_template ?? ""), variables),
          lead.email ? "pending" : "failed"] as never[],
      );
      messages.push((inserted as unknown as Row[])[0] as Row);
    }
    await sql.unsafe(
      "UPDATE outreach_campaigns SET status='sending', total_count=$3 WHERE id=$1 AND tenant_id=$2",
      [campaignId, DEFAULT_TENANT, messages.length] as never[],
    );
    let sent = 0;
    let failed = 0;
    for (const message of messages) {
      if (message.status === "failed") {
        failed += 1;
        continue;
      }
      const claimedRows = await sql.unsafe(
        "UPDATE outreach_messages SET status='sending' WHERE id=$1 AND tenant_id=$2"
        + " AND status='pending' RETURNING *",
        [message.id, DEFAULT_TENANT] as never[],
      );
      const claimed = (claimedRows as unknown as Row[])[0];
      if (!claimed) continue; // 已被抢占（幂等防重复）
      const outcome = await sendOne(sql, claimed, mailbox, env);
      if (outcome.status === "sent") sent += 1;
      else failed += 1;
    }
    await sql.unsafe(
      "UPDATE outreach_campaigns SET status='sent', sent_count=$3, failed_count=$4"
      + " WHERE id=$1 AND tenant_id=$2",
      [campaignId, DEFAULT_TENANT, sent, failed] as never[],
    );
    return { campaign_id: campaignId, total: messages.length, sent, failed };
  });
  return c.json(result);
}));

// ── 消息 ─────────────────────────────────────────────────────────────────────

// GET /api/v1/outreach/messages（chain.py:1899）
app.get("/api/v1/outreach/messages", (c) => respond(c, async () => {
  await requireUser(c);
  const query = parseQuery(z.object({
    campaign_id: z.coerce.number().int().optional(),
    lead_id: z.coerce.number().int().optional(),
    status: z.string().optional(),
    page: z.coerce.number().int().gte(1).default(1),
    page_size: z.coerce.number().int().gte(1).lte(200).default(20),
  }), c.req.query());
  const where = ["m.tenant_id = $1"];
  const params: unknown[] = [DEFAULT_TENANT];
  const filters: Array<[string, unknown]> = [
    ["m.campaign_id", query.campaign_id],
    ["m.lead_id", query.lead_id],
    ["m.status", query.status],
  ];
  for (const [col, value] of filters) {
    if (value !== undefined && value !== null) {
      params.push(value);
      where.push(col + " = $" + String(params.length));
    }
  }
  const whereSql = where.join(" AND ");
  const limitIdx = params.length + 1;
  const offsetIdx = params.length + 2;
  const payload = await withDb(getEnv(c), async (sql: Db) => {
    await requireSub(sql, "outreach");
    const totalRows = await sql.unsafe(
      "SELECT COUNT(*) AS n FROM outreach_messages m WHERE " + whereSql, params as never[],
    );
    const rows = await sql.unsafe(
      "SELECT m.id, m.campaign_id, m.lead_id, m.to_email, m.to_name, m.subject,"
      + " m.status, m.error, m.sent_at, m.opened_at, m.replied_at, m.created_at,"
      + " l.company_name AS lead_company"
      + " FROM outreach_messages m"
      + " LEFT JOIN lead_candidates l ON l.id = m.lead_id AND l.tenant_id = m.tenant_id"
      + " WHERE " + whereSql
      + " ORDER BY m.id DESC LIMIT $" + String(limitIdx) + " OFFSET $" + String(offsetIdx),
      [...params, query.page_size, (query.page - 1) * query.page_size] as never[],
    );
    const total = (totalRows as unknown as Row[])[0]?.n ?? 0;
    return { items: (rows as unknown as Row[]).map(pyRow), total: num(total) ?? 0 };
  });
  return c.json({
    items: payload.items, total: payload.total, page: query.page, page_size: query.page_size,
  });
}));

// GET /api/v1/outreach/messages/{message_id}（chain.py:1928）
app.get("/api/v1/outreach/messages/:message_id", (c) => respond(c, async () => {
  await requireUser(c);
  const messageId = Number(c.req.param("message_id"));
  const row = await withDb(getEnv(c), async (sql: Db) => {
    await requireSub(sql, "outreach");
    const rows = await sql.unsafe(
      "SELECT * FROM outreach_messages WHERE id=$1 AND tenant_id=$2",
      [messageId, DEFAULT_TENANT] as never[],
    );
    const found = (rows as unknown as Row[])[0];
    if (!found) {
      throw httpError(404, { error: "not_found", code: "MESSAGE_NOT_FOUND" });
    }
    return found;
  });
  return c.json(pyRow(row));
}));

// POST /api/v1/outreach/messages/{message_id}/retry（chain.py:1941）
app.post("/api/v1/outreach/messages/:message_id/retry", (c) => respond(c, async () => {
  await requireUser(c);
  const messageId = Number(c.req.param("message_id"));
  const env = getEnv(c);
  const result = await withDb(env, async (sql: Db) => {
    await requireSub(sql, "outreach");
    const rows = await sql.unsafe(
      "SELECT * FROM outreach_messages WHERE id=$1 AND tenant_id=$2",
      [messageId, DEFAULT_TENANT] as never[],
    );
    const msg = (rows as unknown as Row[])[0];
    if (!msg) {
      throw httpError(404, { error: "not_found", code: "MESSAGE_NOT_FOUND" });
    }
    if (msg.status !== "failed" && msg.status !== "bounced") {
      throw httpError(409, {
        error: "conflict", code: "NOT_RETRYABLE", detail: "仅 failed/bounced 可重发",
      });
    }
    let campaign: Row | undefined;
    if (msg.campaign_id) {
      const cRows = await sql.unsafe(
        "SELECT * FROM outreach_campaigns WHERE id=$1 AND tenant_id=$2",
        [msg.campaign_id, DEFAULT_TENANT] as never[],
      );
      campaign = (cRows as unknown as Row[])[0];
    }
    let mailbox: Row | undefined;
    if (campaign && campaign.mailbox_id) {
      const mbRows = await sql.unsafe(
        "SELECT * FROM outreach_mailboxes WHERE id=$1 AND tenant_id=$2",
        [campaign.mailbox_id, DEFAULT_TENANT] as never[],
      );
      mailbox = (mbRows as unknown as Row[])[0];
    } else {
      mailbox = await defaultMailbox(sql);
    }
    if (!mailbox) {
      throw httpError(422, { error: "validation", code: "NO_DEFAULT_MAILBOX" });
    }
    const outcome = await sendOne(sql, msg, mailbox, env);
    return { id: messageId, ...outcome };
  });
  return c.json(result);
}));

// POST /api/v1/outreach/webhook（chain.py:1977）：Inbound 预留桩，恒 501
app.post("/api/v1/outreach/webhook", (c) => respond(c, async () => {
  throw httpError(501, {
    error: "not_implemented", code: "INBOUND_WEBHOOK_RESERVED",
    detail: "Inbound webhook reserved — manual scan available via POST /api/v1/leads/scan-replied",
  });
}));

export default app;
