/**
 * P0 热读直连 · 产品清单 / 产品资料 / 产品图（`AUTH_DB_SPLIT=on` 时启用）。
 *
 * 设计 = docs/ARCH_AUTH_DB_SPLIT_2026-10-24.md §3.2（控制台热路径 P0）：产品页首屏
 * 在事故中成片 502 —— 把这三条只读 GET 从「透传 Python 内核」改为「门面直连 Hyperdrive」，
 * 页面首屏不再依赖 Pyodide 冷启动。
 *
 * 真源（SQL / 序列化逐条直译，禁止顺手"优化"）：
 * - backend/worker/src/ws_files.py:385-431 `list_products`
 * - backend/worker/src/ws_files.py:438-463 `get_profile`
 * - backend/worker/src/ws_files.py:503-512 `list_media`
 * 纯函数镜像在 src/rules.ts（product_scope.py / product_names.py）；产品注册表标量在
 * src/product-registry.ts。
 *
 * ── 边界（ADR-008 铁纪律）──────────────────────────────────────────────────
 * - 只做「取数 + 投影」：没有任何业务 if，不计算口径（报价引擎/规格校验一律不碰）；
 * - 鉴权仍是 requireUser（401 不打到 DB / 内核）；团队可见性由 teamScope* 与
 *   productInfoAccess 两把尺决定（逐行镜像，见 src/hot-read.ts / src/rules.ts）；
 * - `AUTH_DB_SPLIT` off（默认）⇒ 本文件一行 SQL 都不跑，原样 `forwardKernelRequest`，
 *   行为与今天完全一致（一键回退路径，见 src/boot-flag.ts）。
 */
import { Hono, type Context } from "hono";

import { DIRECT_ROUTE_IDS, useDirectRoute } from "../boot-flag";
import { withDb, type Db } from "../db";
import { getEnv, type Env } from "../env";
import { directDb, teamScope, teamScopeSoft } from "../hot-read";
import { httpError, num, num0, pyIso, respond } from "../http";
import { PRODUCT_KEYS, PRODUCT_REGISTRY } from "../product-registry";
import { forwardKernelRequest } from "../proxy";
import {
  MEDIA_KIND_LABELS,
  nameEnListFromInfo,
  normalizedProductInfo,
  PRODUCT_ACCESS_REASON,
  productInfoAccess,
} from "../rules";
import { requireUser, type CurrentUser } from "../session";

const DEFAULT_TENANT = "default";
type Row = Record<string, unknown>;

/** ws_files.py:127-131 `_META_COLS`（逐列同序；file_objects 无 jsonb 列）。 */
const META_COLS =
  "id, tenant_id, team_id, owner_type, owner_id, kind, media_kind, name, storage, "
  + "object_key, file_name, content_type, file_size, sha256, version, supersedes_id, "
  + "is_current, is_primary, sort_order, uploaded_by, created_at";

/** ws_files.py:138-140 `_FILE_ORDER_BY`：主图恒最前 → 自定义位次 → id 兜底（展示顺序唯一口径）。 */
const FILE_ORDER_BY = "is_primary DESC, sort_order, id";

/** 产品图类型标签（真源 kaas_common/files/rules.py:39-45，已镜像在 rules.ts）。 */
const MEDIA_KINDS = MEDIA_KIND_LABELS;

/** ws_files.py:147-154 `_row_to_file`：created_at → isoformat；6 个 BIGINT 列 → int。 */
function rowToFile(row: Row): Row {
  const out: Row = { ...row };
  if (out.created_at !== null && out.created_at !== undefined) {
    out.created_at = pyIso(out.created_at);
  }
  for (const key of [
    "id",
    "team_id",
    "file_size",
    "version",
    "supersedes_id",
    "sort_order",
  ]) {
    if (out[key] !== null && out[key] !== undefined) out[key] = num(out[key]);
  }
  return out;
}

/**
 * ws_files.py:409-430 的单条投影：注册表标量 + 团队资料里的英文名 + 当前图片数。
 *
 * 英文名口径（ws_files.py:413-418）：**团队资料优先于代码注册表**（系统产品没有
 * tenant_products 行，改英文名只能落在 product_profiles.info）；没配资料时回落
 * 注册表 `name_en`（旧响应逐字不变）。主名 = `names[0]`，其余算地区别名。
 */
function productItemOut(key: string, info: unknown, mediaCount: number): Row {
  const spec = PRODUCT_REGISTRY[key]!;
  const fromProfile = nameEnListFromInfo(info);
  const names = fromProfile.length
    ? fromProfile
    : spec.nameEn
      ? [spec.nameEn]
      : [];
  const primary = names.length ? names[0]! : "";
  return {
    product_key: key,
    name: spec.name || key,
    name_en: primary || spec.nameEn,
    name_en_aliases: names.slice(1),
    name_en_list: names,
    category_code: spec.categoryCode,
    media_count: mediaCount,
    profile: info,
  };
}

/**
 * ws_files.py:110-125 `_require_profile_visible`：按团队判可见性
 * （403 NO_TEAM / 404 PROFILE_NOT_FOUND，**同一个错误码对外不可区分**）。
 */
function requireProfileVisible(user: CurrentUser, row: Row): void {
  const decision = productInfoAccess({
    role: user.role,
    viewerTeamId: user.team_id,
    rowTeamId: row.team_id,
  });
  if (decision.allowed) return;
  if (decision.reason === PRODUCT_ACCESS_REASON.NO_TEAM) {
    throw httpError(403, { error: "forbidden", code: "NO_TEAM" });
  }
  throw httpError(404, { error: "not_found", code: "PROFILE_NOT_FOUND" });
}

/**
 * GET /api/v1/products（ws_files.py:385-431）
 * → `{items: ProductRow[], media_kinds}`。
 */
export async function listProductsDirect(c: Context, user: CurrentUser): Promise<Response> {
  const payload = await withDb(getEnv(c), async (sql: Db) => {
    // ① 每个产品的「当前件」图片数（ws_files.py:390-397）：soft 尺 ⇒ 无团队不去 403，
    //    私有部分为空、产品定义照旧返回（Q6 两层不压平）。
    const [mediaFrag, mediaExtra] = teamScopeSoft(user, 2);
    const mediaRows = (await sql.unsafe(
      "SELECT owner_id, COUNT(*) AS n FROM file_objects WHERE tenant_id=$1"
      + " AND owner_type='product' AND kind='product_photo' AND is_current"
      + mediaFrag
      + " GROUP BY owner_id",
      [DEFAULT_TENANT, ...mediaExtra] as never[],
    )) as unknown as Row[];
    const media = new Map<string, number>();
    for (const row of mediaRows) media.set(String(row.owner_id), num0(row.n));

    // ② 团队可见的产品资料（ws_files.py:398-408）：'最近更新的那次生效' —
    //    同一 key 多团队各一行时按 updated_at DESC 取首行（与 quote_api._quotable_specs 同口径）。
    const [profFrag, profExtra] = teamScopeSoft(user, 2);
    const profRows = (await sql.unsafe(
      "SELECT product_key, info FROM product_profiles WHERE tenant_id=$1"
      + profFrag
      + " ORDER BY updated_at DESC",
      [DEFAULT_TENANT, ...profExtra] as never[],
    )) as unknown as Row[];
    const profiles = new Map<string, unknown>();
    for (const row of profRows) {
      const key = String(row.product_key);
      // Python dict.setdefault：先到（= updated_at 更晚）者生效
      if (!profiles.has(key)) profiles.set(key, row.info);
    }

    // ③ 注册表 keys（sorted）+ 展示字段（ws_files.py:409-430）
    const items = PRODUCT_KEYS.map((key) => {
      const raw = profiles.get(key);
      // Python `profiles.get(key) or {}`：None / 空值一律回落空资料
      const info: unknown = raw ? raw : {};
      return productItemOut(key, info, media.get(key) ?? 0);
    });
    return { items, media_kinds: MEDIA_KINDS };
  });
  return c.json(payload);
}

/**
 * GET /api/v1/products/{product_key}/profile（ws_files.py:438-463）
 * → `{product_key, info, updated_at}`。
 *
 * 注意：**行不存在不是 404** —— 产品定义人人可读，只是资料为空
 * （`info: {}` / `updated_at: null`）；行存在但不可见才 403/404（见上）。
 */
export async function getProductProfileDirect(
  c: Context,
  user: CurrentUser,
): Promise<Response> {
  const productKey = c.req.param("product_key") ?? "";
  const payload = await withDb(getEnv(c), async (sql: Db) => {
    const rows = (await sql.unsafe(
      "SELECT product_key, info, updated_at, team_id FROM product_profiles"
      + " WHERE tenant_id=$1 AND product_key=$2",
      [DEFAULT_TENANT, productKey] as never[],
    )) as unknown as Row[];
    const row = rows[0];
    if (row) requireProfileVisible(user, row);
    // `info` 有两种形状：dbjson 解码后的 dict，或漏登记时的 JSON 字符串（ws_files.py:448-457）
    const info = row ? row.info : null;
    let parsed: unknown = info;
    if (typeof info === "string") {
      try {
        parsed = JSON.parse(info);
      } catch {
        parsed = {}; // 坏值回落 {} 而不是 500（只读探针不能把整页打成错误页）
      }
    }
    return {
      product_key: productKey,
      info: normalizedProductInfo(parsed),
      updated_at: row && row.updated_at ? pyIso(row.updated_at) : null,
    };
  });
  return c.json(payload);
}

/**
 * GET /api/v1/products/{product_key}/media（ws_files.py:503-512）
 * → `{items: ProductMedia[], media_kinds}`，排序 `is_primary DESC, sort_order, id`。
 *
 * 与清单不同：这里用**硬**团队尺（产品图是团队私有资产）⇒ 非管理员无团队 403 NO_TEAM。
 */
export async function listProductMediaDirect(
  c: Context,
  user: CurrentUser,
): Promise<Response> {
  const productKey = c.req.param("product_key") ?? "";
  // ws_files.py:509 的 `_team_scope(user, 3)`：参数已占 2 个 ⇒ 谓词从 $3 起
  const [teamFrag, teamExtra] = teamScope(user, 3);
  const rows = (await withDb(getEnv(c), (sql: Db) =>
    sql.unsafe(
      "SELECT " + META_COLS + " FROM file_objects WHERE tenant_id=$1 AND owner_type='product'"
      + " AND owner_id=$2 AND kind='product_photo' AND is_current"
      + teamFrag
      + " ORDER BY " + FILE_ORDER_BY,
      [DEFAULT_TENANT, productKey, ...teamExtra] as never[],
    ))) as unknown as Row[];
  return c.json({ items: rows.map(rowToFile), media_kinds: MEDIA_KINDS });
}

// ══════════════════════════════════════════════════════════════════════════════
// 路由注册（由 src/index.ts 挂载）：每请求判定灰度开关
// ══════════════════════════════════════════════════════════════════════════════

const app = new Hono<{ Bindings: Env }>();

type DirectHandler = (c: Context, user: CurrentUser) => Promise<Response>;

/**
 * 开关骨架：**先鉴权**（401 不打到 DB/内核，与今天一致）→ 开关 on 走直连 SQL，
 * off 原样透传内核（`forwardKernelRequest`，与迁出前 workstations.ts 的写法逐字同义）。
 */
function p0Route(routeId: string, direct: DirectHandler) {
  return (c: Context<{ Bindings: Env }>) =>
    respond(c, async () => {
      const user = await requireUser(c);
      if (useDirectRoute(getEnv(c), routeId)) {
        return directDb(c, () => direct(c, user));
      }
      return forwardKernelRequest(c);
    });
}

app.get("/api/v1/products", p0Route(DIRECT_ROUTE_IDS.productsList, listProductsDirect));
app.get(
  "/api/v1/products/:product_key/profile",
  p0Route(DIRECT_ROUTE_IDS.productsProfile, getProductProfileDirect),
);
app.get(
  "/api/v1/products/:product_key/media",
  p0Route(DIRECT_ROUTE_IDS.productsMedia, listProductMediaDirect),
);

export default app;
