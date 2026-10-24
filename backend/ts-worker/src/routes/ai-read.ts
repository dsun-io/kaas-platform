// AI 配置/用量只读端点（AUTH_DB_SPLIT=on 时启用）—— P3 只读迁移批次。
//
// 真源逐条直译：
// - GET /api/v1/ai/providers   backend/worker/src/chain.py:583-596 ai_list_providers
// - GET /api/v1/ai/usage       backend/worker/src/chain.py:710-747 ai_usage
// 表类型真源：backend/orchestrator/alembic/versions/20260921_ai_layer.py。
//
// 边界：只做「取数 + 投影」；AI 调用/路由/模板全在内核（本文件不碰）。
// 鉴权闸门 = 内核 chain._require_ai_admin → main._require_platform_ops：
// internal 账号 + 管理员角色，否则 403 {"error":"forbidden","message":"Platform operator required"}。
//
// 开关：off（默认）⇒ **原样 forwardKernelRequest**（与 createProxyApp 同一句）；
//       on ⇒ 先判开关 ⇒ requireUser + 门面直连。**必须在 /api/v1/ai 透传 mount 之前注册**。
//
// 未迁（需内核常量/引擎，见交付说明）：/ai/tasks、/ai/task-bindings —— 响应顺序与默认值
// 依赖 chain.py 的 TASKS 任务目录（业务元数据常量），镜像即第二份；留内核。
import { Hono, type Context } from "hono";
import { z } from "zod";

import { useDirectRoute } from "../boot-flag";
import { withDb, type Db } from "../db";
import { getEnv, type Env } from "../env";
import { directDb } from "../hot-read";
import { httpError, num, num0, parseQuery, pyIso, respond } from "../http";
import { forwardKernelRequest } from "../proxy";
import { isAdminRole } from "../rules";
import { requireUser, type CurrentUser } from "../session";

const DEFAULT_TENANT = "default";

/** 行别名（只按列名读取）。 */
type Row = Record<string, unknown>;

// chain.py:256-260 PROVIDER_DEFAULTS（顺序即响应 items 顺序；新增 Provider 必须同步本表）。
const PROVIDER_DEFAULTS: Record<string, { base_url: string; model: string }> = {
  deepseek: { base_url: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  kimi: { base_url: "https://api.moonshot.cn/v1", model: "kimi-k2-0905-preview" },
  zhipu: { base_url: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4" },
};

// FastAPI 的 int 查询参数：空串/非整数 → 422（不静默 coerce 成 0）。
const INT_QUERY = z.string()
  .regex(/^-?\d+$/, "Input should be a valid integer")
  .transform(Number);

/** chain._require_ai_admin → main._require_platform_ops：internal + 管理员。 */
function requireAiAdmin(user: CurrentUser): void {
  if (user.account_type !== "internal" || !isAdminRole(user.role)) {
    throw httpError(403, { error: "forbidden", message: "Platform operator required" });
  }
}

/** chain.py:92-95 _mask：空 → null；≤8 位 → ****；否则首4+****+尾4。 */
export function maskApiKey(key: unknown): string | null {
  if (key === null || key === undefined || String(key) === "") return null;
  const text = String(key);
  return text.length <= 8 ? "****" : text.slice(0, 4) + "****" + text.slice(-4);
}

/** chain.py:573-580 _row_to_provider：8 键（含 defaults 回落）。 */
function providerOut(row: Row): Row {
  const name = String(row.provider);
  return {
    provider: row.provider ?? null,
    api_key_masked: maskApiKey(row.api_key),
    has_key: Boolean(row.api_key),
    model: row.model ?? null,
    base_url: row.base_url ?? null,
    enabled: row.enabled ?? false,
    default_model: PROVIDER_DEFAULTS[name]?.model ?? null,
    default_base_url: PROVIDER_DEFAULTS[name]?.base_url ?? null,
  };
}

/** GET /api/v1/ai/providers（chain.py:583-596）→ {items: 8 键 × PROVIDER_DEFAULTS 顺序}。 */
export async function listAiProvidersDirect(
  c: Context,
  user: CurrentUser,
): Promise<Response> {
  requireAiAdmin(user);
  const rows = (await withDb(getEnv(c), (sql: Db) =>
    sql.unsafe("SELECT * FROM ai_providers WHERE tenant_id=$1", [DEFAULT_TENANT] as never[]),
  )) as unknown as Row[];
  const existing = new Map<string, Row>();
  for (const row of rows) existing.set(String(row.provider), row);
  // 顺序 = PROVIDER_DEFAULTS 的插入顺序（Python dict 迭代序）；DB 里有但目录外的 provider 忽略
  const items = Object.keys(PROVIDER_DEFAULTS).map((name) => {
    const row = existing.get(name);
    if (row) return providerOut(row);
    return {
      provider: name,
      api_key_masked: null,
      has_key: false,
      model: null,
      base_url: null,
      enabled: false,
      default_model: PROVIDER_DEFAULTS[name]!.model,
      default_base_url: PROVIDER_DEFAULTS[name]!.base_url,
    };
  });
  return c.json({ items });
}

const usageQuery = z.object({
  task_key: z.string().optional(),
  provider: z.string().optional(),
  status: z.string().optional(),
  page: INT_QUERY.optional(),
  page_size: INT_QUERY.optional(),
});

/** GET /api/v1/ai/usage（chain.py:710-747）—— 纯 SQL 聚合（COUNT / 分页 / GROUP BY）。 */
export async function listAiUsageDirect(
  c: Context,
  user: CurrentUser,
): Promise<Response> {
  requireAiAdmin(user);
  const query = parseQuery(usageQuery, c.req.query());
  const page = query.page ?? 1;
  const pageSize = query.page_size ?? 20;
  if (page < 1) {
    throw httpError(422, [{
      type: "greater_than_equal", loc: ["query", "page"],
      msg: "Input should be greater than or equal to 1", input: String(page),
    }]);
  }
  if (pageSize < 1 || pageSize > 200) {
    throw httpError(422, [{
      type: pageSize < 1 ? "greater_than_equal" : "less_than_equal",
      loc: ["query", "page_size"],
      msg: pageSize < 1
        ? "Input should be greater than or equal to 1"
        : "Input should be less than or equal to 200",
      input: String(pageSize),
    }]);
  }

  // 与内核一致：三个筛选用**真值**判断（空串不算），参数顺序 task_key → provider → status
  const where: string[] = ["tenant_id = $1"];
  const params: unknown[] = [DEFAULT_TENANT];
  const filters: Array<[string, string]> = [
    ["task_key", query.task_key ?? ""],
    ["provider", query.provider ?? ""],
    ["status", query.status ?? ""],
  ];
  for (const [column, value] of filters) {
    if (!value) continue;
    params.push(value);
    where.push(column + " = $" + String(params.length));
  }
  const whereSql = where.join(" AND ");
  // 分页参数：LIMIT/OFFSET 用「params 之后」的两个占位符（与内核 $idx / $idx+1 同序）
  const limitIndex = params.length + 1;
  const offsetIndex = params.length + 2;

  const payload = await withDb(getEnv(c), async (sql: Db) => {
    const totalRows = (await sql.unsafe(
      "SELECT COUNT(*) FROM ai_usage WHERE " + whereSql,
      params as never[],
    )) as unknown as Row[];
    const rows = (await sql.unsafe(
      "SELECT id, task_key, provider, model, prompt_tokens, completion_tokens,"
      + " cost_usd, status, error, latency_ms, created_at"
      + " FROM ai_usage WHERE " + whereSql
      + " ORDER BY created_at DESC LIMIT $" + String(limitIndex)
      + " OFFSET $" + String(offsetIndex),
      [...params, pageSize, (page - 1) * pageSize] as never[],
    )) as unknown as Row[];
    // stats **不带筛选**（内核同样只用 tenant 过滤），GROUP BY 由 PG 完成
    const stats = (await sql.unsafe(
      "SELECT task_key, provider, status, COUNT(*) AS cnt,"
      + " COALESCE(SUM(prompt_tokens),0) AS prompt_tokens,"
      + " COALESCE(SUM(completion_tokens),0) AS completion_tokens"
      + " FROM ai_usage WHERE tenant_id=$1"
      + " GROUP BY task_key, provider, status",
      [DEFAULT_TENANT] as never[],
    )) as unknown as Row[];
    return { totalRows, rows, stats };
  });

  return c.json({
    items: payload.rows.map((row) => ({
      id: num(row.id),
      task_key: row.task_key ?? null,
      provider: row.provider ?? null,
      model: row.model ?? null,
      prompt_tokens: num(row.prompt_tokens),
      completion_tokens: num(row.completion_tokens),
      cost_usd: row.cost_usd === null || row.cost_usd === undefined
        ? null : Number(row.cost_usd),
      status: row.status ?? null,
      error: row.error ?? null,
      latency_ms: num(row.latency_ms),
      created_at: pyIso(row.created_at ?? null),
    })),
    total: num0(payload.totalRows[0]?.count),
    page,
    page_size: pageSize,
    stats: payload.stats.map((stat) => ({
      task_key: stat.task_key ?? null,
      provider: stat.provider ?? null,
      status: stat.status ?? null,
      count: num0(stat.cnt),
      prompt_tokens: num0(stat.prompt_tokens),
      completion_tokens: num0(stat.completion_tokens),
    })),
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// 路由注册（由 src/index.ts 挂载在 /api/v1/ai 透传 mount **之前**）：
// 只注册这两条 GET —— /ai/* 其余（tasks/run/providers 写/绑定写）仍走透传。
// off 时是**原样** forwardKernelRequest（与 createProxyApp 同一句）。
// ══════════════════════════════════════════════════════════════════════════════

const app = new Hono<{ Bindings: Env }>();

app.get("/api/v1/ai/providers", (c) => {
  if (useDirectRoute(getEnv(c), "ai.providers")) {
    return respond(c, async () => {
      const user = await requireUser(c);
      return directDb(c, () => listAiProvidersDirect(c, user));
    });
  }
  return forwardKernelRequest(c);
});

app.get("/api/v1/ai/usage", (c) => {
  if (useDirectRoute(getEnv(c), "ai.usage")) {
    return respond(c, async () => {
      const user = await requireUser(c);
      return directDb(c, () => listAiUsageDirect(c, user));
    });
  }
  return forwardKernelRequest(c);
});

export default app;
