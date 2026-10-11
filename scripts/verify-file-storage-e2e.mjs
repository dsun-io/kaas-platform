#!/usr/bin/env node
/**
 * 生产文件存储端到端验收（唯一能证明「R2 真的接受了我们的预签名 URL」的手段）
 *
 * 为什么需要这个脚本
 * ------------------
 * 单元测试只能证明「我们算出的 SigV4 预签名与 minio-py 独立实现逐字符一致」，
 * 本地 stub S3 也不做服务端验签 —— 所以「生产 R2 会不会接受这个 URL」在**真上传之前
 * 谁都不能声称**。这个脚本做一次真上传，并把每一步的实际结果打出来。
 *
 * 它验证什么（逐步）
 * ------------------
 *   1. 登录拿 token（或直接用 --token）
 *   2. `POST /file-objects/presign` ⇒ `configured` 必须为 true（否则生产没读到 S3 配置）
 *   3. 用预签名 URL **PUT 真实字节**（带 Content-Type）
 *   4. `POST /file-objects/register` ⇒ 落库那一行的 `storage` **必须是 `s3`**
 *      （若是 `inline`，说明走了回退：字节其实进了数据库，不是对象存储）
 *   5. `GET /file-objects/{id}/url` 取预签名 GET ⇒ **真的把字节取回来并与本地文件逐字节比对**
 *      （这一步同时证明 R2 接受了我们的签名、且内容未损坏）
 *   6. `GET /products/{key}/media` ⇒ 新图出现在产品图库里
 *
 * 用法
 * ----
 *   node scripts/verify-file-storage-e2e.mjs \
 *     --api https://api.kaas.powervoy.com \
 *     --email you@example.com --password '***' \
 *     --product chain_link --file D:\tmp\test-photo.jpg \
 *     --name "冒烟测试图（可删）" --media-kind size \
 *     [--cleanup]
 *
 *   --token <jwt>     直接用现成 token（不想在命令行给密码时用；先从浏览器 localStorage 取）
 *   --cleanup         验证通过后把这张图下线（保留行档，不物理删）
 *
 * 退出码：全部 PASS ⇒ 0；任一步 FAIL ⇒ 1（可直接接进 CI 或人工验收清单）。
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const MAX_BYTES = 8 * 1024 * 1024; // 产品图上限（与内核 MAX_BYTES 一致）
const ALLOWED_IMAGE = new Set(["image/png", "image/jpeg", "image/webp"]);
const MIME_BY_EXT = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };

function parseArgs(argv) {
  const out = { mediaKind: "size", timeoutMs: 60000 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    if (key === "cleanup") { out.cleanup = true; continue; }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`参数 --${key} 缺少取值`);
    i += 1;
    if (key === "api") out.api = value;
    else if (key === "token") out.token = value;
    else if (key === "email") out.email = value;
    else if (key === "password") out.password = value;
    else if (key === "product") out.product = value;
    else if (key === "file") out.file = value;
    else if (key === "name") out.name = value;
    else if (key === "media-kind") out.mediaKind = value;
    else throw new Error(`未知参数 --${key}`);
  }
  return out;
}

const results = [];
function record(step, ok, detail) {
  results.push({ step, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}${detail ? ` — ${detail}` : ""}`);
}

async function request(url, options, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const api = (args.api || "https://api.kaas.powervoy.com").replace(/\/$/, "");
  if (!args.file) throw new Error("缺少 --file（要上传的真实图片路径）");
  if (!args.product) args.product = "chain_link";
  if (!args.name) args.name = `storage-e2e-${new Date().toISOString().slice(0, 19)}`;

  const bytes = await readFile(args.file);
  const ext = args.file.slice(args.file.lastIndexOf(".")).toLowerCase();
  const contentType = MIME_BY_EXT[ext];
  if (!contentType || !ALLOWED_IMAGE.has(contentType)) {
    throw new Error(`文件类型不在允许集内：${args.file}（只允许 png/jpg/webp）`);
  }
  if (bytes.length === 0 || bytes.length > MAX_BYTES) {
    throw new Error(`文件大小不合规：${bytes.length} 字节（上限 ${MAX_BYTES}）`);
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  console.log(`文件：${args.file}`);
  console.log(`大小/类型：${bytes.length} 字节 / ${contentType}`);
  console.log(`sha256：${sha256}`);
  console.log(`API：${api}\n`);

  // ① 取 token
  let token = args.token;
  if (!token) {
    if (!args.email || !args.password) throw new Error("需要 --token 或 --email/--password");
    const res = await request(`${api}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: args.email, password: args.password }),
    }, args.timeoutMs);
    const body = await res.json().catch(() => ({}));
    token = body.access_token;
    record("① 登录拿 token", res.ok && Boolean(token), `HTTP ${res.status}`);
    if (!token) throw new Error("登录未拿到 access_token");
  } else {
    record("① 使用提供的 token", true, "跳过登录");
  }
  const auth = { Authorization: `Bearer ${token}` };
  const meta = {
    owner_type: "product",
    owner_id: args.product,
    kind: "product_photo",
    media_kind: args.mediaKind,
    name: args.name,
    content_type: contentType,
    size: bytes.length,
    sha256,
    file_name: args.file.split(/[\\/]/).pop(),
  };

  // ② 预签名
  const presignRes = await request(`${api}/api/v1/file-objects/presign`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify(meta),
  }, args.timeoutMs);
  const presign = await presignRes.json().catch(() => ({}));
  record(
    "② 预签名 POST /file-objects/presign",
    presignRes.ok && presign.configured === true && Boolean(presign.upload_url),
    `HTTP ${presignRes.status} configured=${presign.configured}` +
      (presign.configured === false ? "（生产没读到 S3 配置 ⇒ 会走 binding/inline 回退）" : ""),
  );
  if (!presign.configured) {
    console.log("\n结论：生产未启用 S3 直传。请检查 Worker 的 S3_ENDPOINT / S3_ACCESS_KEY / S3_SECRET_KEY。");
    process.exit(1);
  }

  // ③ 直传字节
  const putRes = await request(presign.upload_url, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: bytes,
  }, args.timeoutMs);
  const putDetail = putRes.ok ? `HTTP ${putRes.status}` : `HTTP ${putRes.status} ${(await putRes.text().catch(() => "")).slice(0, 200)}`;
  record("③ PUT 心跳字节到对象存储（预签名）", putRes.ok, putDetail);
  if (!putRes.ok) {
    console.log("\n结论：对象存储拒绝了我们的预签名 PUT —— 检查密钥/桶名/region/时钟。");
    process.exit(1);
  }

  // ④ 登记元数据
  const regRes = await request(`${api}/api/v1/file-objects/register`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify(meta),
  }, args.timeoutMs);
  const row = await regRes.json().catch(() => ({}));
  const storageOk = row.storage === "s3";
  record(
    "④ 登记元数据（关键：storage 必须是 s3）",
    regRes.ok && storageOk && typeof row.id === "number",
    `HTTP ${regRes.status} storage=${row.storage} id=${row.id} version=${row.version}`,
  );
  if (!regRes.ok || typeof row.id !== "number") {
    console.log("\n结论：登记失败，无法继续。");
    process.exit(1);
  }
  if (!storageOk) {
    console.log(
      "\n结论：入库行的 storage 不是 s3 ⇒ 字节走的是回退路径（binding 或 inline），" +
      "对象存储那条路没生效（但功能没坏，文件仍可用）。",
    );
    process.exit(1);
  }

  // ⑤ 预签名 GET 取回并逐字节比对（最强的完整性证据）
  const urlRes = await request(`${api}/api/v1/file-objects/${row.id}/url`, { headers: auth }, args.timeoutMs);
  const urlBody = await urlRes.json().catch(() => ({}));
  record(
    "⑤ 取短时效直链 GET /file-objects/{id}/url",
    urlRes.ok && urlBody.configured === true && Boolean(urlBody.url),
    `HTTP ${urlRes.status} expires_in=${urlBody.expires_in}`,
  );
  if (urlBody.url) {
    const getRes = await request(urlBody.url, { method: "GET" }, args.timeoutMs);
    const back = Buffer.from(await getRes.arrayBuffer());
    const same = back.length === bytes.length && createHash("sha256").update(back).digest("hex") === sha256;
    record("⑤b 直链取回并与本地文件逐字节比对", getRes.ok && same,
      `HTTP ${getRes.status} 取回 ${back.length} 字节 sha256匹配=${same}`);
  } else {
    record("⑤b 直链取回", false, "没有拿到直链");
  }

  // ⑥ 产品图库能看到
  const mediaRes = await request(`${api}/api/v1/products/${args.product}/media`, { headers: auth }, args.timeoutMs);
  const media = await mediaRes.json().catch(() => ({}));
  const found = Array.isArray(media.items) && media.items.some((m) => m.id === row.id);
  record("⑥ 产品图库里能看到这张图", mediaRes.ok && found, `HTTP ${mediaRes.status} 命中=${found}`);

  if (args.cleanup) {
    const delRes = await request(`${api}/api/v1/file-objects/${row.id}`, { method: "DELETE", headers: auth }, args.timeoutMs);
    record("⑦ 清理（下线该图，行档保留）", delRes.status === 204, `HTTP ${delRes.status}`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n总计 ${results.length} 步，失败 ${failed.length} 步。`);
  if (failed.length === 0) {
    console.log("结论：生产对象存储链路**已实测打通**（预签名 PUT 被接受、storage=s3、直链取回内容一致）。");
    process.exit(0);
  }
  console.log("结论：存在失败步骤，见上。");
  process.exit(1);
}

main().catch((err) => {
  console.error(`\n脚本异常：${err?.message || err}`);
  process.exit(2);
});
