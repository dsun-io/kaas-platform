/**
 * KaaS TS 门面 · files 域（9 条路由）。
 *
 * 真源逐条对齐 backend/worker/src/ws_files.py（Python 侧即生产契约真源）：
 * - PATCH  /api/v1/file-objects/{file_id}                ws_files.py:496  patch_file
 * - DELETE /api/v1/file-objects/{file_id}                ws_files.py:545  retire_file
 * - GET    /api/v1/file-objects/{file_id}/content        ws_files.py:558  get_file_content
 * - GET    /api/v1/file-objects                          ws_files.py:574  list_files
 * - GET    /api/v1/file-objects/{file_id}/render-content ws_files.py:977  get_file_render_content
 * - POST   /api/v1/file-objects/presign                  ws_files.py:1037 presign_upload
 * - POST   /api/v1/file-objects/register                 ws_files.py:1053 register_upload
 * - GET    /api/v1/file-objects/_r2_debug                ws_files.py:1066 r2_debug
 * - GET    /api/v1/file-objects/{file_id}/url            ws_files.py:1111 get_file_url
 *
 * 业务规则（上传校验 / key 规划 / 版本化）只在 rules.ts 镜像（kaas_common/files/rules.py
 * 的逐行直译，TODO(TODO:TS3) 换 KERNEL）；本文件只做鉴权 / 协议转换 / SQL 直译。
 *
 * 存储落点（对齐 Python _store_bytes / _load_bytes 的优先级）：
 *   (1) S3 预签名（需 S3_ACCESS_KEY / S3_SECRET_KEY）→ (2) R2 binding（env.FILES）→ (3) inline。
 * TS 侧未实现 SigV4 预签名（TODO(TODO:TS5)）：presign 恒 {configured:false}（前端回退
 * 代理上传），读字节走 (2)/(3)，与 Python「无 S3 密钥」时的行为逐字一致。
 */
import { Hono } from "hono";
import { z } from "zod";

import { withDb, type Db } from "../db";
import { getEnv, type Env } from "../env";
import { httpError, num, parseBody, parseQuery, pyIso, respond } from "../http";
import {
  MEDIA_KIND_LABELS,
  RuleError,
  currentFileOf,
  fileObjectKey,
  nextFileVersion,
  validateFileUpload,
} from "../rules";
import { requireUser, type CurrentUser } from "../session";
import { ws_files_FilePatch, ws_files_PresignIn, ws_files_RegisterIn } from "../generated/schemas";

const app = new Hono<{ Bindings: Env }>();

const DEFAULT_TENANT = "default";

/** 与 Python ws_files.py:120 _META_COLS 逐字一致（列表/详情输出列集）。 */
const META_COLS =
  "id, tenant_id, team_id, owner_type, owner_id, kind, media_kind, name, storage, "
  + "object_key, file_name, content_type, file_size, sha256, version, supersedes_id, "
  + "is_current, is_primary, sort_order, uploaded_by, created_at";

/** 展示顺序唯一口径（ws_files.py:133）。 */
const FILE_ORDER_BY = "is_primary DESC, sort_order, id";
/** 排序值上界（ws_files.py:137）。 */
const MAX_SORT_ORDER = 9999;
/** 渲染直链 TTL（kaas_common/files/token.py:DEFAULT_ASSET_TTL）。 */
const ASSET_TTL_SECONDS = 900;

type Row = Record<string, unknown>;

/** R2 binding 的最小结构（避免把 workers-types 的全局类型耦合进本模块）。 */
interface R2Like {
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  put(
    key: string,
    value: string | ArrayBuffer | Uint8Array,
    opts?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
}

// ── Q6 行级团队谓词（ws_files.py:72-89 逐行对齐）─────────────────────────────
// 管理员 ⇒ 不加谓词；有团队 ⇒ AND <col>=$n；无团队 ⇒ 403 NO_TEAM。
export function teamScope(
  user: CurrentUser,
  nextIndex: number,
  col = "team_id",
): { frag: string; extra: unknown[] } {
  if (isAdminUser(user)) return { frag: "", extra: [] };
  if (user.team_id === null || user.team_id === undefined) {
    throw httpError(403, { error: "forbidden", code: "NO_TEAM" });
  }
  return { frag: " AND " + col + "=$" + String(nextIndex), extra: [user.team_id] };
}

/** 旧角色映射（rules.ts:18 ROLE_MAP 的同一把尺：admin 等价 system_admin）。 */
export function isAdminUser(user: CurrentUser): boolean {
  const role = user.role ?? "";
  return role === "system_admin" || role === "admin";
}

/** ws_files.py:140 _row_to_file：created_at → isoformat，6 个列转 int。 */
export function rowToFile(row: Row): Record<string, unknown> {
  const out: Record<string, unknown> = { ...row };
  out.created_at = pyIso(out.created_at);
  for (const key of ["id", "team_id", "file_size", "version", "supersedes_id", "sort_order"]) {
    if (out[key] !== null && out[key] !== undefined) out[key] = num(out[key]);
  }
  return out;
}

/** ws_files.py:150 _fail：FileRuleError → 422 {error:validation, code, detail}。 */
function fileRule422(err: RuleError): never {
  throw httpError(422, { error: "validation", code: err.code, detail: err.detail });
}

/** PR_SLUG 预览前缀（kaas_common/preview.py:32-57：非法值降级生产行为）。 */
export function prefixedKey(key: string, env: Env): string {
  const raw = String(env.PR_SLUG ?? "").trim();
  if (!raw || !/^[0-9]{1,9}$/.test(raw)) return key;
  const prefix = "pr-" + raw + "/";
  return key.startsWith(prefix) ? key : prefix + key;
}

/** R2 binding 读取（对齐 ws_files.py:190 _r2_bucket）。 */
export function r2Bucket(env: Env): R2Like | null {
  const bucket = env.FILES as unknown as R2Like | undefined;
  return bucket && typeof bucket.get === "function" ? bucket : null;
}

// ── 端点 ─────────────────────────────────────────────────────────────────────

// GET /api/v1/file-objects（ws_files.py:574 list_files）
app.get("/api/v1/file-objects", (c) => respond(c, async () => {
  const user = await requireUser(c);
  const query = parseQuery(z.object({
    owner_type: z.string(),
    owner_id: z.union([z.string(), z.null()]).optional(),
    kind: z.union([z.string(), z.null()]).optional(),
  }), c.req.query());
  const ownerId = query.owner_id ?? null;
  const params: unknown[] = [DEFAULT_TENANT, query.owner_type, ownerId];
  let sqlText = "SELECT " + META_COLS + " FROM file_objects WHERE tenant_id=$1 AND owner_type=$2"
    + " AND coalesce(owner_id,'')=coalesce($3,'') AND is_current";
  if (query.kind) {
    params.push(query.kind);
    sqlText += " AND kind=$" + String(params.length);
  }
  const scope = teamScope(user, params.length + 1);
  sqlText += scope.frag;
  params.push(...scope.extra);
  sqlText += " ORDER BY " + FILE_ORDER_BY;
  const rows = await withDb(getEnv(c), (sql: Db) => sql.unsafe(sqlText, params as never[]));
  return c.json({ items: (rows as unknown as Row[]).map(rowToFile) });
}));

// GET /api/v1/file-objects/_r2_debug（ws_files.py:1066；平台管理员自检端点）
// 必须注册在 /:file_id 之前，否则 "_r2_debug" 会被当成 file_id。
app.get("/api/v1/file-objects/_r2_debug", (c) => respond(c, async () => {
  const user = await requireUser(c);
  if (!isAdminUser(user)) {
    throw httpError(403, {
      error: "forbidden", code: "ADMIN_ONLY", message: "诊断端点仅平台管理员可用",
    });
  }
  const key = c.req.query("key") ?? "_debug/r2-test.txt";
  const out: Record<string, unknown> = {
    platform: "workers", binding: false, put_ok: false, get_ok: false,
  };
  const bucket = r2Bucket(getEnv(c));
  out.binding = bucket !== null;
  if (bucket === null) return c.json(out);
  try {
    await bucket.put(key, "kaas-debug", { httpMetadata: { contentType: "text/plain" } });
    out.put_ok = true;
  } catch (err) {
    out.put_error = String((err as Error)?.name ?? "Error") + ": " + String((err as Error)?.message ?? err);
  }
  try {
    const obj = await bucket.get(key);
    out.get_obj_none = obj === null;
    if (obj !== null) {
      const buf = await obj.arrayBuffer();
      out.bytes_len = buf.byteLength;
      out.get_ok = true;
    }
  } catch (err) {
    out.get_error = String((err as Error)?.name ?? "Error") + ": " + String((err as Error)?.message ?? err);
  }
  return c.json(out);
}));

// POST /api/v1/file-objects/presign（ws_files.py:1037）
app.post("/api/v1/file-objects/presign", (c) => respond(c, async () => {
  await requireUser(c);
  const body = await parseBody(c, ws_files_PresignIn);
  validateDirect(body);
  // TODO(TODO:TS5)：SigV4 预签名未实现（Python 走 kaas_common/files/s3.py）。
  // 语义差异登记：恒 {configured:false} ⇒ 前端回退代理上传；Python 配了密钥时返回 upload_url。
  return c.json({ configured: false });
}));

// POST /api/v1/file-objects/register（ws_files.py:1053 register_upload）
app.post("/api/v1/file-objects/register", (c) => respond(c, async () => {
  const user = await requireUser(c);
  const body = await parseBody(c, ws_files_RegisterIn);
  const sha = validateDirect(body);
  const env = getEnv(c);
  // 直传已把字节放到对象存储 ⇒ 只登记元数据（pre_uploaded = ("s3", key)）
  const key = prefixedKey(fileObjectKey({
    tenantId: DEFAULT_TENANT,
    ownerType: body.owner_type,
    ownerId: body.owner_id ?? null,
    kind: body.kind,
    mediaKind: body.media_kind ?? null,
    sha256: sha,
    contentType: body.content_type,
    fileName: body.file_name ?? null,
  }), env);
  const row = await withDb(env, (sql: Db) => sql.begin(async (tx) => {
    let version = 1;
    let supersedesId: unknown = null;
    if (body.supersede) {
      const params: unknown[] = [DEFAULT_TENANT, body.owner_type, body.owner_id ?? null, body.kind];
      let q = "SELECT " + META_COLS + " FROM file_objects WHERE tenant_id=$1 AND owner_type=$2"
        + " AND coalesce(owner_id,'')=coalesce($3,'') AND kind=$4";
      if (body.media_kind !== null && body.media_kind !== undefined) {
        params.push(body.media_kind);
        q += " AND coalesce(media_kind,'')=coalesce($" + String(params.length) + ",'')";
      }
      const scope = teamScope(user, params.length + 1);
      q += scope.frag;
      params.push(...scope.extra);
      q += " ORDER BY version DESC";
      const current = currentFileOf(await tx.unsafe(q, params as never[]) as unknown as Row[]);
      if (current) {
        const next = nextFileVersion(current);
        version = next[0];
        supersedesId = next[1];
        await tx.unsafe("UPDATE file_objects SET is_current=false, updated_at=now() WHERE id=$1",
          [current.id] as never[]);
      }
    }
    const rows = await tx.unsafe(
      "INSERT INTO file_objects (tenant_id, team_id, owner_type, owner_id, kind,"
      + " media_kind, name, storage, object_key, content, file_name, content_type,"
      + " file_size, sha256, version, supersedes_id, is_current, uploaded_by)"
      + " VALUES ($1,$2,$3,$4,$5,$6,$7,'s3',$8,NULL,$9,$10,$11,$12,$13,$14,true,$15)"
      + " RETURNING " + META_COLS,
      [DEFAULT_TENANT, user.team_id, body.owner_type, body.owner_id ?? null, body.kind,
        body.media_kind ?? null, body.name.trim(), key, body.file_name ?? null,
        body.content_type, body.size, sha, version, supersedesId,
        String(user.id)] as never[],
    );
    return (rows as unknown as Row[])[0] as Row;
  }));
  return c.json(rowToFile(row), 201);
}));

// PATCH /api/v1/file-objects/{file_id}（ws_files.py:496 patch_file）
app.patch("/api/v1/file-objects/:file_id", (c) => respond(c, async () => {
  const user = await requireUser(c);
  const fileId = Number(c.req.param("file_id"));
  const body = await parseBody(c, ws_files_FilePatch);
  await withDb(getEnv(c), async (sql: Db) => {
    const scope = teamScope(user, 3, "team_id");
    const rows = await sql.unsafe(
      "SELECT " + META_COLS + " FROM file_objects WHERE tenant_id=$1 AND id=$2" + scope.frag,
      [DEFAULT_TENANT, fileId, ...scope.extra] as never[],
    );
    const row = (rows as unknown as Row[])[0];
    if (!row) {
      throw httpError(404, { error: "not_found", code: "FILE_NOT_FOUND" });
    }
    if (body.name !== null && body.name !== undefined) {
      const label = body.name.trim();
      if (!label) {
        throw httpError(422, { error: "validation", code: "NAME_REQUIRED", detail: "名称不能为空" });
      }
      if (label.length > 80) {
        throw httpError(422, { error: "validation", code: "NAME_TOO_LONG", detail: "名称最长 80 个字符" });
      }
      const upd = teamScope(user, 3);
      await sql.unsafe(
        "UPDATE file_objects SET name=$1, updated_at=now() WHERE id=$2" + upd.frag,
        [label, fileId, ...upd.extra] as never[],
      );
    }
    if (body.is_primary !== null && body.is_primary !== undefined) {
      if (body.is_primary) {
        // 只降**本团队**的其它主图（别团队的图不该被我们顶掉）
        const demote = teamScope(user, 5);
        await sql.unsafe(
          "UPDATE file_objects SET is_primary=false, updated_at=now() WHERE tenant_id=$1"
          + " AND owner_type=$2 AND coalesce(owner_id,'')=coalesce($3,'') AND kind=$4" + demote.frag,
          [DEFAULT_TENANT, row.owner_type, row.owner_id, row.kind, ...demote.extra] as never[],
        );
      }
      const setPrimary = teamScope(user, 3);
      await sql.unsafe(
        "UPDATE file_objects SET is_primary=$1, updated_at=now() WHERE id=$2" + setPrimary.frag,
        [body.is_primary, fileId, ...setPrimary.extra] as never[],
      );
    }
    if (body.sort_order !== null && body.sort_order !== undefined) {
      if (body.sort_order < 0 || body.sort_order > MAX_SORT_ORDER) {
        throw httpError(422, {
          error: "validation", code: "SORT_ORDER_OUT_OF_RANGE",
          detail: "排序值需在 0 ~ " + String(MAX_SORT_ORDER) + " 之间",
        });
      }
      const setSort = teamScope(user, 3);
      await sql.unsafe(
        "UPDATE file_objects SET sort_order=$1, updated_at=now() WHERE id=$2" + setSort.frag,
        [body.sort_order, fileId, ...setSort.extra] as never[],
      );
    }
    return null;
  });
  return c.json({ ok: true });
}));

// DELETE /api/v1/file-objects/{file_id}（ws_files.py:545；软删 = is_current/is_primary 置 false）
app.delete("/api/v1/file-objects/:file_id", (c) => respond(c, async () => {
  const user = await requireUser(c);
  const fileId = Number(c.req.param("file_id"));
  const scope = teamScope(user, 3);
  const rows = await withDb(getEnv(c), (sql: Db) => sql.unsafe(
    "UPDATE file_objects SET is_current=false, is_primary=false, updated_at=now()"
    + " WHERE tenant_id=$1 AND id=$2" + scope.frag + " RETURNING id",
    [DEFAULT_TENANT, fileId, ...scope.extra] as never[],
  ));
  // Python 侧用 asyncpg 状态串尾数判 0；TS 用 RETURNING id 行数（等价语义）
  if ((rows as unknown as Row[]).length === 0) {
    throw httpError(404, { error: "not_found", code: "FILE_NOT_FOUND" });
  }
  return c.body(null, 204);
}));

// GET /api/v1/file-objects/{file_id}/render-content（ws_files.py:977；令牌即授权）
app.get("/api/v1/file-objects/:file_id/render-content", (c) => respond(c, async () => {
  const fileId = Number(c.req.param("file_id"));
  const token = c.req.query("t") ?? "";
  const env = getEnv(c);
  const ok = await verifyAssetToken(env.JWT_SECRET ?? "", "file", fileId, token);
  if (!ok) {
    throw httpError(401, {
      error: "unauthorized", code: "RENDER_TOKEN_INVALID", message: "渲染资源令牌无效或已过期",
    });
  }
  const rows = await withDb(env, (sql: Db) => sql.unsafe(
    "SELECT content_type, file_name, content, object_key, storage FROM file_objects"
    + " WHERE tenant_id=$1 AND id=$2 AND is_current",
    [DEFAULT_TENANT, fileId] as never[],
  ));
  const row = (rows as unknown as Row[])[0];
  if (!row) {
    throw httpError(404, { error: "not_found", code: "FILE_NOT_FOUND" });
  }
  const data = await loadBytes(env, row);
  if (data === null) {
    throw httpError(404, { error: "not_found", code: "FILE_BODY_NOT_FOUND" });
  }
  return c.body(data.buffer as ArrayBuffer, 200, {
    "Content-Type": (row.content_type as string) || "application/octet-stream",
    "Cache-Control": "private, max-age=" + String(ASSET_TTL_SECONDS),
    "Content-Disposition": 'inline; filename="file-' + String(fileId) + '"',
  });
}));

// GET /api/v1/file-objects/{file_id}/content（ws_files.py:558；需登录 + 团队可见）
app.get("/api/v1/file-objects/:file_id/content", (c) => respond(c, async () => {
  const user = await requireUser(c);
  const fileId = Number(c.req.param("file_id"));
  const env = getEnv(c);
  const scope = teamScope(user, 3);
  const rows = await withDb(env, (sql: Db) => sql.unsafe(
    "SELECT content_type, file_name, content, object_key, storage FROM file_objects"
    + " WHERE tenant_id=$1 AND id=$2" + scope.frag,
    [DEFAULT_TENANT, fileId, ...scope.extra] as never[],
  ));
  const row = (rows as unknown as Row[])[0];
  if (!row) {
    throw httpError(404, { error: "not_found", code: "FILE_NOT_FOUND" });
  }
  const data = await loadBytes(env, row);
  if (data === null) {
    throw httpError(404, { error: "not_found", code: "FILE_BODY_NOT_FOUND" });
  }
  return c.body(data.buffer as ArrayBuffer, 200, {
    "Content-Type": (row.content_type as string) || "application/octet-stream",
    "Cache-Control": "private, max-age=3600",
  });
}));

// GET /api/v1/file-objects/{file_id}/url（ws_files.py:1111）
app.get("/api/v1/file-objects/:file_id/url", (c) => respond(c, async () => {
  const user = await requireUser(c);
  const fileId = Number(c.req.param("file_id"));
  const scope = teamScope(user, 3);
  const rows = await withDb(getEnv(c), (sql: Db) => sql.unsafe(
    "SELECT object_key, content_type, file_name FROM file_objects"
    + " WHERE tenant_id=$1 AND id=$2 AND is_current" + scope.frag,
    [DEFAULT_TENANT, fileId, ...scope.extra] as never[],
  ));
  const row = (rows as unknown as Row[])[0];
  if (!row) {
    throw httpError(404, { error: "not_found", code: "FILE_NOT_FOUND" });
  }
  // TODO(TODO:TS5)：无 SigV4 预签名 ⇒ 与 Python「未配 S3」分支同形状
  return c.json({ configured: false, reason: "该文件不在对象存储里（inline 或未上传）" });
}));

// ── 内部助手 ─────────────────────────────────────────────────────────────────

/** ws_files.py:1023 _validate_direct：上传规则 + sha256 64 位十六进制校验。 */
export function validateDirect(body: {
  owner_type: string; kind: string; media_kind?: string | null; name: string;
  content_type: string; size: number; sha256: string;
}): string {
  try {
    validateFileUpload({
      ownerType: body.owner_type,
      kind: body.kind,
      mediaKind: body.media_kind ?? null,
      name: body.name,
      contentType: body.content_type,
      size: body.size,
    });
  } catch (err) {
    if (err instanceof RuleError) fileRule422(err);
    throw err;
  }
  const sha = (body.sha256 ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha)) {
    throw httpError(422, {
      error: "validation", code: "SHA256_REQUIRED",
      detail: "直传必须先算好文件的 sha256（64 位十六进制）",
    });
  }
  return sha;
}

/** ws_files.py:281 _load_bytes：inline 优先 → R2 binding（S3 分支见文件头 TODO:TS5）。 */
export async function loadBytes(env: Env, row: Row): Promise<Uint8Array | null> {
  if (row.content !== null && row.content !== undefined) {
    const content = row.content as Uint8Array | ArrayBuffer | string;
    if (typeof content === "string") return new TextEncoder().encode(content);
    if (content instanceof ArrayBuffer) return new Uint8Array(content);
    return content;
  }
  if (!row.object_key) return null;
  const bucket = r2Bucket(env);
  if (bucket === null) return null;
  const obj = await bucket.get(String(row.object_key));
  if (obj === null) return null;
  return new Uint8Array(await obj.arrayBuffer());
}

/** HMAC-SHA256 十六进制（kaas_common/files/token.py:_sign 的逐行镜像）。 */
async function hmacHex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** verify_asset_token（token.py:58-78）：格式 / 过期 / 绑定 / 常量时间比较。 */
export async function verifyAssetToken(
  secret: string,
  purpose: string,
  refId: number | string,
  token: string,
  nowSeconds?: number,
): Promise<boolean> {
  if (!secret || !token || !token.includes(".")) return false;
  const parts = token.split(".");
  const expRaw = parts[0] as string;
  const sig = parts[1];
  if (sig === undefined) return false;
  const exp = Number(expRaw);
  if (!Number.isInteger(exp)) return false;
  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  if (exp < now) return false;
  const expected = await hmacHex(secret, purpose + ":" + String(refId) + ":" + String(exp));
  if (expected.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) {
    diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  }
  return diff === 0;
}

export { MEDIA_KIND_LABELS };
export default app;
